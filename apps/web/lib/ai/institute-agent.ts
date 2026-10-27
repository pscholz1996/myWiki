import { z } from "zod";
import { findStaleCitedSourceIds } from "@/lib/ai/agent";
import {
  type ChatMessage,
  type ChatToolCall,
  type ChatToolSpec,
  resolveInstituteModel,
  streamInstituteChat,
} from "@/lib/ai/institute-llm";
import { listAiSources } from "@/lib/ai/knowledge-base";
import { createPlaceholderExpander } from "@/lib/ai/placeholder-expander";
import {
  createSourceRefExpander,
  parsePages,
  SOURCE_REF,
} from "@/lib/ai/source-ref-expander";
import { joinAssistantPart } from "@/lib/ai/stream-text";
import {
  citeAs,
  createMyWikiTools,
  type MyWikiTool,
  sourceLabel,
  TEXT_TOOL_NAMES,
} from "@/lib/ai/tools";
import type {
  AiChatRequest,
  AiCitation,
  AiConversation,
  AiSourceRecord,
  AiUsage,
} from "@/lib/ai/types";
import {
  createVisual,
  extractSourceFigure,
  type VisualResult,
} from "@/lib/ai/visual-specialist";

/**
 * One chat turn on the institute LLM.
 *
 * The model researches with the knowledge-base tools and writes the answer;
 * visual work goes to Claude through two delegation tools (see
 * visual-specialist.ts). Unlike the Claude Agent SDK, an OpenAI-compatible
 * server keeps no session: every turn sends the conversation so far, and
 * this loop runs the tool calls itself.
 */

export type InstituteTurnEvent =
  | { type: "text"; text: string }
  | { type: "citation"; citation: AiCitation }
  | { type: "usage"; usage: AiUsage; contextTokens: number }
  | { type: "model"; model: string }
  // One per tool call, after it ran. Not shown in the UI yet; it makes a
  // turn traceable from the outside (which tools, how long, which failed).
  | {
      type: "tool";
      name: string;
      ms: number;
      ok: boolean;
      /** Why it failed, when it did — "FAILED" alone diagnoses nothing. */
      detail?: string;
    };

// Backstop against a tool-call loop, not a budget: a thorough answer chains
// many searches and page reads (the Claude path needed 100 turns of slack
// for the same reason).
const MAX_STEPS = 40;

const MAX_OUTPUT_TOKENS = 16_384;

// A whole book from read_source_full can run to hundreds of thousands of
// characters. One tool result must not crowd the conversation out of the
// context window; the model can still read specific pages.
const MAX_TOOL_RESULT_CHARS = 80_000;

// ---------------------------------------------------------------------------
// Source references

/**
 * Short per-turn handles for sources ("Q1", "Q2") that the model writes as
 * "[Q1, S. 12]"; source-ref-expander.ts turns them back into full links.
 * See there for why the model isn't handed the links themselves.
 */
class SourceRefs {
  private readonly handles = new Map<string, string>();
  private readonly ids = new Map<string, string>();
  private sources = new Map<string, AiSourceRecord>();

  constructor(private readonly projectDir: string) {}

  /** Re-reads the manifest — a research note saved mid-turn is a new source. */
  async load(): Promise<void> {
    const { sources } = await listAiSources(this.projectDir);
    this.sources = new Map(sources.map((source) => [source.id, source]));
  }

  /**
   * "[Q1, S. 12]" for a primary source; undefined for a research note,
   * which is the model's own synthesis and never something to cite.
   */
  ref(sourceId: string, page: number | null): string | undefined {
    const source = this.sources.get(sourceId);
    if (!source || source.kind === "note") return undefined;
    let handle = this.handles.get(sourceId);
    if (!handle) {
      handle = `Q${this.handles.size + 1}`;
      this.handles.set(sourceId, handle);
      this.ids.set(handle, sourceId);
    }
    return page == null ? `[${handle}]` : `[${handle}, S. ${page}]`;
  }

  link(
    handle: string,
    page: number | null,
    pages: string | undefined,
  ): string | undefined {
    const source = this.sources.get(this.ids.get(handle) ?? "");
    return source ? citeAs(source, page, pages) : undefined;
  }

