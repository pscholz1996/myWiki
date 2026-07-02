import fs from "node:fs/promises";
import path from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  deleteAiSource,
  getAiSourceRecord,
  listAiSources,
  normalizeWhitespace,
  readAiSourceFull,
  readAiSourcePage,
  searchAiKnowledgeBase,
  setAiSourceBibKey,
  verifyAiCitation,
} from "@/lib/ai/knowledge-base";
import { listProjectTree, type FsNode } from "@/lib/fs/list";
import { TEXT_EXTS } from "@/lib/fs/project-dir";
import { resolveInProject } from "@/lib/fs/sandbox";
import { echo } from "@/lib/fs/watcher";
import type { AiChatRequest, AiConversation, AiIntent } from "@/lib/ai/types";

function callResult(text: unknown, isError = false): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          typeof text === "string"
            ? text
            : `${JSON.stringify(text, null, 2)}\n`,
      },
    ],
    isError,
  } as CallToolResult;
}

/**
 * Sources cited earlier in this conversation that no longer exist in the
 * current knowledge base (e.g. the user deleted them because they turned
 * out to be wrong or irrelevant). A prior verified cite() does not remain
 * valid after deletion — the model must be told explicitly, by name, or it
 * will restate the fact from its own conversational memory of the earlier
 * tool result without re-verifying (confirmed by testing: it will even
 * claim "(verified)" in prose despite calling no tool this turn).
 */
export function findStaleCitedSourceIds(
  conversation: AiConversation,
  currentSourceIds: Set<string>,
): string[] {
  const citedSourceIds = new Set<string>();
  for (const message of conversation.messages) {
    for (const citation of message.citations ?? []) {
      citedSourceIds.add(citation.sourceId);
    }
  }
  return [...citedSourceIds].filter((id) => !currentSourceIds.has(id));
}

// Intent only used to be an informational label in the prompt ("Intent:
// research") — it didn't change how the model actually behaved. These give
// each mode a distinct default posture without restricting which tools are
// available (the model can still search, cite, or edit regardless of
// intent; this just changes what it should reach for first).
const INTENT_GUIDANCE: Record<AiIntent, string> = {
  research:
    "- Current intent is Research: focus on searching the knowledge base and synthesizing what the sources say. Verify every factual claim with cite() before stating it. Don't edit project files unless the user explicitly asks you to.",
  write:
    "- Current intent is Write: focus on drafting or revising prose directly in the project's .tex files with read_project_file/replace_in_project_file. Any source-backed claim you add still needs a cite()-verified quote before it goes in the text.",
  organize:
    "- Current intent is Organize: focus on the project's structure — file layout, section order, references — over long-form writing or literature search. Prefer targeted replace_in_project_file changes and explain structural suggestions before making large changes.",
};

