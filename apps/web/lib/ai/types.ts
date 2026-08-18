export type AiMessageRole = "user" | "assistant" | "tool";

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface AiCitation {
  sourceId: string;
  page: number;
  quote: string;
}

export interface AiMessage {
  id: string;
  role: AiMessageRole;
  content: string;
  createdAt: string;
  usage?: AiUsage;
  citations?: AiCitation[];
  /**
   * Why this turn failed (rate limit, SDK error, …), persisted on the
   * message so the failure stays visible in the transcript — a toast
   * alone disappears, leaving an inexplicably blank answer behind.
   */
  error?: string;
}

export interface AiSource {
  id: string;
  name: string;
  path: string;
  kind: "pdf" | "markdown";
  bytes: number;
  pageCount?: number;
  ingestedAt?: string;
}

export interface AiConversation {
  id: string;
  /**
   * Display title, set from the first user message. Absent on the legacy
   * single conversation ("main") and on conversations that haven't had a
   * first message yet.
   */
  title?: string;
  model: string;
  sdkSessionId?: string;
  messages: AiMessage[];
  sourceIds: string[];
  updatedAt: string;
  /** Cumulative usage across every turn in this conversation (see mergeUsage). */
  usage?: AiUsage;
  /**
   * Approximate size of the context window as of the most recent turn
   * (that turn's cacheReadTokens + inputTokens — i.e. what was actually
   * loaded for that API call). Not the SDK's precise getContextUsage()
   * breakdown (that requires a persistent streaming session we don't
   * keep); good enough to warn before a conversation gets uncomfortably
   * long.
   */
  contextTokens?: number;
}

// Context window of the models this app offers — every current Claude model
// in the picker is a 1M-context variant, so one figure covers them all. Not
// derived from the SDK response because control-request methods like
// getContextUsage() need a persistent streaming session.
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;

/**
 * One row of the model picker, mirroring the Claude Agent SDK's ModelInfo.
 * `value` is what gets sent back as the model identifier — usually an alias
 * ("sonnet", "opus[1m]", "default") rather than a wire id, exactly as the
 * SDK reports it.
 */
export interface AiModelOption {
  value: string;
  /**
   * Wire model id `value` resolves to (e.g. "sonnet" → "claude-sonnet-5").
   * The only way to recognize a conversation that persisted an explicit id
   * as belonging to one of the alias rows the SDK now returns.
   */
  resolvedModel?: string;
  displayName: string;
  description: string;
  /**
   * Set by toPickerOptions on the row the SDK's "default" row resolves to,
   * i.e. the model Anthropic currently recommends. Only a label marker — the
   * row still selects its own pinned model, never the moving "default".
   */
  recommended?: boolean;
}

/**
 * The SDK's moving-target row: it resolves to whatever model Anthropic
 * currently recommends instead of naming one.
 */
export const DEFAULT_MODEL_ALIAS = "default";

// What the app requests when nothing else is chosen. Deliberately the wire
// id rather than the "sonnet" alias: conversations created before the model
// picker existed have exactly this string on disk, and keeping the default
// identical means they don't silently change model on first open.
export const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * Shown when the SDK's own model list can't be reached (not logged in yet,
 * CLI missing, offline). Enough to keep the picker usable rather than
 * empty; the live list replaces it as soon as it arrives.
 */
export const FALLBACK_MODEL_OPTIONS: AiModelOption[] = [
  {
    value: "opus",
    displayName: "Opus",
    description: "Best for complex, multi-step research",
  },
  {
    value: "sonnet",
    resolvedModel: DEFAULT_MODEL,
    displayName: "Sonnet",
    description: "Efficient for routine questions",
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Fastest for quick answers",
  },
];

/**
 * Turns the SDK's raw model list into the rows the picker shows.
 *
 * The SDK reports a "default" row alongside the pinned row it currently
 * resolves to — two entries for one model, which reads as a choice but
 * isn't. So the "default" row is dropped and the pinned row it points at is
 * marked `recommended` instead: same information, one row, and the marker
 * moves on its own the day the recommendation does.
 *
 * The drop is deliberately conditional. If "default" ever resolves to a
 * model that has no row of its own, it's the only way to reach that model
 * and stays in the list rather than silently disappearing.
 */
export function toPickerOptions(options: AiModelOption[]): AiModelOption[] {
  const fallback = options.find(
    (option) => option.value === DEFAULT_MODEL_ALIAS,
  );
  const recommends = fallback?.resolvedModel ?? DEFAULT_MODEL;

  const pinned = options.find(
    (option) =>
      option.value !== DEFAULT_MODEL_ALIAS &&
      (option.value === recommends || option.resolvedModel === recommends),
  );
  if (!pinned) return options;

  return options
    .filter((option) => option.value !== DEFAULT_MODEL_ALIAS)
    .map((option) =>
      option === pinned ? { ...option, recommended: true } : option,
    );
}