  /** For text that leaves the turn without the expander (to Claude): readable names. */
  toPlain(text: string): string {
    return text.replace(
      new RegExp(SOURCE_REF.source, "gi"),
      (whole, handle: string, spec?: string) => {
        const source = this.sources.get(
          this.ids.get(handle.toUpperCase()) ?? "",
        );
        if (!source) return whole;
        const { page, pages } = parsePages(spec);
        return sourceLabel(source, page, pages);
      },
    );
  }

  /** Swaps the ready-made links in a tool result for short references. */
  shorten(name: string, text: string, args: Record<string, unknown>): string {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text;
    }
    if (name === "search_knowledge_base" && Array.isArray(parsed.hits)) {
      for (const hit of parsed.hits as Array<Record<string, unknown>>) {
        const chunk = hit.chunk as { sourceId: string; page?: number | null };
        hit.cite_as = this.ref(chunk.sourceId, chunk.page ?? null);
      }
    } else if (name === "read_source_page") {
      parsed.cite_as = this.ref(String(args.sourceId), Number(args.page));
    } else if (
      name === "browse_knowledge_base" &&
      Array.isArray(parsed.sources)
    ) {
      for (const entry of parsed.sources as Array<Record<string, unknown>>) {
        entry.cite_as = this.ref(String(entry.id), null);
      }
    } else {
      return text;
    }
    return JSON.stringify(parsed, null, 2);
  }
}

// ---------------------------------------------------------------------------
// Stop button

const globalForTurns = globalThis as unknown as {
  __mywikiInstituteTurns?: Map<string, AbortController>;
  __mywikiInstituteStopped?: Set<string>;
};
const runningTurns = (globalForTurns.__mywikiInstituteTurns ??= new Map());
const stoppedTurns = (globalForTurns.__mywikiInstituteStopped ??= new Set());

function turnKey(projectDir: string, conversationId: string): string {
  return `${projectDir}::${conversationId}`;
}

/** The stop button. Returns false when no turn was running. */
export function interruptInstituteTurn(
  projectDir: string,
  conversationId: string,
): boolean {
  const key = turnKey(projectDir, conversationId);
  const controller = runningTurns.get(key);
  if (!controller) return false;
  stoppedTurns.add(key);
  controller.abort();
  return true;
}

/** Whether the turn that just ended was stopped by the user (read once). */
export function consumeInstituteInterrupt(
  projectDir: string,
  conversationId: string,
): boolean {
  return stoppedTurns.delete(turnKey(projectDir, conversationId));
}

// ---------------------------------------------------------------------------
// Prompt

