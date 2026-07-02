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
  usage?: AiUsage;
}

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

export interface AiChatRequest {
  conversationId?: string;
  message: string;
  intent?: AiIntent;
  sourceIds?: string[];
  model?: string;
}

export interface AiChatStreamEvent {
  type: "conversation" | "assistant_chunk" | "assistant_done" | "usage" | "error" | "sdk";
  conversationId: string;
  data?: unknown;
  message?: string;
}

