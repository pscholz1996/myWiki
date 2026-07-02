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
  readAiSourceFull,
  readAiSourcePage,
  searchAiKnowledgeBase,
  verifyAiCitation,
} from "@/lib/ai/knowledge-base";
import { TEXT_EXTS } from "@/lib/fs/project-dir";
import { resolveInProject } from "@/lib/fs/sandbox";
import { echo } from "@/lib/fs/watcher";
import type { AiChatRequest, AiConversation } from "@/lib/ai/types";

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

function serializePrompt(
  conversation: AiConversation,
  request: AiChatRequest,
): string {
  const lines = [
    "You are the OpenLatex AI assistant for scientific writing.",
    "Follow these rules:",
    "- Use the OpenLatex tools to search the knowledge base, read original sources, verify exact quotes, and edit project files.",
    "- Never state a source-backed fact unless it has been verified against the original source text.",
    "- When you make a claim from a source, first search the KB, then verify the exact quote on the page with cite().",
    "- Prefer concise answers with explicit citations and page numbers.",
    "- If a quote cannot be verified, say so and keep searching instead of guessing.",
    `Intent: ${request.intent ?? conversation.intent}`,
    `Conversation title: ${conversation.title}`,
    request.sourceIds && request.sourceIds.length > 0
      ? `Selected sources: ${request.sourceIds.join(", ")}`
      : "Selected sources: all available sources",
    "",
    "User request:",
    request.message,
  ];

  return lines.join("\n");
}

function normalizeToolResult(value: unknown): CallToolResult {
  return callResult(value);
}

function getProjectTextPath(absPath: string): string {
  return absPath.replace(/\\/g, "/");
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

export function createOpenLatexMcpServer(projectDir: string) {
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
          const hits = await searchAiKnowledgeBase(
            projectDir,
            args.query,
            args.topK ?? 5,
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
        "Overwrite a text file in the current OpenLatex project.",
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
) {
  const prompt = serializePrompt(conversation, request);
  const sessionId = conversation.sdkSessionId ?? conversation.id;

  const q = query({
    prompt,
    options: {
      cwd: projectDir,
      sessionId,
      persistSession: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: [],
      mcpServers: {
        openlatex: createOpenLatexMcpServer(projectDir),
      },
      includePartialMessages: true,
      maxTurns: 8,
      model: request.model ?? conversation.model ?? "sonnet",
    },
  });

  for await (const message of q) {
    yield message;
  }
}
