"use client";

import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { useGitStore } from "@/stores/git-store";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DiffLine, ParsedDiff } from "@/lib/git/diff-format";

function diffLineClass(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "bg-green-500/10 text-green-700 dark:text-green-400";
    case "remove":
      return "bg-red-500/10 text-red-700 dark:text-red-400";
    case "hunk":
      return "text-blue-600 dark:text-blue-400";
    case "meta":
      return "text-muted-foreground";
    default:
      return "";
  }
}

export function CommitDiffDialog({
  hash,
  path,
  onClose,
}: {
  hash: string;
  path: string;
  onClose: () => void;
}) {
  const loadDiff = useGitStore((s) => s.loadDiff);
  const restoreFile = useGitStore((s) => s.restoreFile);

  const [diff, setDiff] = useState<ParsedDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmingRestore, setConfirmingRestore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadDiff(hash, path)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hash, path, loadDiff]);

  const handleRestore = async () => {
    try {
      await restoreFile(hash, path);
      toast.success(
        `Restored ${path.split("/").pop()} from ${hash.slice(0, 8)}`,
      );
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Restore failed");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono font-normal text-sm">
            {path} @ {hash.slice(0, 8)}
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto rounded-md border bg-muted/20">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : diff?.binary ? (
            <div className="px-3 py-4 text-center text-muted-foreground text-xs">
              Binary file — no text diff available
            </div>
          ) : diff && diff.lines.length > 0 ? (
            <pre className="overflow-x-auto p-2 font-mono text-[11px] leading-5">
              {diff.lines.map((line, i) => (
                <div
                  key={i}
                  className={cn("whitespace-pre px-1", diffLineClass(line.kind))}
                >
                  {line.text}
                </div>
              ))}
            </pre>
          ) : (
            <div className="px-3 py-4 text-center text-muted-foreground text-xs">
              No changes
            </div>
          )}
        </div>

        <DialogFooter>
          {confirmingRestore ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingRestore(false)}
              >
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={handleRestore}>
                Confirm restore
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmingRestore(true)}
              disabled={loading || Boolean(diff?.binary)}
            >
              Restore this version
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
