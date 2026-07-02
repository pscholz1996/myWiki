"use client";

import { useState } from "react";
import {
  PlusIcon,
  MinusIcon,
  CheckIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  RefreshCwIcon,
  FileTextIcon,
  Loader2Icon,
  GitBranchPlusIcon,
  ChevronDownIcon,
  HistoryIcon,
} from "lucide-react";
import { useGitStore } from "@/stores/git-store";
import { useEditorStore } from "@/stores/editor-store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { GitFileStatus } from "@/lib/git/git-client";
import { statusColor, statusLabel } from "@/lib/git/status-format";
import { CommitHistoryList } from "./commit-history-list";

function FileEntry({
  path,
  status,
  action,
  actionIcon: ActionIcon,
  actionTitle,
}: {
  path: string;
  status: GitFileStatus;
  action: () => void;
  actionIcon: typeof PlusIcon;
  actionTitle: string;
}) {
  const openFile = useEditorStore((s) => s.openFile);
  const name = path.split("/").pop() ?? path;

  return (
    <div className="group flex items-center gap-1 rounded-md py-0.5 pr-1 pl-2 hover:bg-sidebar-accent/50">
      <button
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        onClick={() => openFile(path)}
      >
        <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn("truncate text-xs", statusColor(status))}>
          {name}
        </span>
      </button>
      <span
        className={cn("shrink-0 font-mono text-[10px]", statusColor(status))}
      >
        {statusLabel(status)}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-5 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          action();
        }}
        title={actionTitle}
      >
        <ActionIcon className="size-3" />
      </Button>
    </div>
  );
}

export function SourceControl() {
  const isGitRepo = useGitStore((s) => s.isGitRepo);
  const fileStatuses = useGitStore((s) => s.fileStatuses);
  const stageFile = useGitStore((s) => s.stageFile);
  const unstageFile = useGitStore((s) => s.unstageFile);
  const commit = useGitStore((s) => s.commit);
  const pull = useGitStore((s) => s.pull);
  const push = useGitStore((s) => s.push);
  const refresh = useGitStore((s) => s.refresh);
  const initRepo = useGitStore((s) => s.initRepo);
  const remote = useGitStore((s) => s.remote);
  const actionLoading = useGitStore((s) => s.actionLoading);
  const ahead = useGitStore((s) => s.ahead);
  const behind = useGitStore((s) => s.behind);

  const [commitMsg, setCommitMsg] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  // Git is entirely optional — a project works fully "offline" without it.
  // This is the one explicit opt-in action; nothing else in the app calls
  // `git init` on its own.
  const handleInit = async () => {
    try {
      await initRepo();
      toast.success("Repository initialized");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to initialize");
    }
  };

  if (!isGitRepo) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
        <div className="text-muted-foreground text-xs">
          This project isn&apos;t a git repository. Version history is
          entirely optional.
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 text-xs"
          onClick={handleInit}
          disabled={actionLoading}
        >
          {actionLoading ? (
            <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <GitBranchPlusIcon className="mr-1.5 size-3.5" />
          )}
          Initialize Repository
        </Button>
      </div>
    );
  }

  const staged: [string, GitFileStatus][] = [];
  const unstaged: [string, GitFileStatus][] = [];
  const untracked: [string, GitFileStatus][] = [];

  for (const [path, status] of fileStatuses) {
    if (
      status === "staged" ||
      status === "staged-modified" ||
      status === "staged-deleted" ||
      status === "renamed"
    ) {
      staged.push([path, status]);
    } else if (status === "untracked") {
      untracked.push([path, status]);
    } else {
      unstaged.push([path, status]);
    }
  }

  const handleCommit = async () => {
    if (!commitMsg.trim()) return;
    try {
      await commit(commitMsg.trim());
      setCommitMsg("");
      toast.success("Changes committed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Commit failed");
    }
  };

  const handlePull = async () => {
    try {
      await pull();
      toast.success("Pull complete");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Pull failed");
    }
  };

  const handlePush = async () => {
    try {
      await push();
      toast.success("Push complete");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Push failed");
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Commit input */}
      <div className="border-sidebar-border border-b p-2">
        <div className="flex gap-1">
          <input
            type="text"
            className="flex-1 rounded-md border border-sidebar-border bg-transparent px-2 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Commit message"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCommit();
            }}
            disabled={actionLoading}
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={handleCommit}
            disabled={actionLoading || !commitMsg.trim() || staged.length === 0}
            title="Commit staged changes"
          >
            {actionLoading ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
          </Button>
        </div>
        {/* Action buttons */}
        <div className="mt-1.5 flex items-center gap-1">
          {remote && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={handlePull}
                disabled={actionLoading}
                title="Pull"
              >
                <ArrowDownIcon className="size-3.5" />
                {behind > 0 && (
                  <span className="ml-0.5 text-[9px]">{behind}</span>
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={handlePush}
                disabled={actionLoading}
                title="Push"
              >
                <ArrowUpIcon className="size-3.5" />
                {ahead > 0 && (
                  <span className="ml-0.5 text-[9px]">{ahead}</span>
                )}
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-6"
            onClick={() => refresh()}
            disabled={actionLoading}
            title="Refresh"
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Staged changes */}
      {staged.length > 0 && (
        <div className="py-1">
          <div className="flex items-center justify-between px-2 py-0.5">
            <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
              Staged ({staged.length})
            </span>
          </div>
          {staged.map(([path, status]) => (
            <FileEntry
              key={path}
              path={path}
              status={status}
              action={() => unstageFile(path)}
              actionIcon={MinusIcon}
              actionTitle="Unstage"
            />
          ))}
        </div>
      )}

      {/* Unstaged changes */}
      {unstaged.length > 0 && (
        <div className="py-1">
          <div className="flex items-center justify-between px-2 py-0.5">
            <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
              Changes ({unstaged.length})
            </span>
          </div>
          {unstaged.map(([path, status]) => (
            <FileEntry
              key={path}
              path={path}
              status={status}
              action={() => stageFile(path)}
              actionIcon={PlusIcon}
              actionTitle="Stage"
            />
          ))}
        </div>
      )}

      {/* Untracked files */}
      {untracked.length > 0 && (
        <div className="py-1">
          <div className="flex items-center justify-between px-2 py-0.5">
            <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
              Untracked ({untracked.length})
            </span>
          </div>
          {untracked.map(([path, status]) => (
            <FileEntry
              key={path}
              path={path}
              status={status}
              action={() => stageFile(path)}
              actionIcon={PlusIcon}
              actionTitle="Stage"
            />
          ))}
        </div>
      )}

      {staged.length === 0 &&
        unstaged.length === 0 &&
        untracked.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground text-xs">
            No changes
          </div>
        )}

      {/* History — collapsed by default, only fetched on first expand */}
      <div className="mt-1 border-sidebar-border border-t">
        <button
          onClick={() => setHistoryOpen((open) => !open)}
          className="flex h-7 w-full items-center gap-1.5 px-2 hover:bg-sidebar-accent/50"
        >
          <ChevronDownIcon
            className={cn(
              "size-3 text-muted-foreground transition-transform",
              !historyOpen && "-rotate-90",
            )}
          />
          <HistoryIcon className="size-3.5 text-muted-foreground" />
          <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
            History
          </span>
        </button>
        {historyOpen && <CommitHistoryList />}
      </div>
    </div>
  );
}
