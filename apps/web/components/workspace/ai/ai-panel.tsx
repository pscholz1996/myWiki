"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
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
  BookOpenIcon,
  FileTextIcon,
  FolderPlusIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  PencilLineIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import type { AiConversation } from "@/lib/ai/types";
import { toast } from "sonner";

export function AiPanel() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");

  const manifest = useAiStore((state) => state.manifest);
  const sources = useAiStore((state) => state.sources);
  const conversations = useAiStore((state) => state.conversations);
  const activeConversation = useAiStore((state) => state.activeConversation);
  const activeConversationId = useAiStore(
    (state) => state.activeConversationId,
  );
  const currentIntent = useAiStore((state) => state.currentIntent);
  const loading = useAiStore((state) => state.loading);
  const error = useAiStore((state) => state.error);
  const actionLoading = useAiStore((state) => state.actionLoading);
  const chatLoading = useAiStore((state) => state.chatLoading);
  const loadSources = useAiStore((state) => state.loadSources);
  const loadConversations = useAiStore((state) => state.loadConversations);
  const uploadSources = useAiStore((state) => state.uploadSources);
  const removeSource = useAiStore((state) => state.removeSource);
  const createConversation = useAiStore((state) => state.createConversation);
  const selectConversation = useAiStore((state) => state.selectConversation);
  const sendMessage = useAiStore((state) => state.sendMessage);
  const setIntent = useAiStore((state) => state.setIntent);

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

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleNewConversation = async () => {
    await createConversation();
    setDraft("");
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
      await uploadSources(files);
      toast.success(
        `Uploaded ${files.length} source${files.length === 1 ? "" : "s"}`,
      );
    } catch {
      // Store already captures the error.
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
        </div>
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <BadgeInfoIcon className="size-3.5" />
          {activeConversation?.usage
            ? `${activeConversation.usage.inputTokens} in · ${activeConversation.usage.outputTokens} out`
            : "Token usage pending"}
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

          <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
            {sources.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-4 text-center text-muted-foreground text-xs">
                Add a source to start building the knowledge base.
              </div>
            ) : (
              sources.map((source) => (
                <div
                  key={source.id}
                  className="flex items-start justify-between gap-3 rounded-md border bg-background px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <FileTextIcon className="size-3.5 text-muted-foreground" />
                      <div className="truncate font-medium text-sm">
                        {source.originalName}
                      </div>
                    </div>
                    <div className="mt-1 text-muted-foreground text-xs">
                      {source.kind.toUpperCase()} ·{" "}
                      {Math.round(source.bytes / 1024)} KB
                      {typeof source.pageCount === "number"
                        ? ` · ${source.pageCount} pages`
                        : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2 text-muted-foreground"
                    onClick={() =>
                      void handleDeleteSource(source.id, source.originalName)
                    }
                    disabled={actionLoading}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
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
                <div className="whitespace-pre-wrap text-sm leading-6">
                  {message.content ||
                    (message.role === "assistant" ? "Thinking..." : "")}
                </div>
                {message.citations && message.citations.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5 border-t border-current/10 pt-2">
                    {message.citations.map((citation, index) => (
                      <a
                        key={`${citation.sourceId}-${citation.page}-${index}`}
                        href={`/api/ai/sources/${citation.sourceId}/file#page=${citation.page}`}
                        target="_blank"
                        rel="noreferrer"
                        title={citation.quote}
                        className="inline-flex items-center gap-1 rounded-full border bg-background/80 px-2 py-0.5 text-[11px] text-foreground/80 hover:bg-background"
                      >
                        <BookOpenIcon className="size-3" />
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
