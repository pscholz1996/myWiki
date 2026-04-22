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
} from "lucide-react";
import { useGitStore } from "@/stores/git-store";
import { useEditorStore } from "@/stores/editor-store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { GitFileStatus } from "@/lib/git/git-client";

function statusLabel(status: GitFileStatus): string {
  switch (status) {
    case "staged":
      return "A";
    case "staged-modified":
      return "M";
    case "staged-deleted":
      return "D";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "untracked":
      return "?";
    case "renamed":
      return "R";
    case "conflicted":
      return "C";
    default:
      return "?";
  }
}

function statusColor(status: GitFileStatus): string {
  switch (status) {
    case "staged":
    case "staged-modified":
    case "staged-deleted":
    case "renamed":
      return "text-green-500";
    case "modified":
      return "text-yellow-500";
    case "deleted":
      return "text-red-400";
    case "untracked":
      return "text-green-700 dark:text-green-400";
    case "conflicted":
      return "text-red-500";
    default:
      return "text-muted-foreground";
  }
}

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
  const remote = useGitStore((s) => s.remote);
  const actionLoading = useGitStore((s) => s.actionLoading);
  const ahead = useGitStore((s) => s.ahead);
  const behind = useGitStore((s) => s.behind);

  const [commitMsg, setCommitMsg] = useState("");

  if (!isGitRepo) {
    return (
      <div className="px-3 py-2 text-muted-foreground text-xs">
        Not a git repository
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
    </div>
  );
}
