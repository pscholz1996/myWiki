import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ModelInfo,
  Query,
  SDKControlGetUsageResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { listAiSources } from "@/lib/ai/knowledge-base";
import type {
  AiChatRequest,
  AiConversation,
  AiModelOption,
} from "@/lib/ai/types";
import { DEFAULT_MODEL } from "@/lib/ai/types";
import { createMyWikiTools } from "@/lib/ai/tools";

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

async function serializePrompt(
  projectDir: string,
  conversation: AiConversation,
  request: AiChatRequest,
): Promise<string> {
  const manifest = await listAiSources(projectDir);
  const currentSourceIds = new Set(manifest.sources.map((source) => source.id));
  const staleSourceIds = findStaleCitedSourceIds(
    conversation,
    currentSourceIds,
  );

  const lines = [
    "You are myWiki — a personal knowledge assistant answering questions from the user's own library (systems engineering, AI research, standards/norms, books, papers, slides) plus your general knowledge.",
    "Follow these rules:",
    "",
    "## Answering",
    "- Your job is knowledge, not writing: give the clearest, most correct answer to the question. You have no file-editing tools and never draft documents.",
    "- Answer in the language of the question: a German question gets a German answer, an English question an English one. Keep source terminology as-is (e.g. a norm's defined German/English terms) where translating would change meaning.",
    '- Everything you write outside tool calls is shown to the user as one continuous answer — so never narrate your process ("searching now…", "found it, looks good, next I\'ll…"). Work silently between tool calls and write only the polished answer itself.',
    "- Ground answers in the knowledge base first. For a substantive question, don't stop at the first useful chunk: search from multiple angles/phrasings — different terms, synonyms, related sub-questions, German and English where relevant — then synthesize one holistic answer across every relevant source.",
    '- Where the sources don\'t cover something (or the question goes beyond them), answer from your general knowledge — but make the boundary visible. Mark those parts briefly, e.g. a short parenthetical "(general knowledge — not in your sources)" or a one-line note; never blur what came from the library vs. from you.',
    "- If neither the sources nor your general knowledge support a confident answer, say so plainly.",
    "",
    "## Visual answers",
    "- Choose the form that communicates best; plain text is the default, not the ceiling.",
    "- Use a GFM markdown table for comparisons, trade-offs, parameter lists, requirement matrices, or anything naturally tabular.",
    "- Use LaTeX math ($inline$ or $$display$$) for every equation or formal definition — never ASCII-art math.",
    "- Use a ```mermaid fenced code block for structures and behavior: processes (flowchart TD/LR), sequences (sequenceDiagram), states (stateDiagram-v2), class/block structures (classDiagram), timelines, mindmaps. Systems-engineering questions (V-model, requirement flows, architectures, interfaces) very often deserve a diagram — reach for one whenever a picture beats a paragraph.",
    "- Combine forms freely: a short prose explanation plus a diagram or table usually beats either alone. Don't force a visual when text answers cleanly.",
    "",
    "## Source images (original figures from the library)",
    "- When a source contains the actual figure for what's being asked (the V-model diagram in a handbook, an architecture figure in a paper, a chart on a slide), showing THAT original beats redrawing it. Workflow: find the page/slide via search or read_source_page, then for PDFs call view_page_image and crop_image to cut out just the figure; for pptx sources call list_slide_images + view_image. Embed the result with markdown: ![short description](its url).",
    "- Embed ONLY the figure, never the whole page: a full page render has no embeddable url (it is your working material for locating the figure) — always crop_image the exact figure region first, check the crop looks clean, and embed that. If the crop caught page furniture (headers, body text, neighboring figures), redo it tighter.",
    '- Do this proactively, not only when asked for an image: whenever your search results suggest a source has a figure that would genuinely help the explanation (search hits mentioning "Figure/Abbildung/Bild/Diagramm/Tabelle X", figure captions, slides that are clearly diagram slides), consider pulling it in on your own initiative. A question about a concept that a source illustrates deserves the source\'s illustration. Skip it when a figure adds nothing — proactive, not decorative.',
    "- Every image you embed MUST be followed on the next line by an italic attribution, e.g. *Source: INCOSE Handbook, p. 34* — the tool result gives you the exact attribution string to use. Never show a source image without saying where it's from.",
    '- You may annotate a source image when a mark genuinely helps the explanation (circle the relevant block, arrow to the step being discussed, highlight a region) via annotate_image. Annotations are strictly additive pointers: never cover, redact, or alter the figure\'s own content, labels, or terminology, never more marks than the point needs, and the attribution already says "(annotated)" — keep it. Prefer shapes over text labels; a label is for short pointers only ("here", "Step 2").',
    "- Look at what each image tool returns (you see the image) and check it before embedding: is the crop clean, is the annotation on the right spot? Redo it if not — never embed an image you haven't visually checked.",
    "- If no source contains a suitable figure, say so if the user asked for one, and fall back to a mermaid diagram (marked as your own rendering, not from a source).",
    "",
    "## Sources & attribution",
    "- Attribution is lightweight but honest: the user must always see where knowledge came from and be able to jump into the source — not bibliography-grade referencing.",
    '- Inline source labels: whenever a claim, number, or finding comes from a specific source, follow it with an inline markdown link of the form [ShortName Year, S. N](/api/ai/sources/SOURCE_ID/file#page=N) — e.g. [Poulsen 2025, S. 5](/api/ai/sources/abc-123/file#page=5). The UI renders these as clickable source labels that open the PDF at that page. Use them instead of plain-text parentheses like "(Poulsen et al. 2025)": every source mention should be such a link. Keep the label short (first author + year, or a short title, plus page/slide). Use each source\'s real id from search results/browse.',
    "- For pivotal or surprising source-backed claims, verify the exact quote with cite() so the answer carries a verified source chip the user can open. Routine background claims don't each need their own cite() call.",
    "- If a quote cannot be verified, say so and keep searching instead of guessing.",
    "- A citation made earlier in THIS conversation is not automatically still valid (sources can be deleted mid-conversation) — re-verify with cite() before restating it as verified. Re-verification is something you silently DO, never something you narrate.",
    '- Search results and browse_knowledge_base may include research notes you saved in earlier turns (kind "note") alongside primary sources. A note is your own prior synthesis — useful context, never a primary source; cite() refuses to verify against it. When a broad multi-source search produces a genuinely new synthesis worth keeping, save it with save_research_note so future turns don\'t redo the work.',
    "- If a source's stored title/authors looks wrong against the page text, point it out and ask before changing anything; only call update_source_metadata after the user explicitly confirms the correction.",
    staleSourceIds.length > 0
      ? `- The following source IDs were cited earlier in this conversation but have since been permanently REMOVED from the knowledge base: ${staleSourceIds.join(", ")}. Do not restate, confirm, or rely on anything from them. If asked, say the source was removed from the knowledge base and that information can no longer be verified.`
      : null,
    request.sourceIds && request.sourceIds.length > 0
      ? `Selected sources: ${request.sourceIds.join(", ")}`
      : "Selected sources: all available sources",
    "",
    "User request:",
    request.message,
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

export function createMyWikiMcpServer(
  projectDir: string,
  scopedSourceIds?: string[],
) {
  const tools = createMyWikiTools(projectDir, scopedSourceIds);
  return createSdkMcpServer({
    name: "mywiki",
    version: "0.1.0",
    alwaysLoad: true,
    tools: tools.map((entry) =>
      tool(entry.name, entry.description, entry.shape, (args) =>
        entry.run(args as Record<string, unknown>),
      ),
    ),
  });
}

// A pushable async-iterable "inbox": the persistent Query's prompt keeps
// consuming from this across many turns, not just one — that's what keeps
// the underlying Claude Agent SDK session (and its CLI subprocess) alive
// between separate chat HTTP requests instead of spawning a fresh one per
// message. Needed for anything that requires "streaming input mode" (the
// experimental usage/rate-limit query below); a plain string prompt only
// ever supports a single one-shot turn per process.
class PushableQueue<T> implements AsyncIterable<T> {
  private buffered: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.buffered.push(value);
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter({ value: undefined as never, done: true });
    }
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({
            value: this.buffered.shift() as T,
            done: false,
          });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

// Buffers one chat turn's worth of messages so a caller can consume them
// as an AsyncGenerator (matching the shape callers already expect) even
// though they're really being dispatched from one long-lived background
// pump shared across every turn — see LiveSession.pump().
class TurnMessageStream {
  private buffered: SDKMessage[] = [];
  private waiter: ((result: IteratorResult<SDKMessage>) => void) | null = null;
  private finished = false;

  push(message: SDKMessage): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: message, done: false });
    } else {
      this.buffered.push(message);
    }
  }

  finish(): void {
    this.finished = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    while (true) {
      if (this.buffered.length > 0) {
        yield this.buffered.shift() as SDKMessage;
        continue;
      }
      if (this.finished) return;
      const result = await new Promise<IteratorResult<SDKMessage>>(
        (resolve) => {
          this.waiter = resolve;
        },
      );
      if (result.done) return;
      yield result.value;
    }
  }
}

