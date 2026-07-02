export type AiIntent = "research" | "write" | "organize";

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
  title: string;
  intent: AiIntent;
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

// Sonnet 5's context window (the only model this app currently requests).
// Not derived from the SDK response because control-request methods like
// getContextUsage() need a persistent streaming session; this is a static
// fallback that's accurate as long as the app keeps defaulting to Sonnet 5.
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;

export interface AiConversationSummary {
  id: string;
  title: string;
  intent: AiIntent;
  messageCount: number;
  updatedAt: string;
  usage?: AiUsage;
}

export type AiSourceKind = "pdf" | "markdown" | "text";

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

export interface AiUploadResult extends AiManifest {
  rejected: AiRejectedSourceFile[];
}

export interface AiChatRequest {
  conversationId?: string;
  message: string;
  intent?: AiIntent;
  sourceIds?: string[];
  model?: string;
}

export interface AiChatStreamEvent {
  type:
    | "conversation"
    | "assistant_chunk"
    | "assistant_done"
    | "usage"
    | "compacted"
    | "error"
    | "sdk";
  conversationId: string;
  data?: unknown;
  message?: string;
}

export interface AiCompactionNotice {
  trigger?: "manual" | "auto";
  preTokens?: number;
  postTokens?: number;
}

