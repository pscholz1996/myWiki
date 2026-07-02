"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { Loader2Icon } from "lucide-react";
import { useGitStore } from "@/stores/git-store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { statusColor, statusLabel } from "@/lib/git/status-format";
import { CommitDiffDialog } from "./commit-diff-dialog";

export function CommitHistoryList() {
  const history = useGitStore((s) => s.history);
  const historyHasMore = useGitStore((s) => s.historyHasMore);
  const historyLoading = useGitStore((s) => s.historyLoading);
  const historyLoadingMore = useGitStore((s) => s.historyLoadingMore);
  const expandedCommit = useGitStore((s) => s.expandedCommit);
  const commitDetail = useGitStore((s) => s.commitDetail);
  const loadHistory = useGitStore((s) => s.loadHistory);
  const toggleExpandCommit = useGitStore((s) => s.toggleExpandCommit);

  const [diffTarget, setDiffTarget] = useState<{
    hash: string;
    path: string;
  } | null>(null);

  useEffect(() => {
    if (history.length === 0 && !historyLoading) {
      void loadHistory(true);
    }
    // Fetch once on first mount (the parent only mounts this when the
    // History section is expanded) — not on every history/loading change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (historyLoading) {
    return (
      <div className="flex items-center justify-center py-3">
        <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="px-3 py-2 text-muted-foreground text-xs">
        No commits yet
      </div>
    );
  }

  return (
    <div className="pb-1">
      {history.map((commit) => {
        const detail = commitDetail.get(commit.hash);
        const isExpanded = expandedCommit === commit.hash;

        return (
          <div key={commit.hash}>
            <button
              onClick={() => toggleExpandCommit(commit.hash)}
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-sidebar-accent/50"
            >
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {commit.shortHash}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs">
                {commit.message}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {formatDistanceToNowStrict(new Date(commit.date), {
                  addSuffix: true,
                })}
              </span>
            </button>

            {isExpanded && (
              <div className="pb-1 pl-6">
                {!detail ? (
                  <div className="flex items-center py-1">
                    <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
                  </div>
                ) : detail.files.length === 0 ? (
                  <div className="py-1 text-[10px] text-muted-foreground">
                    No file changes
                  </div>
                ) : (
                  detail.files.map((file) => (
                    <button
                      key={file.path}
                      onClick={() =>
                        setDiffTarget({ hash: commit.hash, path: file.path })
                      }
                      className="flex w-full items-center gap-1.5 rounded-md py-0.5 pr-1 text-left hover:bg-sidebar-accent/50"
                    >
                      <span className="min-w-0 flex-1 truncate text-[11px]">
                        {file.path.split("/").pop()}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 font-mono text-[10px]",
                          statusColor(file.status),
                        )}
                      >
                        {statusLabel(file.status)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}

      {historyHasMore && (
        <div className="px-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-full text-[10px]"
            onClick={() => loadHistory(false)}
            disabled={historyLoadingMore}
          >
            {historyLoadingMore ? (
              <Loader2Icon className="mr-1 size-3 animate-spin" />
            ) : null}
            Load more
          </Button>
        </div>
      )}

      {diffTarget && (
        <CommitDiffDialog
          hash={diffTarget.hash}
          path={diffTarget.path}
          onClose={() => setDiffTarget(null)}
        />
      )}
    </div>
  );
}
