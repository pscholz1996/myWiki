"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUpIcon,
  FolderOpenIcon,
  LibraryBigIcon,
  Loader2Icon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  ShieldCheckIcon,
  SquarePenIcon,
  SunIcon,
} from "lucide-react";
import { SiClaude } from "@icons-pack/react-simple-icons";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { ClaudeAccountMenu } from "@/components/account/claude-account-menu";
import { DirectoryBrowserModal } from "@/components/project/directory-browser-modal";
import { useAiStore } from "@/stores/ai-store";
import type { AiPlanUsage } from "@/lib/ai/types";
import { basename } from "@/lib/project/path-utils";
import { AiMarkdown } from "./markdown";
import { SourcesDialog } from "./sources-dialog";

// "in 2h 44m" / "in 44m" — a short countdown to a reset timestamp, matching
// the Claude app's own usage view rather than a full date/time.
function formatResetCountdown(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "shortly";
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `in ${minutes}m`;
  if (minutes === 0) return `in ${hours}h`;
  return `in ${hours}h ${minutes}m`;
}

// "Wed 21:00" — the weekly window resets days out, so an absolute day+time
// is more useful than a countdown.
function formatResetDayTime(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function UsageRows({ planUsage }: { planUsage: AiPlanUsage | null }) {
  if (!planUsage || (!planUsage.fiveHour && !planUsage.sevenDay)) {
    return (
      <div className="px-2 py-1.5 text-muted-foreground text-xs">
        {planUsage
          ? "Plan usage limits aren't available for this account."
          : "Usage appears here after your first message."}
      </div>
    );
  }

  const rows = [
    planUsage.fiveHour
      ? {
          label: "Session",
          percent: planUsage.fiveHour.utilization,
          reset: formatResetCountdown(planUsage.fiveHour.resetsAt),
        }
      : null,
    planUsage.sevenDay
      ? {
          label: "Week",
          percent: planUsage.sevenDay.utilization,
          reset: formatResetDayTime(planUsage.sevenDay.resetsAt),
        }
      : null,
  ].filter((row): row is NonNullable<typeof row> => row !== null);

  return (
    <div className="grid gap-2 px-2 py-1.5">
      {rows.map((row) => {
        const clamped = Math.min(100, Math.max(0, Math.round(row.percent)));
        return (
          <div key={row.label} className="grid gap-1">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span>{row.label}</span>
              <span className="text-muted-foreground">
                {clamped}%{row.reset ? ` · resets ${row.reset}` : ""}
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${clamped}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Rotating status words shown while a turn is running but no assistant text
// has appeared yet — tool-call-heavy turns (searching the knowledge base,
// reading sources) can easily run 20-30s before the first visible token.
const THINKING_WORDS = [
  "Thinking",
  "Searching",
  "Reading",
  "Cross-referencing",
  "Synthesizing",
  "Considering",
];

function ThinkingIndicator() {
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setWordIndex((index) => (index + 1) % THINKING_WORDS.length);
    }, 1800);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-2 text-muted-foreground text-sm">
      <Loader2Icon className="size-3.5 animate-spin" />
      {THINKING_WORDS[wordIndex]}…
    </div>
  );
}

function Composer({
  draft,
  onDraftChange,
  onSend,
  sending,
  autoFocus,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className="rounded-2xl border bg-background shadow-sm transition-shadow focus-within:shadow-md">
      <Textarea
        className="max-h-48 min-h-14 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        placeholder="Ask your wiki anything…"
        value={draft}
        autoFocus={autoFocus}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <div className="flex items-center justify-between px-3 pb-2.5">
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
          {/* Claude's own brand color — the surrounding text stays muted,
              but the logo itself shouldn't inherit that and go monochrome. */}
          <SiClaude className="size-3.5" color="#D97757" />
          Powered by Claude
        </div>
        <Button
          size="icon"
          className="size-8 rounded-full"
          onClick={onSend}
          disabled={sending || !draft.trim()}
          title="Send"
        >
          {sending ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <ArrowUpIcon className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

async function switchWikiFolder(path: string): Promise<void> {
  const res = await fetch("/api/project/set", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
    };
    throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
  }
  window.location.reload();
}

interface ChatAppProps {
  current: string;
}

export function ChatApp({ current }: ChatAppProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const sources = useAiStore((state) => state.sources);
  const activeConversation = useAiStore((state) => state.activeConversation);
  const error = useAiStore((state) => state.error);
  const actionLoading = useAiStore((state) => state.actionLoading);
  const chatLoading = useAiStore((state) => state.chatLoading);
  const planUsage = useAiStore((state) => state.planUsage);
  const loadSources = useAiStore((state) => state.loadSources);
  const loadConversation = useAiStore((state) => state.loadConversation);
  const loadPlanUsage = useAiStore((state) => state.loadPlanUsage);
  const clearConversation = useAiStore((state) => state.clearConversation);
  const sendMessage = useAiStore((state) => state.sendMessage);
  const compactionNotice = useAiStore((state) => state.compactionNotice);
  const dismissCompactionNotice = useAiStore(
    (state) => state.dismissCompactionNotice,
  );

  const messages = activeConversation?.messages ?? [];
  const hasMessages = messages.length > 0;

  const sourceNameById = new Map(
    sources.map((source) => [source.id, source.originalName]),
  );

  // A turn's first assistant_chunk is what actually creates its message
  // entry — until then, a tool-call-heavy turn leaves the last message as
  // the user's own, with nothing on screen showing work is happening.
  const isAwaitingFirstToken =
    chatLoading && messages[messages.length - 1]?.role === "user";

  useEffect(() => {
    void Promise.all([loadSources(), loadConversation(), loadPlanUsage()]);
  }, [loadConversation, loadPlanUsage, loadSources]);

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  // Follow the conversation by scrolling ONLY the message list — never
  // scrollIntoView, which also scrolls every scrollable ancestor (including
  // the page itself) and was what let the view travel past the composer.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [activeConversation?.messages, chatLoading]);

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

  const handleSend = () => {
    const message = draft.trim();
    if (!message || chatLoading) return;
    setDraft("");
    void sendMessage(message).catch(() => {
      // Store already captures the error.
    });
  };

  const handleNewChat = async () => {
    if (!hasMessages) return;
    const confirmed = window.confirm(
      "Start a new chat? The current conversation will be deleted.",
    );
    if (!confirmed) return;
    try {
      await clearConversation();
    } catch {
      // Store already captures the error.
    }
  };

  const composer = (
    <Composer
      draft={draft}
      onDraftChange={setDraft}
      onSend={handleSend}
      sending={chatLoading}
      autoFocus
    />
  );

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm">myWiki</span>
          <span className="text-muted-foreground text-xs">
            {basename(current)}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <TooltipIconButton
            tooltip="New chat"
            onClick={() => void handleNewChat()}
            disabled={!hasMessages || actionLoading || chatLoading}
          >
            <SquarePenIcon className="size-4" />
          </TooltipIconButton>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => setSourcesOpen(true)}
          >
            <LibraryBigIcon className="size-4" />
            Sources
            {sources.length > 0 ? (
              <span className="rounded-full bg-muted px-1.5 text-muted-foreground text-xs tabular-nums">
                {sources.length}
              </span>
            ) : null}
          </Button>
          {mounted && (
            <TooltipIconButton
              tooltip={
                theme === "system"
                  ? "System theme"
                  : theme === "light"
                    ? "Light mode"
                    : "Dark mode"
              }
              onClick={() => {
                if (theme === "system") setTheme("light");
                else if (theme === "light") setTheme("dark");
                else setTheme("system");
              }}
            >
              {theme === "system" ? (
                <MonitorIcon className="size-4" />
              ) : theme === "light" ? (
                <SunIcon className="size-4" />
              ) : (
                <MoonIcon className="size-4" />
              )}
            </TooltipIconButton>
          )}
          <ClaudeAccountMenu />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8">
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="text-xs">Usage</DropdownMenuLabel>
              <UsageRows planUsage={planUsage} />
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="truncate font-mono text-muted-foreground text-xs">
                {current}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setBrowseOpen(true)}>
                <FolderOpenIcon className="mr-2 size-4" />
                Change knowledge folder…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {hasMessages ? (
        <>
          <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
              {messages.map((message) =>
                message.role === "user" ? (
                  <div
                    key={message.id}
                    className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2.5 text-sm leading-6"
                  >
                    {message.content}
                  </div>
                ) : (
                  <div key={message.id} className="max-w-full">
                    {message.content ? (
                      <AiMarkdown content={message.content} />
                    ) : null}
                    {message.citations && message.citations.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {message.citations.map((citation, index) => (
                          <a
                            key={`${citation.sourceId}-${citation.page}-${index}`}
                            href={`/api/ai/sources/${citation.sourceId}/file#page=${citation.page}`}
                            target="_blank"
                            rel="noreferrer"
                            title={`Verified quote: "${citation.quote}"`}
                            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
                ),
              )}
              {isAwaitingFirstToken ? <ThinkingIndicator /> : null}
            </div>
          </div>
          <div className="shrink-0 px-4 pb-4">
            <div className="mx-auto w-full max-w-3xl">{composer}</div>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <div className="w-full max-w-2xl space-y-6 pb-24">
            <div className="space-y-1.5 text-center">
              <h1 className="font-semibold text-2xl tracking-tight">
                What do you want to know?
              </h1>
              <p className="text-muted-foreground text-sm">
                {sources.length > 0
                  ? `Answers drawn from your ${sources.length} source${sources.length === 1 ? "" : "s"} — with tables, equations, and diagrams when they help.`
                  : "Add sources to give myWiki something to know, or just ask away."}
              </p>
            </div>
            {composer}
          </div>
        </div>
      )}

      <SourcesDialog open={sourcesOpen} onOpenChange={setSourcesOpen} />
      <DirectoryBrowserModal
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(p) => {
          setBrowseOpen(false);
          void switchWikiFolder(p).catch((error) =>
            toast.error(
              error instanceof Error ? error.message : "Failed to switch folder",
            ),
          );
        }}
      />
    </div>
  );
}