// One persistent Query per project, reused across every chat turn instead
// of spawning a fresh CLI subprocess per message. A single background pump
// (see .pump()) continuously reads the Query's own message stream and
// hands each message to whichever turn is currently in flight; .busy
// guards against a second turn starting before the first resolves (this
// app is single-user/single-conversation-per-project, so turns are never
// meant to overlap — a second one arriving mid-turn is a bug upstream, not
// something to silently queue).
class LiveSession {
  private inbox = new PushableQueue<SDKUserMessage>();
  private query: Query;
  private currentTurn: TurnMessageStream | null = null;
  // The model this session is currently running, so a turn can tell an
  // actual switch apart from the same model being re-sent every message.
  private model: string;

  constructor(options: {
    cwd: string;
    sourceIds: string[];
    model: string;
    isNewSession: boolean;
    sdkSessionId: string;
  }) {
    // `sessionId` creates a session under a caller-chosen id and is only
    // valid on the first turn; resuming an existing session must use
    // `resume` instead (the SDK does not treat repeating `sessionId` as a
    // resume — it conflicts with the already-persisted session and
    // crashes the CLI process).
    const sessionOptions = options.isNewSession
      ? { sessionId: options.sdkSessionId }
      : { resume: options.sdkSessionId };

    this.model = options.model;

    this.query = query({
      prompt: this.inbox,
      options: {
        cwd: options.cwd,
        ...sessionOptions,
        persistSession: true,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: [],
        mcpServers: {
          mywiki: createMyWikiMcpServer(options.cwd, options.sourceIds),
        },
        includePartialMessages: true,
        // Generous on purpose: a single grounded answer legitimately chains
        // many tool calls (multi-angle searches, browse, several page
        // reads, render/crop/annotate figures, cite()) — a tight cap makes
        // exactly the thorough answers this app exists for "stop early"
        // (seen live at 8). This is a runaway-loop backstop, not a budget;
        // the real spend control is the user's plan limit.
        maxTurns: 100,
        model: options.model,
        // Long research conversations can exceed the context window. The
        // SDK (the same engine behind Claude Code) already knows how to
        // compact — summarize older turns and keep going — but that
        // behavior lives behind a settings flag rather than being
        // unconditionally on, so set it explicitly instead of relying on
        // an ambient default we don't control from here.
        settings: { autoCompactEnabled: true },
      },
    });

    void this.pump();
  }

