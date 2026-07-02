import { create } from "zustand";
import type {
  AiChatRequest,
  AiChatStreamEvent,
  AiConversation,
  AiConversationSummary,
  AiManifest,
  AiMessage,
  AiRejectedSourceFile,
  AiSourceRecord,
} from "@/lib/ai/types";
import {
  deleteAiConversation,
  deleteAiSource,
  fetchAiConversation,
  fetchAiConversations,
  fetchAiManifest,
  streamAiChat,
  uploadAiSources,
} from "@/lib/ai/ai-client";

interface AiState {
  manifest: AiManifest | null;
  sources: AiSourceRecord[];
  conversations: AiConversationSummary[];
  activeConversationId: string | null;
  activeConversation: AiConversation | null;
  currentIntent: AiConversation["intent"];
  loading: boolean;
  error: string | null;
  actionLoading: boolean;
  chatLoading: boolean;
  loadSources: () => Promise<void>;
  loadConversations: () => Promise<void>;
  uploadSources: (files: File[]) => Promise<AiRejectedSourceFile[]>;
  removeSource: (sourceId: string) => Promise<void>;
  createConversation: (title?: string) => Promise<string>;
  selectConversation: (conversationId: string) => Promise<void>;
  removeConversation: (conversationId: string) => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  setIntent: (intent: AiConversation["intent"]) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function makeUserMessage(content: string): AiMessage {
  return { id: newId(), role: "user", content, createdAt: nowIso() };
}

function makeAssistantMessage(content = ""): AiMessage {
  return { id: newId(), role: "assistant", content, createdAt: nowIso() };
}

function upsertAssistantChunk(conversation: AiConversation, chunk: string): AiConversation {
  const messages = [...conversation.messages];
  const last = messages[messages.length - 1];

  if (last?.role === "assistant") {
    messages[messages.length - 1] = {
      ...last,
      content: `${last.content}${chunk}`,
    };
  } else {
    messages.push(makeAssistantMessage(chunk));
  }

  return { ...conversation, messages };
}

function finalizeAssistantMessage(
  conversation: AiConversation,
  content: string,
  usage?: AiConversation["usage"],
  citations?: AiMessage["citations"],
): AiConversation {
  const messages = [...conversation.messages];
  const last = messages[messages.length - 1];

  if (last?.role === "assistant") {
    messages[messages.length - 1] = {
      ...last,
      content,
      usage,
      citations,
    };
  } else {
    messages.push({ ...makeAssistantMessage(content), usage, citations });
  }

  return { ...conversation, messages, usage };
}

function mergeConversationSummary(
  summaries: AiConversationSummary[],
  next: AiConversationSummary,
): AiConversationSummary[] {
  const index = summaries.findIndex((summary) => summary.id === next.id);
  const copy = [...summaries];

  if (index === -1) {
    copy.unshift(next);
  } else {
    copy[index] = next;
  }

  return copy.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

// Guards loadSources/uploadSources/removeSource against overwriting each
// other with stale data. All three fetch-then-set the same manifest/sources
// pair, so whichever *response* lands last normally wins — but responses
// don't always arrive in the order their requests were sent. In practice:
// the mount-time loadSources() (fired twice under React Strict Mode) can
// still be in flight when a fast upload finishes; if that old GET resolves
// after the upload's response, it silently reverts the UI to the
// pre-upload (empty) state even though the backend — and the rest of the
// app — has the new source. Each call captures the sequence number at
// start and only commits if no newer call has started since, so a late
// response from a superseded request is discarded instead of applied.
let sourcesOpSeq = 0;

export const useAiStore = create<AiState>((set, get) => ({
  manifest: null,
  sources: [],
  conversations: [],
  activeConversationId: null,
  activeConversation: null,
  currentIntent: "research",
  loading: false,
  error: null,
  actionLoading: false,
  chatLoading: false,

  async loadSources() {
    const token = ++sourcesOpSeq;
    set({ loading: true, error: null });
    try {
      const manifest = await fetchAiManifest();
      if (token !== sourcesOpSeq) return;
      set({ manifest, sources: manifest.sources });
    } catch (error) {
      if (token !== sourcesOpSeq) return;
      set({
        error:
          error instanceof Error ? error.message : "Failed to load knowledge base",
      });
    } finally {
      if (token === sourcesOpSeq) set({ loading: false });
    }
  },

  async loadConversations() {
    set({ loading: true, error: null });
    try {
      const conversations = await fetchAiConversations();
      set({ conversations });
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to load conversations",
      });
    } finally {
      set({ loading: false });
    }
  },

  async uploadSources(files: File[]) {
    const token = ++sourcesOpSeq;
    set({ actionLoading: true, error: null });
    try {
      const { rejected, ...manifest } = await uploadAiSources(files);
      if (token !== sourcesOpSeq) return rejected;
      set({ manifest, sources: manifest.sources });
      return rejected;
    } catch (error) {
      if (token !== sourcesOpSeq) return [];
      set({
        error:
          error instanceof Error ? error.message : "Failed to upload sources",
      });
      throw error;
    } finally {
      if (token === sourcesOpSeq) set({ actionLoading: false });
    }
  },

  async removeSource(sourceId: string) {
    const token = ++sourcesOpSeq;
    set({ actionLoading: true, error: null });
    try {
      const manifest = await deleteAiSource(sourceId);
      if (token !== sourcesOpSeq) return;
      set({ manifest, sources: manifest.sources });
    } catch (error) {
      if (token !== sourcesOpSeq) return;
      set({
        error:
          error instanceof Error ? error.message : "Failed to delete source",
      });
      throw error;
    } finally {
      if (token === sourcesOpSeq) set({ actionLoading: false });
    }
  },

  async createConversation(title?: string) {
    const conversationId = newId();
    const conversation: AiConversation = {
      id: conversationId,
      title: title ?? "New conversation",
      intent: get().currentIntent,
      model: "claude-sonnet-5",
      sdkSessionId: conversationId,
      messages: [],
      sourceIds: [],
      updatedAt: nowIso(),
    };

    set((state) => ({
      activeConversationId: conversationId,
      activeConversation: conversation,
      conversations: mergeConversationSummary(state.conversations, {
        id: conversationId,
        title: conversation.title,
        intent: conversation.intent,
        messageCount: 0,
        updatedAt: conversation.updatedAt,
        usage: conversation.usage,
      }),
    }));

    return conversationId;
  },

  async selectConversation(conversationId: string) {
    set({ loading: true, error: null });
    try {
      const conversation = await fetchAiConversation(conversationId);
      set({
        activeConversationId: conversation.id,
        activeConversation: conversation,
        currentIntent: conversation.intent,
      });
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to load conversation",
      });
    } finally {
      set({ loading: false });
    }
  },