async function serializePrompt(
  projectDir: string,
  conversation: AiConversation,
  request: AiChatRequest,
): Promise<string> {
  const manifest = await listAiSources(projectDir);
  const currentSourceIds = new Set(manifest.sources.map((source) => source.id));
  const staleSourceIds = findStaleCitedSourceIds(conversation, currentSourceIds);
  const intent = request.intent ?? conversation.intent;

  const lines = [
    "You are the OpenLatex AI assistant for scientific writing.",
    "Follow these rules:",
    "- Use the OpenLatex tools to search the knowledge base, read original sources, verify exact quotes, and edit project files.",
    "- If you don't already know the project's file layout (or need to find where something lives), call list_project_files first instead of guessing paths.",
    "- When changing part of an existing file, use replace_in_project_file, not edit_project_file — it only resends the part that changes instead of the whole file. Reserve edit_project_file for new files or a genuine full rewrite.",
    "- Never state a source-backed fact unless it has been verified against the original source text.",
    "- When you make a claim from a source, first search the KB, then verify the exact quote on the page with cite().",
    "- Prefer concise answers with explicit citations and page numbers.",
    "- If a quote cannot be verified, say so and keep searching instead of guessing.",
    "- A citation you made earlier in THIS conversation is not automatically still valid. Sources can be deleted mid-conversation. Before restating, confirming, repeating, or relying on any earlier citation — even one you already verified — you MUST call cite() again in this turn. Never describe something as \"verified\" unless cite() succeeded in this exact turn.",
    "- When you're adding a source-backed sentence into the .tex text itself (not just discussing it in chat), a chat citation chip isn't enough: after cite() succeeds, call ensure_bibtex_entry to get a real cite key, then insert \\cite{key} at that spot with replace_in_project_file.",
    staleSourceIds.length > 0
      ? `- The following source IDs were cited earlier in this conversation but have since been permanently REMOVED from the knowledge base: ${staleSourceIds.join(", ")}. Do not restate, confirm, or rely on anything from them. If asked, say the source was removed from the knowledge base and that information can no longer be verified.`
      : null,
    INTENT_GUIDANCE[intent],
    `Intent: ${intent}`,
    `Conversation title: ${conversation.title}`,
    request.sourceIds && request.sourceIds.length > 0
      ? `Selected sources: ${request.sourceIds.join(", ")}`
      : "Selected sources: all available sources",
    "",
    "User request:",
    request.message,
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

function normalizeToolResult(value: unknown): CallToolResult {
  return callResult(value);
}

function getProjectTextPath(absPath: string): string {
  return absPath.replace(/\\/g, "/");
}

// A nested FsNode tree costs extra tokens re-stating "type"/"children" at
// every level for what the model really wants: a flat list of paths it can
// pass straight to read_project_file/edit_project_file. Directories aren't
// listed themselves since they're never a valid argument to those tools.
function flattenProjectTree(nodes: FsNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      paths.push(node.path);
    } else if (node.children) {
      paths.push(...flattenProjectTree(node.children));
    }
  }
  return paths;
}

async function readProjectTextFile(
  projectDir: string,
  userPath: string,
): Promise<CallToolResult> {
  const absPath = resolveInProject(projectDir, userPath);
  const ext = path.extname(absPath).toLowerCase();

  if (!TEXT_EXTS.has(ext)) {
    return callResult(
      { error: "Only text files can be read with this tool" },
      true,
    );
  }

  const content = await fs.readFile(absPath, "utf8");
  return callResult({
    path: getProjectTextPath(absPath),
    content,
  });
}

async function editProjectTextFile(
  projectDir: string,
  userPath: string,
  content: string,
): Promise<CallToolResult> {
  const absPath = resolveInProject(projectDir, userPath);
  const ext = path.extname(absPath).toLowerCase();

  if (!TEXT_EXTS.has(ext)) {
    return callResult(
      { error: "Only text files can be written with this tool" },
      true,
    );
  }

  await fs.mkdir(path.dirname(absPath), { recursive: true });
  echo.recordWrite(absPath);
  await fs.writeFile(absPath, content, "utf8");

  const stat = await fs.stat(absPath);
  return callResult({
    path: getProjectTextPath(absPath),
    mtime: stat.mtimeMs,
  });
}

export type ExactReplaceResult =
  | { content: string }
  | { error: string };

// oldText must match the file's current content exactly once, so the model
// has to prove it read the real text (via read_project_file) rather than
// guessing, and the resulting diff is exactly as big as the actual change —
// no ambiguity about which occurrence was meant, no silent edit of the
// wrong spot.
export function applyExactReplace(
  content: string,
  oldText: string,
  newText: string,
): ExactReplaceResult {
  const occurrences = content.split(oldText).length - 1;

  if (occurrences === 0) {
    return {
      error:
        "old_text not found in the file. It must match the file's current exact text, including whitespace and line breaks — call read_project_file first and copy the exact snippet.",
    };
  }

  if (occurrences > 1) {
    return {
      error: `old_text matches ${occurrences} places in the file. Include more surrounding context so it matches exactly once.`,
    };
  }

  // Function-form replacement avoids String.replace's special "$&"/"$1"
  // substitution patterns in newText — LaTeX content is full of literal
  // "$" (math mode), which would otherwise be misinterpreted.
  return { content: content.replace(oldText, () => newText) };
}