async function buildSystemPrompt(
  projectDir: string,
  conversation: AiConversation,
  request: AiChatRequest,
): Promise<string> {
  const manifest = await listAiSources(projectDir);
  const staleSourceIds = findStaleCitedSourceIds(
    conversation,
    new Set(manifest.sources.map((source) => source.id)),
  );

  return [
    "You are myWiki — a personal knowledge assistant answering questions from the user's own library (systems engineering, AI research, standards/norms, books, papers, slides) plus your general knowledge.",
    "",
    "## Answering",
    "- Your job is knowledge, not writing: give the clearest, most correct answer to the question. You never draft documents.",
    "- Answer in the language of the question: a German question gets a German answer, an English question an English one. Keep source terminology as-is (e.g. a norm's defined German/English terms) where translating would change meaning.",
    '- Everything you write is shown to the user as one continuous answer — so never narrate your process ("searching now…", "found it, next I\'ll…"). Work silently through tool calls and write only the polished answer itself.',
    "- Research before you answer. For any substantive question, follow these steps — one search is enough only for a narrow factual lookup:",
    "  1. Run at least three searches with different phrasings: the question's own words, synonyms or related terms, and the English equivalents (most sources are English even when the question is German).",
    "  2. When a hit points to the page that holds the core of the answer (a list, a table, a definition), read that page with read_source_page — a chunk is an excerpt and may cut the list off.",
    "  3. Only then answer, synthesizing across every relevant source. If two sources disagree or one is more specific, say so.",
    "- Never claim a source does not mention something unless you searched for exactly that and found nothing.",
    '- Where the sources don\'t cover something, answer from general knowledge — but make the boundary visible, e.g. a short "(general knowledge — not in your sources)". Never blur what came from the library and what came from you.',
    "- If neither the sources nor your general knowledge support a confident answer, say so plainly.",
    "",
    "## Tables and formulas",
    "- Use a GFM markdown table for comparisons, trade-offs, parameter lists, requirement matrices, or anything naturally tabular.",
    "- Use LaTeX math ($inline$ or $$display$$) for every equation or formal definition — never ASCII-art math.",
    "",
    "## Visuals — delegated, never drawn by you",
    "You do not draw anything yourself: never write ```mermaid blocks, SVG, ASCII diagrams or image markdown of your own. Two tools hand visual work to a specialist:",
    "- create_visual — call it whenever the answer explains how several parts fit together: a structure, a process or chain, an architecture, a comparison, a timeline, how concepts relate — and always when the user asks to see or grasp something at a glance. A table does not replace it; a table lists, a visual shows relations. Skip it only for simple factual questions. Pass the knowledge it must rest on — the relevant facts with their [Q…] references, in full sentences; the specialist sees nothing else — and what it should make clear. The specialist may decide a visual wouldn't help — then just answer in text.",
    '- show_source_figure — when a source contains the actual figure (hits mentioning "Figure/Abbildung/Bild X", captions, diagram slides): the original beats a redrawing. Give the source id, the page or slide, and what the figure shows.',
    "- Order matters: finish your research, request the visuals, and write the answer only AFTER their results are back. Each result gives you a placeholder of the form {{visual:…}}; put the one you received on its own line exactly where the visual belongs — it is replaced by the image there. Never write a placeholder you haven't received yet, and never mention that a visual was requested or is being made.",
    '- Refer to a visual naturally ("the diagram below shows…"). If the specialist made none, just answer in text.',
    "",
    "## Sources & attribution",
    "- The user must always see where knowledge came from and be able to jump into the source.",
    "- Source references: whenever a claim, number or finding comes from a specific source, follow it with that source's reference. Every search hit and every read_source_page result carries it as `cite_as`, e.g. [Q1, S. 12] — write exactly that, with the page you used. It becomes a clickable label with the source's name. Never write source names, ids or links yourself, and never a plain-text reference like (Poulsen 2025).",
    "- For pivotal or surprising source-backed claims, verify the exact quote with cite() so the answer carries a verified source chip. Routine background claims don't each need a cite().",
    "- If a quote cannot be verified, say so and keep searching instead of guessing.",
    "- A citation made earlier in THIS conversation is not automatically still valid (sources can be deleted) — re-verify with cite() before restating it as verified, silently.",
    '- Search results may include research notes you saved earlier (kind "note"). A note is your own prior synthesis — context, never a primary source; cite() refuses to verify against it. When a broad multi-source search produces a genuinely new synthesis worth keeping, save it with save_research_note.',
    "- If a source's stored title/authors looks wrong against the page text, point it out and ask; only call update_source_metadata after the user explicitly confirms.",
    staleSourceIds.length > 0
      ? `- These source IDs were cited earlier in this conversation but have since been REMOVED from the knowledge base: ${staleSourceIds.join(", ")}. Do not restate or rely on anything from them; if asked, say the source was removed and the information can no longer be verified.`
      : null,
    "",
    request.sourceIds && request.sourceIds.length > 0
      ? `The user restricted this conversation to these sources: ${request.sourceIds.join(", ")}.`
      : "All sources in the library are available.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** Rough token estimate; good enough to keep history inside the window. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Earlier turns of the conversation, newest kept first when trimming.
 *
 * Only the user's questions and the final answers are replayed — not the
 * tool calls in between. The answers carry their findings and source links,
 * which is what a follow-up question builds on; replaying every retrieved
 * chunk would fill the window with material the model can search again.
 */
function historyMessages(
  conversation: AiConversation,
  budgetTokens: number,
): ChatMessage[] {
  // The route appends the current question before the turn starts; it is
  // sent separately, after the history.
  const earlier = conversation.messages.slice(0, -1);
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    const message = earlier[index];
    if (!message.content.trim()) continue;
    const cost = estimateTokens(message.content);
    if (used + cost > budgetTokens) break;
    used += cost;
    kept.unshift(
      message.role === "user"
        ? { role: "user", content: message.content }
        : { role: "assistant", content: message.content },
    );
  }
  // A history that starts with an answer reads as if the model spoke first.
  while (kept[0]?.role === "assistant") kept.shift();
  return kept;
}

// ---------------------------------------------------------------------------
// Tools

function jsonSchemaOf(shape: z.ZodRawShape): Record<string, unknown> {
  // vLLM only needs the schema itself; the dialect marker is noise to it.
  const { $schema: _dialect, ...schema } = z.toJSONSchema(
    z.object(shape),
  ) as Record<string, unknown>;
  return schema;
}

function toToolSpec(tool: MyWikiTool): ChatToolSpec {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: jsonSchemaOf(tool.shape),
    },
  };
}