  async removeConversation(conversationId: string) {
    set({ actionLoading: true, error: null });
    try {
      await deleteAiConversation(conversationId);
      set((state) => ({
        conversations: state.conversations.filter(
          (conversation) => conversation.id !== conversationId,
        ),
        activeConversationId:
          state.activeConversationId === conversationId
            ? null
            : state.activeConversationId,
        activeConversation:
          state.activeConversationId === conversationId
            ? null
            : state.activeConversation,
      }));
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to delete conversation",
      });
      throw error;
    } finally {
      set({ actionLoading: false });
    }
  },

  async sendMessage(message: string) {
    set({ chatLoading: true, error: null });

    const trimmed = message.trim();
    if (!trimmed) {
      set({ chatLoading: false });
      return;
    }

    let activeConversation = get().activeConversation;
    if (!activeConversation) {
      const conversationId = await get().createConversation();
      activeConversation = get().activeConversation;
      if (!activeConversation) {
        activeConversation = {
          id: conversationId,
          title: "New conversation",
          intent: get().currentIntent,
          model: "claude-sonnet-5",
          sdkSessionId: conversationId,
          messages: [],
          sourceIds: [],
          updatedAt: nowIso(),
        };
      }
    }

    const userMessage = makeUserMessage(trimmed);
    const nextConversation: AiConversation = {
      ...activeConversation,
      messages: [...activeConversation.messages, userMessage],
      updatedAt: nowIso(),
      title:
        activeConversation.title === "New conversation" &&
        activeConversation.messages.length === 0
          ? trimmed.slice(0, 64)
          : activeConversation.title,
    };

    set({
      activeConversationId: nextConversation.id,
      activeConversation: nextConversation,
      currentIntent: nextConversation.intent,
    });

    const request: AiChatRequest = {
      conversationId: nextConversation.id,
      message: trimmed,
      intent: nextConversation.intent,
      sourceIds: nextConversation.sourceIds,
      model: nextConversation.model,
    };

    try {
      await streamAiChat(request, (event: AiChatStreamEvent) => {
        if (event.type === "conversation" && event.data && typeof event.data === "object") {
          const data = event.data as {
            id?: string;
            title?: string;
            intent?: AiConversation["intent"];
          };

          set((state) => ({
            activeConversation: state.activeConversation
              ? {
                  ...state.activeConversation,
                  id: data.id ?? state.activeConversation.id,
                  title: data.title ?? state.activeConversation.title,
                  intent: data.intent ?? state.activeConversation.intent,
                }
              : state.activeConversation,
            activeConversationId: data.id ?? state.activeConversationId,
          }));
          return;
        }

        if (event.type === "assistant_chunk" && event.data && typeof event.data === "object") {
          const data = event.data as { text?: string };
          const text = data.text;
          if (!text) return;

          set((state) => ({
            activeConversation: state.activeConversation
              ? upsertAssistantChunk(state.activeConversation, text)
              : state.activeConversation,
          }));
          return;
        }

        if (event.type === "usage" && event.data && typeof event.data === "object") {
          const usage = event.data as AiConversation["usage"];
          set((state) => ({
            activeConversation: state.activeConversation
              ? {
                  ...state.activeConversation,
                  usage,
                }
              : state.activeConversation,
          }));
          return;
        }

        if (event.type === "assistant_done" && event.data && typeof event.data === "object") {
          const data = event.data as {
            content?: string;
            usage?: AiConversation["usage"];
            citations?: AiMessage["citations"];
          };

          set((state) => ({
            activeConversation: state.activeConversation
              ? finalizeAssistantMessage(
                  state.activeConversation,
                  data.content ?? "",
                  data.usage,
                  data.citations,
                )
              : state.activeConversation,
          }));
          return;
        }

        if (event.type === "error" && event.message) {
          set({ error: event.message });
        }
      });

      await get().loadConversations();
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to send message",
      });
      throw error;
    } finally {
      set({ chatLoading: false });
    }
  },

  setIntent(intent: AiConversation["intent"]) {
    set((state) => ({
      currentIntent: intent,
      activeConversation: state.activeConversation
        ? { ...state.activeConversation, intent }
        : state.activeConversation,
    }));
  },
}));