// A full-file overwrite means resending an entire chapter (easily 10+ pages
// on a thesis-scale project) to change one sentence — expensive in tokens
// and a large blast radius for a small change. This does a literal
// find-and-replace instead (see applyExactReplace).
async function replaceInProjectTextFile(
  projectDir: string,
  userPath: string,
  oldText: string,
  newText: string,
): Promise<CallToolResult> {
  const absPath = resolveInProject(projectDir, userPath);
  const ext = path.extname(absPath).toLowerCase();

  if (!TEXT_EXTS.has(ext)) {
    return callResult(
      { error: "Only text files can be edited with this tool" },
      true,
    );
  }

  const content = await fs.readFile(absPath, "utf8");
  const result = applyExactReplace(content, oldText, newText);

  if ("error" in result) {
    return callResult({ error: result.error }, true);
  }

  echo.recordWrite(absPath);
  await fs.writeFile(absPath, result.content, "utf8");

  const stat = await fs.stat(absPath);
  return callResult({
    path: getProjectTextPath(absPath),
    mtime: stat.mtimeMs,
  });
}

export const BIBTEX_ENTRY_TYPES = [
  "article",
  "inproceedings",
  "incollection",
  "inbook",
  "book",
  "proceedings",
  "techreport",
  "phdthesis",
  "mastersthesis",
  "online",
  "misc",
] as const;

const BIBTEX_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]*$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatBibtexEntry(
  entryType: string,
  key: string,
  fields: Record<string, string>,
): string {
  const fieldLines = Object.entries(fields)
    .filter(([, value]) => value.trim().length > 0)
    .map(([name, value]) => `  ${name} = {${value.trim()}},`)
    .join("\n");
  return `@${entryType}{${key},\n${fieldLines}\n}\n`;
}

// Matches "@type{key," (case-insensitive, tolerant of whitespace) so a
// duplicate-key check doesn't miss an existing entry, or false-positive on
// a key that's merely a prefix of another (e.g. "smith2020" vs
// "smith2020b").
export function bibtexHasKey(bibContent: string, key: string): boolean {
  const pattern = new RegExp(`@[A-Za-z]+\\s*\\{\\s*${escapeRegExp(key)}\\s*,`, "i");
  return pattern.test(bibContent);
}

// Ties a knowledge-base source to a BibTeX entry so \cite{key} in the .tex
// text points at a real, findable reference instead of the citation living
// only as an informal "source · page" chip in the chat panel. Idempotent
// per source (see AiSourceRecord.bibKey) so re-citing the same paper across
// a conversation doesn't append duplicate .bib entries.
async function ensureBibtexEntry(
  projectDir: string,
  args: {
    sourceId: string;
    bibFile?: string;
    entryType: string;
    key: string;
    fields: Record<string, string>;
  },
): Promise<CallToolResult> {
  if (!BIBTEX_KEY_PATTERN.test(args.key)) {
    return callResult(
      {
        error:
          "key must start with a letter and contain only letters, digits, ':', '_' or '-' (standard BibTeX cite-key syntax).",
      },
      true,
    );
  }

  const source = await getAiSourceRecord(projectDir, args.sourceId);
  if (!source) {
    return callResult({ error: "Source not found" }, true);
  }

  if (source.bibKey) {
    return normalizeToolResult({ key: source.bibKey, reused: true });
  }

  const tree = await listProjectTree(projectDir);
  const bibFiles = flattenProjectTree(tree).filter((p) =>
    p.toLowerCase().endsWith(".bib"),
  );

  let targetBibFile = args.bibFile;
  if (!targetBibFile) {
    if (bibFiles.length === 1) {
      targetBibFile = bibFiles[0];
    } else if (bibFiles.length === 0) {
      return callResult(
        {
          error:
            'No .bib file found in the project. Pass bib_file with a path to create one (e.g. "references.bib").',
        },
        true,
      );
    } else {
      return callResult(
        {
          error: `Multiple .bib files found in the project — pass bib_file to pick one: ${bibFiles.join(", ")}`,
        },
        true,
      );
    }
  }

  const absBibPath = resolveInProject(projectDir, targetBibFile);
  if (path.extname(absBibPath).toLowerCase() !== ".bib") {
    return callResult({ error: "bib_file must be a .bib file" }, true);
  }

  let existingContent = "";
  try {
    existingContent = await fs.readFile(absBibPath, "utf8");
  } catch {
    // File doesn't exist yet — it will be created below.
  }

  if (bibtexHasKey(existingContent, args.key)) {
    return callResult(
      {
        error: `Key "${args.key}" already exists in ${targetBibFile}. Pick a different, more specific key.`,
      },
      true,
    );
  }

  // Best-effort sanity check, not a hard verification gate like cite() —
  // BibTeX metadata (author lists, exact year) can't be checked with the
  // same certainty as an exact quote. Still worth flagging when the title
  // doesn't even loosely match the source's own first page.
  let titleVerified: boolean | null = null;
  if (args.fields.title) {
    try {
      const { text } = await readAiSourcePage(projectDir, args.sourceId, 1);
      titleVerified = normalizeWhitespace(text)
        .toLowerCase()
        .includes(normalizeWhitespace(args.fields.title).toLowerCase());
    } catch {
      titleVerified = null;
    }
  }

  const entry = formatBibtexEntry(args.entryType, args.key, args.fields);
  const nextContent =
    existingContent.trim().length > 0
      ? `${existingContent.trimEnd()}\n\n${entry}`
      : entry;

  await fs.mkdir(path.dirname(absBibPath), { recursive: true });
  echo.recordWrite(absBibPath);
  await fs.writeFile(absBibPath, nextContent, "utf8");

  await setAiSourceBibKey(projectDir, args.sourceId, args.key);

  return normalizeToolResult({
    key: args.key,
    bibFile: targetBibFile,
    reused: false,
    titleVerified,
  });
}