/**
 * The picker row a stored model string belongs to. Matches on the row's own
 * `value` first, then on `resolvedModel` so a conversation holding the wire
 * id "claude-sonnet-5" still highlights the "Sonnet" row.
 *
 * The "default" row is deliberately the last resort when matching by
 * `resolvedModel`: it currently resolves to whatever Anthropic recommends,
 * which is not the same promise as an explicitly pinned model. Preferring
 * it would show "Default (recommended)" for a conversation that is in fact
 * pinned to Sonnet — and then silently change model the day the
 * recommendation moves.
 *
 * A stored "default" resolves to the recommended row, because toPickerOptions
 * removes the "default" row: conversations that picked it before still have
 * the string on disk and would otherwise land on no row at all.
 */
export function findModelOption(
  options: AiModelOption[],
  model: string | undefined,
): AiModelOption | undefined {
  if (!model) return undefined;
  return (
    options.find((option) => option.value === model) ??
    options.find(
      (option) =>
        option.resolvedModel === model && option.value !== DEFAULT_MODEL_ALIAS,
    ) ??
    options.find((option) => option.resolvedModel === model) ??
    (model === DEFAULT_MODEL_ALIAS
      ? options.find((option) => option.recommended)
      : undefined)
  );
}

/**
 * The empty state's subtitle reads "Answers drawn from your N sources — TAIL".
 * The count is computed from the manifest, never written by the model, so the
 * one factual claim in the sentence can't be hallucinated; only this closing
 * clause is up for generation.
 */
export const DEFAULT_TAGLINE_TAIL =
  "with tables, equations, and diagrams when they help.";

/** How long a generated clause may be before it stops fitting on one line. */
const MAX_TAGLINE_TAIL = 80;

/**
 * Makes a model's reply usable as that closing clause, or rejects it.
 *
 * The model is asked for one bare clause, and mostly obliges — but it also
 * wraps it in quotes, prefixes the dash it was shown in the template, or
 * answers in two lines. Rather than trust the instruction, take the first
 * line, strip the decorations, and require the result to be short and plain;
 * anything else is dropped in favour of the default, because a broken
 * subtitle is worse than a generic one.
 */