const FIGURE_SHAPE = {
  source_id: z.string(),
  page: z.number().int().min(1).optional().describe("PDF page number."),
  slide: z.number().int().min(1).optional().describe("PPTX slide number."),
  figure: z
    .string()
    .min(3)
    .describe(
      'What the figure shows, e.g. "the Pert chart of the work packages".',
    ),
  annotate: z
    .string()
    .optional()
    .describe(
      'Optional marking, e.g. "circle WP3". Only when it helps the explanation.',
    ),
};

const VISUAL_SHAPE = {
  purpose: z
    .string()
    .min(5)
    .describe("What the visual should make clear to the user."),
  knowledge: z
    .string()
    .min(20)
    .describe(
      "The facts the visual must rest on, with their source labels, in full sentences. The specialist sees nothing else.",
    ),
  based_on: z
    .string()
    .optional()
    .describe(
      'Short names of the sources used, e.g. "AIMPERES proposal, p. 12".',
    ),
};

const DELEGATION_TOOLS: ChatToolSpec[] = [
  {
    type: "function",
    function: {
      name: "show_source_figure",
      description:
        "Show an original figure from a source (PDF page or PPTX slide), cleanly cut out and optionally marked. Returns a placeholder to put in your answer.",
      parameters: jsonSchemaOf(FIGURE_SHAPE),
    },
  },
  {
    type: "function",
    function: {
      name: "create_visual",
      description:
        "Have the visual specialist explain knowledge as a picture — diagram, schematic, comparison, timeline or chart, whatever teaches it best. Returns a placeholder to put in your answer, or says why a visual would not help.",
      parameters: jsonSchemaOf(VISUAL_SHAPE),
    },
  },
];

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[… truncated: ${text.length - MAX_TOOL_RESULT_CHARS} more characters. Read specific pages with read_source_page instead.]`;
}

function resultText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Whether a tool result reports success: no `error`, and a visual was made. */
/** Why a tool call failed, or undefined if it succeeded. */
function toolFailure(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return undefined;
    if ("error" in parsed) {
      return String(
        typeof parsed.error === "string"
          ? parsed.error
          : JSON.stringify(parsed.error),
      ).slice(0, 200);
    }
    if (parsed.visual === null) return String(parsed.reason ?? "no visual");
    return undefined;
  } catch {
    return undefined; // plain text results (page text, digests) are successes
  }
}

function parseArguments(call: ChatToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments || "{}");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The turn

export async function* runInstituteChatTurn(
  projectDir: string,
  conversation: AiConversation,
  request: AiChatRequest,
): AsyncGenerator<InstituteTurnEvent> {
  const key = turnKey(projectDir, conversation.id);
  const controller = new AbortController();
  runningTurns.get(key)?.abort();
  runningTurns.set(key, controller);
  stoppedTurns.delete(key);
  const signal = controller.signal;

  try {
    const model = await resolveInstituteModel();
    yield { type: "model", model: model.id };

    const scope = conversation.sourceIds;
    const textTools = createMyWikiTools(projectDir, scope).filter((tool) =>
      (TEXT_TOOL_NAMES as readonly string[]).includes(tool.name),
    );
    const toolsByName = new Map(textTools.map((tool) => [tool.name, tool]));
    const toolSpecs = [...textTools.map(toToolSpec), ...DELEGATION_TOOLS];

    const systemPrompt = await buildSystemPrompt(
      projectDir,
      conversation,
      request,
    );
    const window = model.contextWindow ?? 131_072;
    // Half the window for replayed history leaves room for this turn's
    // retrieved chunks and the answer itself.
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...historyMessages(
        conversation,
        Math.floor(window / 2) - estimateTokens(systemPrompt),
      ),
      { role: "user", content: request.message },
    ];

    // Per turn, never module-wide: two conversations answering at once
    // must not hand each other their source chips.
    const citations: AiCitation[] = [];
    const visuals = new Map<string, string>();
    const refs = new SourceRefs(projectDir);
    await refs.load();
    // Two stages: visual placeholders first, then short source references
    // in whatever text that releases.
    const placeholders = createPlaceholderExpander((id) => visuals.get(id));
    const sourceRefs = createSourceRefExpander((handle, page, pages) =>
      refs.link(handle, page, pages),
    );
    const expander = {
      push: (text: string) => sourceRefs.push(placeholders.push(text)),
      retry: () => sourceRefs.push(placeholders.retry()),
      flush: () => sourceRefs.push(placeholders.flush()) + sourceRefs.flush(),
      used: () => placeholders.used(),
    };
    let shown = "";
    const usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
    let contextTokens = 0;

    for (let step = 0; step < MAX_STEPS; step += 1) {
      let stepText = "";
      let calls: ChatToolCall[] = [];

      for await (const event of streamInstituteChat({
        model: model.id,
        messages,
        tools: toolSpecs,
        maxTokens: MAX_OUTPUT_TOKENS,
        signal,
      })) {
        if (event.type === "text") {
          // A new step's text is a new part of the answer: separate it from
          // the previous part like the Claude path did (stream-text.ts).
          const delta =
            stepText === ""
              ? joinAssistantPart(shown, event.delta)
              : event.delta;
          stepText += event.delta;
          const visible = expander.push(delta);
          if (visible) {
            shown += visible;
            yield { type: "text", text: visible };
          }
        } else if (event.type === "tool_calls") {
          calls = event.calls;
        } else if (event.type === "usage") {
          usage.inputTokens += event.promptTokens;
          usage.outputTokens += event.completionTokens;
          contextTokens = event.promptTokens + event.completionTokens;
        }
      }

      if (calls.length === 0) break;

      messages.push({
        role: "assistant",
        content: stepText || null,
        tool_calls: calls,
      });

      for (const call of calls) {
        if (signal.aborted) break;
        const started = Date.now();
        const content = await runToolCall(call, {
          projectDir,
          scope,
          question: request.message,
          toolsByName,
          visuals,
          refs,
          signal,
          onCitation: (citation) => citations.push(citation),
        });
        messages.push({ role: "tool", tool_call_id: call.id, content });
        // save_research_note adds a source mid-turn.
        if (call.function.name === "save_research_note") await refs.load();
        const failure = toolFailure(content);
        yield {
          type: "tool",
          name: call.function.name,
          ms: Date.now() - started,
          ok: failure === undefined,
          detail: failure,
        };
      }
      for (const citation of citations.splice(0)) {
        yield { type: "citation", citation };
      }
      // A visual requested in this round may be what held text back.
      const released = expander.retry();
      if (released) {
        shown += released;
        yield { type: "text", text: released };
      }
      if (signal.aborted) break;
    }

    const tail = expander.flush();
    if (tail) {
      shown += tail;
      yield { type: "text", text: tail };
    }

    // A visual the model asked for but never placed is still the user's —
    // append it rather than let it vanish.
    const placed = expander.used();
    for (const [id, markdown] of visuals) {
      if (placed.has(id)) continue;
      const block = `\n\n${markdown}`;
      shown += block;
      yield { type: "text", text: block };
    }

    yield { type: "usage", usage, contextTokens };
  } finally {
    if (runningTurns.get(key) === controller) runningTurns.delete(key);
  }
}

interface ToolContext {
  projectDir: string;
  scope: string[] | undefined;
  question: string;
  toolsByName: Map<string, MyWikiTool>;
  visuals: Map<string, string>;
  refs: SourceRefs;
  signal: AbortSignal;
  onCitation: (citation: AiCitation) => void;
}

/** Runs one tool call; returns what the model is told. Never throws. */
async function runToolCall(
  call: ChatToolCall,
  context: ToolContext,
): Promise<string> {
  const name = call.function.name;
  const args = parseArguments(call);
  if (args === undefined) {
    return JSON.stringify({
      error: `Arguments for ${name} were not valid JSON. Call it again with valid JSON.`,
    });
  }

  try {
    if (name === "show_source_figure" || name === "create_visual") {
      return await runDelegation(name, args, context);
    }

    const tool = context.toolsByName.get(name);
    if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });

    const parsed = z.object(tool.shape).safeParse(args);
    if (!parsed.success) {
      // Tell the model precisely what was wrong — it corrects itself.
      return JSON.stringify({
        error: `Invalid arguments for ${name}`,
        issues: parsed.error.issues,
      });
    }
    const result = await tool.run(parsed.data);
    const text = resultText(result);

    // A citation only counts once its verification succeeded: a cite() that
    // didn't find the quote must never reach the user as a source chip.
    if (name === "cite" && !result.isError) {
      try {
        if (JSON.parse(text)?.verified === true) {
          const { sourceId, page, quote } = parsed.data as {
            sourceId: string;
            page: number;
            quote: string;
          };
          context.onCitation({ sourceId, page, quote });
        }
      } catch {
        // not JSON — not a verified citation
      }
    }
    if (result.isError) return truncate(JSON.stringify({ error: text }));
    return truncate(
      context.refs.shorten(name, text, parsed.data as Record<string, unknown>),
    );
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : `${name} failed`,
    });
  }
}

async function runDelegation(
  name: "show_source_figure" | "create_visual",
  args: unknown,
  context: ToolContext,
): Promise<string> {
  let outcome: VisualResult;
  if (name === "show_source_figure") {
    const parsed = z.object(FIGURE_SHAPE).safeParse(args);
    if (!parsed.success) {
      return JSON.stringify({
        error: "Invalid arguments",
        issues: parsed.error.issues,
      });
    }
    outcome = await extractSourceFigure(
      context.projectDir,
      context.scope,
      {
        sourceId: parsed.data.source_id,
        page: parsed.data.page,
        slide: parsed.data.slide,
        figure: parsed.data.figure,
        annotate: parsed.data.annotate,
      },
      context.signal,
    );
  } else {
    const parsed = z.object(VISUAL_SHAPE).safeParse(args);
    if (!parsed.success) {
      return JSON.stringify({
        error: "Invalid arguments",
        issues: parsed.error.issues,
      });
    }
    outcome = await createVisual(
      context.projectDir,
      {
        question: context.question,
        purpose: parsed.data.purpose,
        // Claude never sees the short handles — they'd end up in the
        // graphic's attribution as "based on Q1, S. 12".
        knowledge: context.refs.toPlain(parsed.data.knowledge),
        basedOn: parsed.data.based_on
          ? context.refs.toPlain(parsed.data.based_on)
          : undefined,
      },
      context.signal,
    );
  }

  if (!outcome.ok) {
    return JSON.stringify({
      visual: null,
      reason: outcome.reason,
      note: "No visual was made. Continue in text.",
    });
  }
  const id = `v${context.visuals.size + 1}`;
  context.visuals.set(id, outcome.markdown);
  return JSON.stringify({
    placeholder: `{{visual:${id}}}`,
    kind: outcome.kind,
    note: "Put the placeholder on its own line where the visual belongs. It is replaced by the image; don't describe it as if the user couldn't see it.",
  });
}