export function createOpenLatexMcpServer(
  projectDir: string,
  scopedSourceIds?: string[],
) {
  return createSdkMcpServer({
    name: "openlatex",
    version: "0.1.0",
    alwaysLoad: true,
    tools: [
      tool(
        "search_knowledge_base",
        "Search indexed project knowledge sources for relevant chunks.",
        {
          query: z.string(),
          topK: z.number().int().min(1).max(10).optional(),
        },
        async (args) => {
          // scopedSourceIds is ambient (set by the conversation's selected
          // sources, not by the model) — a hard restriction the model
          // cannot widen by omitting it from the call.
          const hits = await searchAiKnowledgeBase(
            projectDir,
            args.query,
            args.topK ?? 5,
            scopedSourceIds,
          );
          return normalizeToolResult({ hits });
        },
      ),
      tool(
        "read_source_page",
        "Read the verified text from a specific source page.",
        {
          sourceId: z.string(),
          page: z.number().int().min(1),
        },
        async (args) => {
          try {
            const result = await readAiSourcePage(
              projectDir,
              args.sourceId,
              args.page,
            );
            return normalizeToolResult(result);
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to read source page",
              true,
            );
          }
        },
      ),
      tool(
        "read_source_full",
        "Read the full extracted text for a source.",
        {
          sourceId: z.string(),
        },
        async (args) => {
          try {
            const result = await readAiSourceFull(projectDir, args.sourceId);
            return normalizeToolResult(result);
          } catch (error) {
            return callResult(
              error instanceof Error ? error.message : "Failed to read source",
              true,
            );
          }
        },
      ),
      tool(
        "cite",
        "Verify that an exact quote appears on the requested source page.",
        {
          sourceId: z.string(),
          page: z.number().int().min(1),
          quote: z.string(),
        },
        async (args) => {
          try {
            const result = await verifyAiCitation({
              projectDir,
              sourceId: args.sourceId,
              page: args.page,
              quote: args.quote,
            });
            return normalizeToolResult(result);
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Citation verification failed",
              true,
            );
          }
        },
      ),
      tool(
        "ensure_bibtex_entry",
        "Find or create a BibTeX entry in the project's .bib file for a knowledge-base source, and link them so repeated calls for the same source are idempotent. Returns the cite key — insert \\cite{key} into the .tex text yourself with replace_in_project_file. Only pass fields you can actually support from the source's own text (e.g. its title page); this is bibliographic bookkeeping, not a place to invent author/year details.",
        {
          source_id: z.string(),
          bib_file: z
            .string()
            .optional()
            .describe(
              "Path to the .bib file to use, e.g. \"references.bib\". Required when the project has more than one .bib file; optional otherwise.",
            ),
          entry_type: z.enum(BIBTEX_ENTRY_TYPES),
          key: z
            .string()
            .describe(
              "BibTeX cite key, e.g. \"brown2025mbse\" — letters/digits/':'/'_'/'-' only.",
            ),
          fields: z
            .record(z.string(), z.string())
            .describe(
              "BibTeX fields, e.g. { author, title, year, journal } or { author, title, year, booktitle } depending on entry_type.",
            ),
        },
        async (args) => {
          try {
            return await ensureBibtexEntry(projectDir, {
              sourceId: args.source_id,
              bibFile: args.bib_file,
              entryType: args.entry_type,
              key: args.key,
              fields: args.fields,
            });
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to create BibTeX entry",
              true,
            );
          }
        },
      ),
      tool(
        "list_project_files",
        "List every text file path in the current OpenLatex project (e.g. chapters/intro.tex), so you know what exists before reading or editing.",
        {},
        async () => {
          try {
            const tree = await listProjectTree(projectDir);
            return normalizeToolResult({ paths: flattenProjectTree(tree) });
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to list project files",
              true,
            );
          }
        },
      ),
      tool(
        "read_project_file",
        "Read a text file from the current OpenLatex project.",
        {
          path: z.string(),
        },
        async (args) => {
          try {
            return await readProjectTextFile(projectDir, args.path);
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to read project file",
              true,
            );
          }
        },
      ),
      tool(
        "edit_project_file",
        "Overwrite a text file in the current OpenLatex project with entirely new content. Use only for creating a new file or a full rewrite — for a change to part of an existing file, use replace_in_project_file instead so you don't resend the whole file.",
        {
          path: z.string(),
          content: z.string(),
        },
        async (args) => {
          try {
            return await editProjectTextFile(
              projectDir,
              args.path,
              args.content,
            );
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to edit project file",
              true,
            );
          }
        },
      ),
      tool(
        "replace_in_project_file",
        "Make a targeted edit to an existing text file by replacing one exact snippet of its current content with new content, without resending the whole file. old_text must match the file's current content EXACTLY ONCE (read_project_file first to get the exact text/whitespace) — include enough surrounding context to make it unique. To insert new content, wrap it around a small anchor of unchanged text present in both old_text and new_text. To delete a snippet, pass an empty new_text.",
        {
          path: z.string(),
          old_text: z.string().min(1),
          new_text: z.string(),
        },
        async (args) => {
          try {
            return await replaceInProjectTextFile(
              projectDir,
              args.path,
              args.old_text,
              args.new_text,
            );
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to edit project file",
              true,
            );
          }
        },
      ),
      tool(
        "delete_knowledge_source",
        "Delete a knowledge source and rebuild the index.",
        {
          sourceId: z.string(),
        },
        async (args) => {
          try {
            const manifest = await deleteAiSource(projectDir, args.sourceId);
            return normalizeToolResult({
              sources: manifest.sources,
              index: manifest.index,
            });
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to delete source",
              true,
            );
          }
        },
      ),
    ],
  });
}