export function sanitizeTaglineTail(raw: string): string | null {
  const tail = raw
    .split("\n")[0]
    .trim()
    .replace(/^["'`«»\s]+|["'`«»\s]+$/g, "")
    .replace(/^[—–-]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!tail || tail.length > MAX_TAGLINE_TAIL) return null;
  // Markdown, bullets or a second sentence mean it ignored the brief.
  if (/[*_#`|[\]<>]/.test(tail)) return null;

  return /[.!?]$/.test(tail) ? tail : `${tail}.`;
}

// The id of the legacy single conversation, kept as the fallback when a
// chat request names no conversation — pre-multi-conversation clients and
// existing on-disk conversations keep working unchanged.
export const MAIN_CONVERSATION_ID = "main";

/** What the conversation-history list shows — everything but the messages. */
export interface AiConversationSummary {
  id: string;
  title?: string;
  updatedAt: string;
  messageCount: number;
}

export type AiSourceKind = "pdf" | "pptx" | "markdown" | "text" | "note";

export interface AiSourceMetadata {
  title?: string;
  authors?: string[];
  year?: string;
  /** Only ever set when provenance is "crossref" — a real, independently checkable identifier for the matched record. */
  doi?: string;
  /**
   * "manual" means a human directly typed/confirmed these values in the
   * source detail panel — the single most trustworthy tier there is, safe
   * to auto-fill into a citation. "crossref" means the title/authors/year
   * were confirmed against a real CrossRef bibliographic record (a
   * publisher-submitted database entry, not an extraction) — also safe to
   * auto-fill. "pdf-metadata" means they came from the PDF's own embedded
   * metadata dictionary — also trustworthy. "heuristic" means it's a rough
   * guess from the page's own text/layout — good for a human to skim,
   * never trustworthy enough to silently feed into a citation.
   */
  provenance: "manual" | "crossref" | "pdf-metadata" | "heuristic";
  /**
   * True when `title` specifically came from a heuristic guess even though
   * the rest of this object is "pdf-metadata" or "crossref" provenance.
   * Common case: a PDF built from LaTeX that never set
   * \hypersetup{pdftitle=...} has a genuinely blank Title field but a
   * perfectly real CreationDate — good for a human skimming the source
   * list, never safe to auto-fill into a citation the way a verified title
   * is.
   */
  titleIsHeuristic?: boolean;
  /** Same idea as titleIsHeuristic, for `authors` specifically. */
  authorsAreHeuristic?: boolean;
}

export interface AiSourceRecord {
  id: string;
  originalName: string;
  storedName: string;
  relativePath: string;
  kind: AiSourceKind;
  bytes: number;
  pageCount?: number;
  ingestedAt: string;
  updatedAt: string;
  /**
   * BibTeX cite key this source is linked to in the project's .bib file,
   * once ensure_bibtex_entry has created or found one. Keeps repeated
   * citation requests for the same source idempotent instead of appending
   * a duplicate .bib entry every time.
   */
  bibKey?: string;
  /** Best-effort bibliographic metadata captured at ingestion time — see AiSourceMetadata. */
  metadata?: AiSourceMetadata;
  /**
   * Primary-source ids a research note (kind "note") drew on when the AI
   * wrote it — informational/traceability only. Never used to satisfy
   * cite(): a note can never be a citation target regardless of what it
   * claims to draw on (see verifyAiCitation's kind === "note" guard).
   */
  drawsOnSourceIds?: string[];
  /**
   * SHA-256 of the raw uploaded bytes — lets a new upload be checked
   * against every existing source for an exact-content duplicate without
   * re-reading and re-hashing every file on disk each time. Absent for
   * notes (never uploaded bytes to hash).
   */
  contentHash?: string;
  /**
   * Deterministic ingest-time digest: opening of page 1 (usually the
   * abstract) and the section outline with page numbers. Lets the agent
   * plan retrieval per source instead of searching blind.
   */
  digest?: {
    abstract?: string;
    outline?: Array<{ page: number | null; heading: string }>;
  };
}

export interface AiManifest {
  version: 1;
  updatedAt: string;
  embeddingModel: string;
  embeddingDimensions: number | null;
  sources: AiSourceRecord[];
  index: {
    chunkCount: number;
    embeddingCount: number;
    generatedAt: string | null;
  };
}

export interface AiRejectedSourceFile {
  name: string;
  reason: string;
}

/** Non-blocking: the file was still uploaded and indexed, just flagged. */
export interface AiUploadWarning {
  name: string;
  reason: string;
}

export interface AiUploadResult extends AiManifest {
  rejected: AiRejectedSourceFile[];
  warnings: AiUploadWarning[];
}

export interface AiPlanUsageWindow {
  /** Percentage of the window used, 0-100. */
  utilization: number;
  /** ISO 8601 timestamp when the window resets, or null if unknown. */
  resetsAt: string | null;
}

// A narrowed, stable shape for the Claude Agent SDK's experimental /usage
// data (see lib/ai/agent.ts's getPlanUsage) — the SDK's own response type
// is explicitly unstable ("EXPERIMENTAL_MAY_CHANGE"), so only the fields
// this app actually displays are re-exposed here, insulating the rest of
// the app from that shape shifting under us.
export interface AiPlanUsage {
  subscriptionType: string | null;
  sessionCostUsd: number;
  fiveHour: AiPlanUsageWindow | null;
  sevenDay: AiPlanUsageWindow | null;
}

// Embedding a large PDF (hundreds of pages -> thousands of chunks) through a
// CPU-bound local model is the dominant cost of an upload and can run tens
// of seconds — long enough that a caller needs real incremental feedback,
// not just a spinner, to tell "still working" apart from "stuck." Emitted
// at natural checkpoints: once per source as it's saved/extracted, then
// repeatedly during embedding (its own batches are the only sub-second-
// granularity checkpoint available).
export type AiUploadProgressEvent =
  | { stage: "saving"; fileName: string; fileIndex: number; fileCount: number }
  | {
      stage: "extracting";
      fileName: string;
      fileIndex: number;
      fileCount: number;
    }
  | {
      stage: "verifying";
      fileName: string;
      fileIndex: number;
      fileCount: number;
    }
  | { stage: "embedding"; chunksDone: number; chunksTotal: number }
  | { stage: "indexing" };

export type AiUploadProgressCallback = (event: AiUploadProgressEvent) => void;

export interface AiChatRequest {
  message: string;
  /** Target conversation; omitted = the legacy MAIN_CONVERSATION_ID. */
  conversationId?: string;
  sourceIds?: string[];
  model?: string;
}

export interface AiChatStreamEvent {
  type:
    | "assistant_chunk"
    | "assistant_done"
    | "usage"
    | "compacted"
    | "error"
    | "sdk";
  data?: unknown;
  message?: string;
}

export interface AiCompactionNotice {
  trigger?: "manual" | "auto";
  preTokens?: number;
  postTokens?: number;
}
