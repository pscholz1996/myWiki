"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  FolderPlusIcon,
  Loader2Icon,
  SearchIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAiStore } from "@/stores/ai-store";
import type {
  AiSourceRecord,
  AiUploadProgressEvent,
} from "@/lib/ai/types";
import { SourceListItem, sourceNeedsReview } from "./source-list-item";

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
function sortSources(
  list: AiSourceRecord[],
  mode: SourceSortMode,
): AiSourceRecord[] {
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
      const yearOf = (s: AiSourceRecord) =>
        Number(s.metadata?.year) || -Infinity;
      return copy.sort((a, b) => yearOf(b) - yearOf(a));
    }
    case "recent":
    default:
      return copy.sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
  }
}

interface SourcesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The knowledge-base manager, deliberately kept out of the main page: myWiki
 * is chat-first, and sources are background infrastructure the user only
 * occasionally touches (add, remove, fix metadata, scope the chat).
 */
export function SourcesDialog({ open, onOpenChange }: SourcesDialogProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceSort, setSourceSort] = useState<SourceSortMode>("recent");
  const [reviewFilterOn, setReviewFilterOn] = useState(false);

  const manifest = useAiStore((state) => state.manifest);
  const sources = useAiStore((state) => state.sources);
  const activeConversation = useAiStore((state) => state.activeConversation);
  const currentSourceIds = useAiStore((state) => state.currentSourceIds);
  const loading = useAiStore((state) => state.loading);
  const actionLoading = useAiStore((state) => state.actionLoading);
  const uploadProgress = useAiStore((state) => state.uploadProgress);
  const loadSources = useAiStore((state) => state.loadSources);
  const uploadSources = useAiStore((state) => state.uploadSources);
  const removeSource = useAiStore((state) => state.removeSource);
  const editSourceMetadata = useAiStore((state) => state.editSourceMetadata);
  const toggleSourceSelection = useAiStore(
    (state) => state.toggleSourceSelection,
  );

  const selectedSourceIds = activeConversation?.sourceIds ?? currentSourceIds;
  const needsReviewCount = sources.filter(sourceNeedsReview).length;

  const visibleSources = sortSources(
    sources.filter(
      (source) =>
        matchesSourceQuery(source, sourceQuery.trim().toLowerCase()) &&
        (!reviewFilterOn || sourceNeedsReview(source)),
    ),
    sourceSort,
  );

  // The "Needs review" toggle button only renders while there's something to
  // review — once the last source is fixed, the button vanishes along with
  // any way to turn the filter back off.
  useEffect(() => {
    if (needsReviewCount === 0 && reviewFilterOn) {
      setReviewFilterOn(false);
    }
  }, [needsReviewCount, reviewFilterOn]);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    try {
      const { rejected, warnings } = await uploadSources(files);
      const acceptedCount = files.length - rejected.length;

      if (acceptedCount > 0) {
        toast.success(
          `Added ${acceptedCount} source${acceptedCount === 1 ? "" : "s"}`,
        );
      }
      for (const file of rejected) {
        toast.error(`Skipped ${file.name}`, { description: file.reason });
      }
      for (const warning of warnings) {
        toast.warning(`Possible duplicate: ${warning.name}`, {
          description: warning.reason,
        });
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sources</DialogTitle>
          <DialogDescription>
            {manifest && manifest.sources.length > 0
              ? `${manifest.sources.length} source${manifest.sources.length === 1 ? "" : "s"} in your knowledge base.`
              : "Add PDFs, PowerPoint slides, markdown, or text files — they are indexed automatically and become part of what myWiki knows."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <input
            ref={fileInputRef}
            className="hidden"
            type="file"
            accept=".pdf,.pptx,.md,.txt"
            multiple
            onChange={handleFileChange}
          />
          <Button
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={actionLoading}
          >
            <FolderPlusIcon className="mr-2 size-4" />
            Add sources
          </Button>
          <Button
            size="sm"
            variant="ghost"
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
          <>
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
                onValueChange={(value) =>
                  setSourceSort(value as SourceSortMode)
                }
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
              {needsReviewCount > 0 ? (
                <Button
                  size="sm"
                  variant={reviewFilterOn ? "secondary" : "outline"}
                  className="h-8 shrink-0 px-2 text-xs"
                  onClick={() => setReviewFilterOn((value) => !value)}
                  title="Sources with unverified title/author metadata"
                >
                  Needs review ({needsReviewCount})
                </Button>
              ) : null}
            </div>

            <div className="text-muted-foreground text-xs">
              {selectedSourceIds.length === 0
                ? "No sources checked — chat draws on the whole knowledge base."
                : `Chat is scoped to ${selectedSourceIds.length} checked source${selectedSourceIds.length === 1 ? "" : "s"}.`}
            </div>
          </>
        ) : null}

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {sources.length === 0 ? (
            <div className="rounded-md border border-dashed px-3 py-8 text-center text-muted-foreground text-sm">
              No sources yet. Add PDFs, papers, norms, or notes to give myWiki
              something to know.
            </div>
          ) : visibleSources.length === 0 ? (
            <div className="rounded-md border border-dashed px-3 py-4 text-center text-muted-foreground text-xs">
              {sourceQuery
                ? `No sources match "${sourceQuery}".`
                : "No sources need review."}
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
      </DialogContent>
    </Dialog>
  );
}
