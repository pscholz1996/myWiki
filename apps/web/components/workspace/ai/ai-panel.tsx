"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useAiStore } from "@/stores/ai-store";
import {
  BadgeInfoIcon,
  FolderPlusIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  PencilLineIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  ShieldCheckIcon,
} from "lucide-react";
import { SiClaude } from "@icons-pack/react-simple-icons";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  type AiConversation,
  type AiSourceRecord,
  type AiUploadProgressEvent,
} from "@/lib/ai/types";
import { toast } from "sonner";
import { AiMarkdown } from "./markdown";
import { SourceListItem } from "./source-list-item";

// Embedding is the dominant, least predictable cost for a large source, so
// it gets the bulk of the bar (20-95%) with real per-batch granularity;
// saving/extracting/verifying and the final index write are comparatively
// fast and only ever have coarse (per-file, or no) granularity to report.
function describeUploadProgress(
  event: AiUploadProgressEvent,
): { label: string; percent: number } {
  switch (event.stage) {
    case "saving":
      return {
        label: `Saving ${event.fileName} (${event.fileIndex + 1}/${event.fileCount})…`,
        percent: (event.fileIndex / Math.max(event.fileCount, 1)) * 10,
      };
    case "extracting":
      return {
        label: `Extracting text from ${event.fileName} (${event.fileIndex + 1}/${event.fileCount})…`,
        percent: (event.fileIndex / Math.max(event.fileCount, 1)) * 10,
      };
    case "verifying":
      return {
        label: `Looking up ${event.fileName} in CrossRef (${event.fileIndex + 1}/${event.fileCount})…`,
        percent: 10 + (event.fileIndex / Math.max(event.fileCount, 1)) * 10,
      };
    case "embedding":
      return {
        label: `Embedding chunks (${event.chunksDone}/${event.chunksTotal})…`,
        percent:
          20 +
          (event.chunksTotal > 0 ? event.chunksDone / event.chunksTotal : 1) * 75,
      };
    case "indexing":
      return { label: "Writing index…", percent: 98 };
  }
}

type SourceSortMode = "recent" | "title" | "author" | "year";