  private async pump(): Promise<void> {
    for await (const message of this.query) {
      this.currentTurn?.push(message);
      if (message.type === "result") {
        this.currentTurn?.finish();
        this.currentTurn = null;
      }
    }
  }

  get busy(): boolean {
    return this.currentTurn !== null;
  }

  // Re-scopes the session's knowledge-base tools to the currently-checked
  // sources before each turn — with a fresh query() per turn (the old
  // design) this happened implicitly every time; a persistent session
  // needs the explicit dynamic-reconfigure call so changing which sources
  // are checked still takes effect on the very next message.
  async rescopeSources(cwd: string, sourceIds: string[]): Promise<void> {
    await this.query.setMcpServers({
      mywiki: createMyWikiMcpServer(cwd, sourceIds),
    });
  }

  /**
   * Switches the model this session runs from the next turn on — the same
   * live reconfigure Claude Code's own /model does, so the conversation and
   * its whole accumulated context survive the switch instead of being
   * restarted under a new model.
   *
   * Returns false when the control request failed, which the caller must
   * treat as "this session is stuck on the old model": silently answering
   * with a model the user didn't pick is the one outcome worth a cold
   * restart over.
   */
  async applyModel(model: string): Promise<boolean> {
    if (model === this.model) return true;
    try {
      await this.query.setModel(model);
      this.model = model;
      return true;
    } catch {
      return false;
    }
  }

