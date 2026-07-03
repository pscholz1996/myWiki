import { create } from "zustand";
import type {
  AiChatRequest,
  AiChatStreamEvent,
  AiCompactionNotice,
  AiConversation,
  AiManifest,
  AiMessage,
  AiPlanUsage,
  AiRejectedSourceFile,
  AiSourceRecord,
  AiUploadProgressEvent,
  AiUploadWarning,
} from "@/lib/ai/types";
import { MAIN_CONVERSATION_ID } from "@/lib/ai/types";
import {
  clearAiConversation,
  deleteAiSource,
  deleteAiSources,
  fetchAiConversation,
  fetchAiManifest,
  fetchPlanUsage,
  streamAiChat,
  updateAiSourceMetadata,
  uploadAiSources,
} from "@/lib/ai/ai-client";

interface AiState {
  manifest: AiManifest | null;
  sources: AiSourceRecord[];
  activeConversation: AiConversation | null;
  currentSourceIds: string[];
  loading: boolean;
  error: string | null;
  actionLoading: boolean;
  chatLoading: boolean;
  uploadProgress: AiUploadProgressEvent | null;
  compactionNotice: AiCompactionNotice | null;
  planUsage: AiPlanUsage | null;
  dismissCompactionNotice: () => void;
  loadSources: () => Promise<void>;
  loadConversation: () => Promise<void>;
  loadPlanUsage: () => Promise<void>;
  uploadSources: (
    files: File[],
  ) => Promise<{ rejected: AiRejectedSourceFile[]; warnings: AiUploadWarning[] }>;
  removeSource: (sourceId: string) => Promise<void>;
  removeSources: (sourceIds: string[]) => Promise<void>;
  editSourceMetadata: (
    sourceId: string,
    updates: { title: string; authors: string[]; year: string },
  ) => Promise<void>;
  clearConversation: () => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  toggleSourceSelection: (sourceId: string) => void;
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
  cumulativeUsage?: AiConversation["usage"],
  citations?: AiMessage["citations"],
  contextTokens?: number,
): AiConversation {
  const messages = [...conversation.messages];
  const last = messages[messages.length - 1];

  // cumulativeUsage is the whole conversation's running total (see
  // chat/route.ts), not this one message's usage — it belongs on the
  // conversation, not the message. No per-message usage display exists
  // today, so the message itself is finalized without a usage field.
  if (last?.role === "assistant") {
    messages[messages.length - 1] = {
      ...last,
      content,
      citations,
    };
  } else {
    messages.push({ ...makeAssistantMessage(content), citations });
  }

  return { ...conversation, messages, usage: cumulativeUsage, contextTokens };
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
  activeConversation: null,
  currentSourceIds: [],
  loading: false,
  error: null,
  actionLoading: false,
  chatLoading: false,
  uploadProgress: null,
  compactionNotice: null,
  planUsage: null,

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

  async loadConversation() {
    set({ loading: true, error: null });
    try {
      const conversation = await fetchAiConversation();
      set({
        activeConversation: conversation,
        currentSourceIds: conversation?.sourceIds ?? [],
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

  // Best-effort: null (no live SDK session yet, e.g. before the first
  // message of a server run) is a normal result, not an error, so failures
  // here are swallowed rather than surfaced as a user-facing error toast.
  async loadPlanUsage() {
    try {
      const planUsage = await fetchPlanUsage();
      set({ planUsage });
    } catch {
      set({ planUsage: null });
    }
  },

  async uploadSources(files: File[]) {
    const token = ++sourcesOpSeq;
    set({ actionLoading: true, error: null, uploadProgress: null });
    try {
      const { rejected, warnings, ...manifest } = await uploadAiSources(
        files,
        (event) => {
          if (token === sourcesOpSeq) set({ uploadProgress: event });
        },
      );
      if (token !== sourcesOpSeq) return { rejected, warnings };
      set({ manifest, sources: manifest.sources });
      return { rejected, warnings };
    } catch (error) {
      if (token !== sourcesOpSeq) return { rejected: [], warnings: [] };
      set({
        error:
          error instanceof Error ? error.message : "Failed to upload sources",
      });
      throw error;
    } finally {
      if (token === sourcesOpSeq) set({ actionLoading: false, uploadProgress: null });
    }
  },

  async removeSource(sourceId: string) {
    const token = ++sourcesOpSeq;
    set({ actionLoading: true, error: null });
    try {
      const manifest = await deleteAiSource(sourceId);
      if (token !== sourcesOpSeq) return;
      set((state) => ({
        manifest,
        sources: manifest.sources,
        // Drop the deleted source from any active selection so the "N
        // selected" count and the search scope don't silently reference a
        // source that no longer exists.
        currentSourceIds: state.currentSourceIds.filter((id) => id !== sourceId),
        activeConversation: state.activeConversation
          ? {
              ...state.activeConversation,
              sourceIds: state.activeConversation.sourceIds.filter(
                (id) => id !== sourceId,
              ),
            }
          : state.activeConversation,
      }));
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

  async removeSources(sourceIds: string[]) {
    const token = ++sourcesOpSeq;
    set({ actionLoading: true, error: null });
    try {
      const manifest = await deleteAiSources(sourceIds);
      if (token !== sourcesOpSeq) return;
      const removedIds = new Set(sourceIds);
      set((state) => ({
        manifest,
        sources: manifest.sources,
        currentSourceIds: state.currentSourceIds.filter((id) => !removedIds.has(id)),
        activeConversation: state.activeConversation
          ? {
              ...state.activeConversation,
              sourceIds: state.activeConversation.sourceIds.filter(
                (id) => !removedIds.has(id),
              ),
            }
          : state.activeConversation,
      }));
    } catch (error) {
      if (token !== sourcesOpSeq) return;
      set({
        error:
          error instanceof Error ? error.message : "Failed to delete sources",
      });
      throw error;
    } finally {
      if (token === sourcesOpSeq) set({ actionLoading: false });
    }
  },

  async editSourceMetadata(sourceId, updates) {
    const token = ++sourcesOpSeq;
    set({ actionLoading: true, error: null });
    try {
      const updated = await updateAiSourceMetadata(sourceId, updates);
      if (token !== sourcesOpSeq) return;
      set((state) => {
        const sources = state.sources.map((source) =>
          source.id === sourceId ? updated : source,
        );
        return {
          sources,
          manifest: state.manifest ? { ...state.manifest, sources } : state.manifest,
        };
      });
    } catch (error) {
      if (token !== sourcesOpSeq) return;
      set({
        error:
          error instanceof Error ? error.message : "Failed to update source",
      });
      throw error;
    } finally {
      if (token === sourcesOpSeq) set({ actionLoading: false });
    }
  },

  // Deletes the persisted conversation so the next message starts a
  // genuinely fresh Claude Agent SDK session — there's only ever one
  // conversation, so "clear" is the only reset this app offers instead of
  // switching to a different one.
  async clearConversation() {
    set({ actionLoading: true, error: null });
    try {
      await clearAiConversation();
      // The live SDK session is closed server-side along with the
      // conversation file (see DELETE /api/ai/conversation) — usage data
      // won't be available again until the next message starts a new one.
      set({ activeConversation: null, planUsage: null });
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to clear conversation",
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

    const activeConversation: AiConversation = get().activeConversation ?? {
      id: MAIN_CONVERSATION_ID,
      model: "claude-sonnet-5",
      // Optimistic placeholder only — never sent to the server (AiChatRequest
      // has no sdkSessionId field) and overwritten once the real conversation
      // reloads. Still a real UUID, not MAIN_CONVERSATION_ID, so nothing that
      // reads this client-side object mistakes it for a valid SDK session id.
      sdkSessionId: newId(),
      messages: [],
      sourceIds: get().currentSourceIds,
      updatedAt: nowIso(),
    };

    const userMessage = makeUserMessage(trimmed);
    const nextConversation: AiConversation = {
      ...activeConversation,
      messages: [...activeConversation.messages, userMessage],
      updatedAt: nowIso(),
    };

    set({ activeConversation: nextConversation });

    const request: AiChatRequest = {
      message: trimmed,
      sourceIds: nextConversation.sourceIds,
      model: nextConversation.model,
    };

    try {
      await streamAiChat(request, (event: AiChatStreamEvent) => {
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
          const data = event.data as {
            usage?: AiConversation["usage"];
            contextTokens?: number;
          };
          set((state) => ({
            activeConversation: state.activeConversation
              ? {
                  ...state.activeConversation,
                  usage: data.usage,
                  contextTokens: data.contextTokens,
                }
              : state.activeConversation,
          }));
          return;
        }

        if (event.type === "compacted" && event.data && typeof event.data === "object") {
          set({ compactionNotice: event.data as AiCompactionNotice });
          return;
        }

        if (event.type === "assistant_done" && event.data && typeof event.data === "object") {
          const data = event.data as {
            content?: string;
            usage?: AiConversation["usage"];
            citations?: AiMessage["citations"];
            contextTokens?: number;
          };

          set((state) => ({
            activeConversation: state.activeConversation
              ? finalizeAssistantMessage(
                  state.activeConversation,
                  data.content ?? "",
                  data.usage,
                  data.citations,
                  data.contextTokens,
                )
              : state.activeConversation,
          }));
          return;
        }

        if (event.type === "error" && event.message) {
          set({ error: event.message });
        }
      });

      // The live SDK session only exists once a turn has actually run, so
      // this is the earliest point plan usage becomes available — refresh
      // it opportunistically rather than waiting for the next full mount.
      void get().loadPlanUsage();
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

  toggleSourceSelection(sourceId: string) {
    set((state) => {
      const base = state.activeConversation?.sourceIds ?? state.currentSourceIds;
      const nextSourceIds = base.includes(sourceId)
        ? base.filter((id) => id !== sourceId)
        : [...base, sourceId];

      return {
        currentSourceIds: nextSourceIds,
        activeConversation: state.activeConversation
          ? { ...state.activeConversation, sourceIds: nextSourceIds }
          : state.activeConversation,
      };
    });
  },

  dismissCompactionNotice() {
    set({ compactionNotice: null });
  },
}));