function matchesSourceQuery(source: AiSourceRecord, query: string): boolean {
  if (!query) return true;
  const haystack = [
    source.metadata?.title,
    source.originalName,
    source.metadata?.authors?.join(" "),
    source.metadata?.year,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

// Missing values always sink to the end regardless of sort direction —
// otherwise an empty title/author/year would sort first (as "" precedes
// any real string/number) and clutter the top of an alphabetical list.
function sortSources(list: AiSourceRecord[], mode: SourceSortMode): AiSourceRecord[] {
  const copy = [...list];
  switch (mode) {
    case "title":
      return copy.sort((a, b) =>
        (a.metadata?.title ?? a.originalName).localeCompare(
          b.metadata?.title ?? b.originalName,
        ),
      );
    case "author": {
      const authorOf = (s: AiSourceRecord) => s.metadata?.authors?.[0];
      return copy.sort((a, b) => {
        const authorA = authorOf(a);
        const authorB = authorOf(b);
        if (!authorA && !authorB) return 0;
        if (!authorA) return 1;
        if (!authorB) return -1;
        return authorA.localeCompare(authorB);
      });
    }
    case "year": {
      const yearOf = (s: AiSourceRecord) => Number(s.metadata?.year) || -Infinity;
      return copy.sort((a, b) => yearOf(b) - yearOf(a));
    }
    case "recent":
    default:
      return copy.sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
  }
}

export function AiPanel() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceSort, setSourceSort] = useState<SourceSortMode>("recent");

  const manifest = useAiStore((state) => state.manifest);
  const sources = useAiStore((state) => state.sources);
  const conversations = useAiStore((state) => state.conversations);
  const activeConversation = useAiStore((state) => state.activeConversation);
  const activeConversationId = useAiStore(
    (state) => state.activeConversationId,
  );
  const currentIntent = useAiStore((state) => state.currentIntent);
  const currentSourceIds = useAiStore((state) => state.currentSourceIds);
  const loading = useAiStore((state) => state.loading);
  const error = useAiStore((state) => state.error);
  const actionLoading = useAiStore((state) => state.actionLoading);
  const chatLoading = useAiStore((state) => state.chatLoading);
  const uploadProgress = useAiStore((state) => state.uploadProgress);
  const loadSources = useAiStore((state) => state.loadSources);
  const loadConversations = useAiStore((state) => state.loadConversations);
  const uploadSources = useAiStore((state) => state.uploadSources);
  const removeSource = useAiStore((state) => state.removeSource);
  const editSourceMetadata = useAiStore((state) => state.editSourceMetadata);
  const createConversation = useAiStore((state) => state.createConversation);
  const selectConversation = useAiStore((state) => state.selectConversation);
  const removeConversation = useAiStore((state) => state.removeConversation);
  const sendMessage = useAiStore((state) => state.sendMessage);
  const setIntent = useAiStore((state) => state.setIntent);
  const toggleSourceSelection = useAiStore((state) => state.toggleSourceSelection);
  const compactionNotice = useAiStore((state) => state.compactionNotice);
  const dismissCompactionNotice = useAiStore(
    (state) => state.dismissCompactionNotice,
  );

  const selectedSourceIds = activeConversation?.sourceIds ?? currentSourceIds;

  const visibleSources = sortSources(
    sources.filter((source) =>
      matchesSourceQuery(source, sourceQuery.trim().toLowerCase()),
    ),
    sourceSort,
  );

  const sourceNameById = new Map(
    sources.map((source) => [source.id, source.originalName]),
  );

  useEffect(() => {
    void Promise.all([loadSources(), loadConversations()]);
  }, [loadConversations, loadSources]);

  useEffect(() => {
    if (error) {
      toast.error(error);
    }
  }, [error]);

  useEffect(() => {
    if (!compactionNotice) return;
    const { preTokens, postTokens } = compactionNotice;
    const detail =
      typeof preTokens === "number" && typeof postTokens === "number"
        ? `${preTokens.toLocaleString()} → ${postTokens.toLocaleString()} tokens`
        : undefined;
    toast.info("Conversation history was compacted to stay in context", {
      description: detail,
    });
    dismissCompactionNotice();
  }, [compactionNotice, dismissCompactionNotice]);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleNewConversation = async () => {
    await createConversation();
    setDraft("");
  };

  const handleDeleteConversation = async () => {
    if (!activeConversationId) return;
    const title = activeConversation?.title ?? "this conversation";
    const confirmed = window.confirm(`Delete "${title}"?`);
    if (!confirmed) return;

    try {
      await removeConversation(activeConversationId);
      toast.success(`Deleted "${title}"`);
    } catch {
      // Store already captures the error.
    }
  };

  const handleSend = async () => {
    const message = draft.trim();
    if (!message) return;

    setDraft("");
    try {
      await sendMessage(message);
    } catch {
      // Store already captures the error.
    }
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    try {
      const rejected = await uploadSources(files);
      const acceptedCount = files.length - rejected.length;

      if (acceptedCount > 0) {
        toast.success(
          `Uploaded ${acceptedCount} source${acceptedCount === 1 ? "" : "s"}`,
        );
      }
      for (const file of rejected) {
        toast.error(`Skipped ${file.name}`, { description: file.reason });
      }
    } catch {
      // Store already captures the error (e.g. every file was rejected).
    }
  };

  const handleDeleteSource = async (sourceId: string, name: string) => {
    const confirmed = window.confirm(`Delete ${name} from the knowledge base?`);
    if (!confirmed) return;

    try {
      await removeSource(sourceId);
      toast.success(`Deleted ${name}`);
    } catch {
      // Store already captures the error.
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col border-l bg-background/95">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <div>
          <div className="font-medium text-sm">AI Workspace</div>
          <div className="text-muted-foreground text-xs">
            Research, write, and verify against your sources.
          </div>
          <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/70">
            <SiClaude className="size-2.5" />
            Powered by Claude
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-muted-foreground text-xs">
          <div className="flex items-center gap-2">
            <BadgeInfoIcon className="size-3.5" />
            {activeConversation?.usage
              ? `${activeConversation.usage.inputTokens.toLocaleString()} in · ${activeConversation.usage.outputTokens.toLocaleString()} out`
              : "Token usage pending"}
          </div>
          {activeConversation?.contextTokens ? (
            <div
              title="Estimated from the most recent turn's input + cached tokens against Sonnet 5's 1M context window — not an exact figure."
            >
              ~{Math.min(
                100,
                Math.round(
                  (activeConversation.contextTokens / DEFAULT_CONTEXT_WINDOW_TOKENS) * 100,
                ),
              )}
              % of context window ({activeConversation.contextTokens.toLocaleString()} tokens)
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-3 border-b p-3">
        <div className="grid gap-1.5">
          <div className="font-medium text-muted-foreground text-xs">
            Intent
          </div>
          <Select
            value={currentIntent}
            onValueChange={(value) =>
              setIntent(value as AiConversation["intent"])
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select intent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="research">
                <span className="flex items-center gap-2">
                  <SearchIcon className="size-3.5" /> Research
                </span>
              </SelectItem>
              <SelectItem value="write">
                <span className="flex items-center gap-2">
                  <PencilLineIcon className="size-3.5" /> Write
                </span>
              </SelectItem>
              <SelectItem value="organize">
                <span className="flex items-center gap-2">
                  <SparklesIcon className="size-3.5" /> Organize
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <div className="font-medium text-muted-foreground text-xs">
            Conversation
          </div>
          <div className="flex gap-2">
            <Select
              value={activeConversationId ?? "new"}
              onValueChange={(value) => {
                if (value === "new") {
                  void handleNewConversation();
                  return;
                }
                void selectConversation(value);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Start a conversation" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">New conversation</SelectItem>
                {conversations.map((conversation) => (
                  <SelectItem key={conversation.id} value={conversation.id}>
                    {conversation.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              size="icon"
              variant="secondary"
              onClick={() => void handleNewConversation()}
            >
              <MessageSquarePlusIcon className="size-4" />
            </Button>

            <Button
              size="icon"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => void handleDeleteConversation()}
              disabled={!activeConversationId || actionLoading}
              aria-label="Delete conversation"
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        </div>

        <div className="grid gap-2 rounded-lg border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="font-medium text-sm">Knowledge Base</div>
              <div className="text-muted-foreground text-xs">
                Upload PDFs or notes. They are copied into .openlatex/ai/sources
                and indexed automatically.
              </div>
            </div>
            <input
              ref={fileInputRef}
              className="hidden"
              type="file"
              accept=".pdf,.md,.txt"
              multiple
              onChange={handleFileChange}
            />
            <Button size="sm" variant="secondary" onClick={handleUploadClick}>
              <FolderPlusIcon className="mr-2 size-4" />
              Upload
            </Button>
          </div>

          <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
            <span>
              {manifest
                ? `${manifest.sources.length} source${manifest.sources.length === 1 ? "" : "s"} · ${manifest.index.chunkCount} chunks`
                : "No indexed sources yet"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => void loadSources()}
              disabled={loading || actionLoading}
            >
              {loading ? (
                <Loader2Icon className="mr-2 size-3.5 animate-spin" />
              ) : null}
              Refresh
            </Button>
          </div>

          {uploadProgress ? (
            <div className="space-y-1.5 rounded-md border bg-muted/40 px-3 py-2">
              <div className="flex items-center gap-2 text-xs">
                <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                <span className="truncate">
                  {describeUploadProgress(uploadProgress).label}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                  style={{
                    width: `${describeUploadProgress(uploadProgress).percent}%`,
                  }}
                />
              </div>
            </div>
          ) : null}

          {sources.length > 0 ? (
            <div className="text-muted-foreground text-xs">
              {selectedSourceIds.length === 0
                ? "No sources checked — chat searches the whole knowledge base."
                : `Chat is scoped to ${selectedSourceIds.length} checked source${selectedSourceIds.length === 1 ? "" : "s"}.`}
            </div>
          ) : null}

          {sources.length > 0 ? (
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2 size-3.5 text-muted-foreground" />
                <Input
                  value={sourceQuery}
                  onChange={(event) => setSourceQuery(event.target.value)}
                  placeholder="Search sources…"
                  className="h-8 pl-7 text-xs"
                />
              </div>
              <Select
                value={sourceSort}
                onValueChange={(value) => setSourceSort(value as SourceSortMode)}
              >
                <SelectTrigger size="sm" className="w-[132px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="recent">Recently added</SelectItem>
                  <SelectItem value="title">Title (A–Z)</SelectItem>
                  <SelectItem value="author">Author (A–Z)</SelectItem>
                  <SelectItem value="year">Year (newest)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
            {sources.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-4 text-center text-muted-foreground text-xs">
                Add a source to start building the knowledge base.
              </div>
            ) : visibleSources.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-4 text-center text-muted-foreground text-xs">
                No sources match &quot;{sourceQuery}&quot;.
              </div>
            ) : (
              visibleSources.map((source) => (
                <SourceListItem
                  key={source.id}
                  source={source}
                  selected={selectedSourceIds.includes(source.id)}
                  onToggleSelected={() => toggleSourceSelection(source.id)}
                  onDelete={() =>
                    void handleDeleteSource(source.id, source.originalName)
                  }
                  deleteDisabled={actionLoading}
                  onSaveMetadata={(updates) =>
                    editSourceMetadata(source.id, updates)
                  }
                />
              ))
            )}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-dashed px-3 py-3">
          {activeConversation?.messages.length ? (
            activeConversation.messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.role === "user"
                    ? "ml-auto max-w-[88%] rounded-2xl bg-primary px-3 py-2 text-primary-foreground"
                    : "mr-auto max-w-[88%] rounded-2xl border bg-background px-3 py-2"
                }
              >
                <div className="mb-1 text-[10px] uppercase tracking-wide opacity-60">
                  {message.role}
                </div>
                {message.role === "assistant" && message.content ? (
                  <AiMarkdown content={message.content} />
                ) : (
                  <div className="whitespace-pre-wrap text-sm leading-6">
                    {message.content ||
                      (message.role === "assistant" ? "Thinking..." : "")}
                  </div>
                )}
                {message.citations && message.citations.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5 border-t border-current/10 pt-2">
                    {message.citations.map((citation, index) => (
                      <a
                        key={`${citation.sourceId}-${citation.page}-${index}`}
                        href={`/api/ai/sources/${citation.sourceId}/file#page=${citation.page}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`Verified quote: "${citation.quote}"`}
                        className="inline-flex items-center gap-1 rounded-full border border-green-600/30 bg-green-600/5 px-2 py-0.5 text-[11px] text-foreground/80 hover:bg-green-600/10 dark:border-green-400/30 dark:bg-green-400/5"
                      >
                        <ShieldCheckIcon className="size-3 text-green-600 dark:text-green-400" />
                        {sourceNameById.get(citation.sourceId) ??
                          "Unknown source"}
                        {" · p."}
                        {citation.page}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <div className="flex flex-1 items-center justify-center text-center text-muted-foreground text-sm">
              Chat history, citations, and source-linked actions will appear
              here.
            </div>
          )}
        </div>

        <Separator />

        <div className="grid gap-2">
          <Textarea
            className="min-h-24 resize-none"
            placeholder="Ask for a literature summary, a verified quote, or an edit to the paper..."
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void handleSend();
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="text-muted-foreground text-xs">
              Sources will be verified against the original PDF before citation.
            </div>
            <Button
              size="sm"
              onClick={() => void handleSend()}
              disabled={chatLoading}
            >
              {chatLoading ? (
                <Loader2Icon className="mr-2 size-4 animate-spin" />
              ) : null}
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