  /** Models this account may actually use, as the CLI reports them. */
  async supportedModels(): Promise<ModelInfo[]> {
    return this.query.supportedModels();
  }

  async *runTurn(userMessage: SDKUserMessage): AsyncGenerator<SDKMessage> {
    if (this.currentTurn) {
      throw new Error(
        "A message is already being processed for this conversation.",
      );
    }
    const stream = new TurnMessageStream();
    this.currentTurn = stream;
    this.inbox.push(userMessage);
    yield* stream;
  }

  async usage(): Promise<SDKControlGetUsageResponse> {
    return this.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
  }

  /**
   * Aborts the CURRENT turn only — tool calls stop, the turn's result
   * message comes back as interrupted, and the session (with all its
   * context) stays alive for the next message. This is the stop button,
   * not a teardown.
   */
  async interrupt(): Promise<void> {
    await this.query.interrupt();
  }

  close(): void {
    this.inbox.close();
    this.query.close();
  }
}

// Keyed on globalThis (not a plain module-level Map) so Next.js dev-mode
// hot-reloading of this module doesn't orphan a live session's underlying
// CLI subprocess — reloading would otherwise silently drop the only
// reference to it without ever calling .close().
const globalForSessions = globalThis as unknown as {
  __mywikiLiveSessions?: Map<string, LiveSession>;
};
const liveSessions =
  globalForSessions.__mywikiLiveSessions ?? new Map<string, LiveSession>();
globalForSessions.__mywikiLiveSessions = liveSessions;

function sessionKey(projectDir: string, conversationId: string): string {
  return `${projectDir}::${conversationId}`;
}

/**
 * Close the live SDK session for one conversation, or (with no
 * conversationId) every session under the project — the latter is what
 * switching the knowledge folder needs.
 */
/**
 * Stop button: interrupt the running turn of one conversation's live
 * session. Returns false when there is no live session to interrupt
 * (turn already finished, or server restarted since it began).
 */
// Which conversations' running turns were stopped BY THE USER — lets the
// chat route tell a deliberate stop apart from a genuine mid-turn error
// (the SDK reports both as error_during_execution). globalThis-keyed for
// the same dev-mode hot-reload reason as liveSessions.
const globalForInterrupts = globalThis as unknown as {
  __mywikiInterrupted?: Set<string>;
};
const interruptedTurns =
  globalForInterrupts.__mywikiInterrupted ?? new Set<string>();
globalForInterrupts.__mywikiInterrupted = interruptedTurns;

/** True exactly once per user-initiated stop (consumed on read). */
export function consumeUserInterrupt(
  projectDir: string,
  conversationId: string,
): boolean {
  return interruptedTurns.delete(sessionKey(projectDir, conversationId));
}

export async function interruptLiveSession(
  projectDir: string,
  conversationId: string,
): Promise<boolean> {
  const session = liveSessions.get(sessionKey(projectDir, conversationId));
  if (!session) return false;
  try {
    interruptedTurns.add(sessionKey(projectDir, conversationId));
    await session.interrupt();
    return true;
  } catch {
    // A session whose transport already died (turn errored, subprocess
    // gone) can't be interrupted — and doesn't need to be. Stop is
    // best-effort by design.
    interruptedTurns.delete(sessionKey(projectDir, conversationId));
    return false;
  }
}

export function closeLiveSession(
  projectDir: string,
  conversationId?: string,
): void {
  const prefix = `${projectDir}::`;
  for (const [key, session] of liveSessions) {
    if (
      conversationId
        ? key === sessionKey(projectDir, conversationId)
        : key.startsWith(prefix)
    ) {
      session.close();
      liveSessions.delete(key);
    }
  }
}

export async function getPlanUsage(
  projectDir: string,
): Promise<SDKControlGetUsageResponse | null> {
  // Any live session under this project can answer the plan-usage query —
  // usage is account-level, not conversation-level.
  const prefix = `${projectDir}::`;
  const session = [...liveSessions.entries()].find(([key]) =>
    key.startsWith(prefix),
  )?.[1];
  if (!session) return null;
  try {
    return await session.usage();
  } catch {
    // The experimental control API can fail transiently (e.g. right after
    // a turn finishes, before the transport settles) — treat that the same
    // as "not available yet" rather than surfacing an error for what's
    // meant to be a best-effort display.
    return null;
  }
}