export async function* runOpenLatexChatTurn(
  projectDir: string,
  conversation: AiConversation,
  request: AiChatRequest,
  isNewSession: boolean,
) {
  const prompt = await serializePrompt(projectDir, conversation, request);
  const sessionId = conversation.sdkSessionId ?? conversation.id;

  // `sessionId` creates a session under a caller-chosen id and is only valid
  // on the first turn; resuming an existing session must use `resume`
  // instead (the SDK does not treat repeating `sessionId` as a resume — it
  // conflicts with the already-persisted session and crashes the CLI
  // process on turn 2+).
  const sessionOptions = isNewSession
    ? { sessionId }
    : { resume: sessionId };

  const q = query({
    prompt,
    options: {
      cwd: projectDir,
      ...sessionOptions,
      persistSession: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: [],
      mcpServers: {
        openlatex: createOpenLatexMcpServer(projectDir, conversation.sourceIds),
      },
      includePartialMessages: true,
      maxTurns: 8,
      model: request.model ?? conversation.model ?? "claude-sonnet-5",
      // Long research conversations can exceed the context window. The SDK
      // (the same engine behind Claude Code) already knows how to compact
      // — summarize older turns and keep going — but that behavior lives
      // behind a settings flag rather than being unconditionally on, so
      // set it explicitly instead of relying on an ambient default we
      // don't control from here.
      settings: { autoCompactEnabled: true },
    },
  });

  for await (const message of q) {
    yield message;
  }
}