// Asking the CLI for the model list costs a subprocess spawn plus an auth
// round-trip (~seconds), and the answer only changes when the account's
// plan does — cache it for the life of the server process. globalThis-keyed
// for the same dev-mode hot-reload reason as liveSessions.
const globalForModels = globalThis as unknown as {
  __mywikiModels?: Promise<AiModelOption[]>;
};

function toModelOption(info: ModelInfo): AiModelOption {
  return {
    value: info.value,
    resolvedModel: info.resolvedModel,
    displayName: info.displayName,
    description: info.description,
  };
}

/**
 * The models this account may actually use, exactly as the CLI reports them
 * (the same list Claude Code's own model picker shows) — never a hardcoded
 * catalog, which would drift and offer models the plan can't run.
 *
 * Throws when the list can't be obtained (not logged in, CLI missing); the
 * caller decides whether to surface that or fall back.
 */
export async function listSupportedModels(
  projectDir: string,
): Promise<AiModelOption[]> {
  if (globalForModels.__mywikiModels) return globalForModels.__mywikiModels;

  const load = (async () => {
    // A live session can answer this over its existing control channel —
    // free compared to spawning a second CLI just to read a list.
    const prefix = `${projectDir}::`;
    const live = [...liveSessions.entries()].find(([key]) =>
      key.startsWith(prefix),
    )?.[1];
    if (live) {
      try {
        return (await live.supportedModels()).map(toModelOption);
      } catch {
        // Fall through to a throwaway session below.
      }
    }

    // Before the first message there is no live session, but the picker
    // still has to be populated. `persistSession: false` keeps this probe
    // from leaving a stray session behind in the user's ~/.claude history,
    // and the prompt stream never yields, so no turn is ever billed — only
    // the control request runs. It parks on a promise that never settles
    // (not a timer, which would hold the event loop open past close()); the
    // finally below is what actually ends the subprocess.
    const probe = query({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await new Promise<never>(() => {});
      })(),
      options: {
        cwd: projectDir,
        persistSession: false,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: [],
      },
    });
    try {
      return (await probe.supportedModels()).map(toModelOption);
    } finally {
      probe.close();
    }
  })();

  // Only a successful lookup is worth caching — a failure here usually
  // means "not logged in yet", which the very next request may fix.
  globalForModels.__mywikiModels = load;
  load.catch(() => {
    globalForModels.__mywikiModels = undefined;
  });
  return load;
}

export async function* runMyWikiChatTurn(
  projectDir: string,
  conversation: AiConversation,
  request: AiChatRequest,
  isNewSession: boolean,
) {
  const prompt = await serializePrompt(projectDir, conversation, request);
  const sdkSessionId = conversation.sdkSessionId ?? conversation.id;
  const model = request.model ?? conversation.model ?? DEFAULT_MODEL;

  const key = sessionKey(projectDir, conversation.id);
  let session = liveSessions.get(key);
  // A live session already owns an SDK session under sdkSessionId, so if it
  // has to be rebuilt below it must RESUME that id — re-sending it as
  // `sessionId` collides with the persisted session and kills the CLI.
  let startFresh = isNewSession;

  if (session) {
    await session.rescopeSources(projectDir, conversation.sourceIds);
    // The model the user picked has to reach an already-running session
    // too. Without this a mid-conversation switch was accepted by the UI,
    // persisted to disk, and then quietly ignored: the session kept
    // answering with whatever model it was constructed with.
    if (!(await session.applyModel(model))) {
      closeLiveSession(projectDir, conversation.id);
      session = undefined;
      startFresh = false;
    }
  }

  if (!session) {
    // One CLI subprocess per live conversation would accumulate as the
    // user switches around their history — close the project's other
    // sessions first. Switching back re-resumes from sdkSessionId, so
    // nothing is lost except a warm process.
    closeLiveSession(projectDir);
    session = new LiveSession({
      cwd: projectDir,
      sourceIds: conversation.sourceIds,
      model,
      isNewSession: startFresh,
      sdkSessionId,
    });
    liveSessions.set(key, session);
  }

  const userMessage: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
  };

  yield* session.runTurn(userMessage);
}
