"use client";

import { useState } from "react";
import { ChevronDownIcon, FileTextIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { AiSourceRecord } from "@/lib/ai/types";

interface MetadataEdits {
  title: string;
  authors: string[];
  year: string;
}

interface Props {
  source: AiSourceRecord;
  selected: boolean;
  onToggleSelected: () => void;
  onDelete: () => void;
  deleteDisabled: boolean;
  onSaveMetadata: (updates: MetadataEdits) => Promise<void>;
}

function DetailRow({
  label,
  value,
  href,
  note,
}: {
  label: string;
  value?: string;
  href?: string;
  note?: string;
}) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">
        {value ? (
          href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              {value}
            </a>
          ) : (
            value
          )
        ) : (
          <span className="text-muted-foreground/60 italic">Not available</span>
        )}
        {note ? (
          <span className="ml-1.5 text-muted-foreground/70">({note})</span>
        ) : null}
      </span>
    </div>
  );
}

// A source's compact row only ever has room for a one-line summary — this
// is the "show me everything you actually know about this source" escape
// hatch, useful both for real bibliographic work and for spotting when
// extraction guessed wrong (a guessed title/author is labeled as such
// rather than presented with the same confidence as real PDF metadata).
export function SourceListItem({
  source,
  selected,
  onToggleSelected,
  onDelete,
  deleteDisabled,
  onSaveMetadata,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftAuthors, setDraftAuthors] = useState("");
  const [draftYear, setDraftYear] = useState("");
  const metadata = source.metadata;

  // A research note's "metadata" isn't bibliographic data to correct — it's
  // just the AI's own title/content — so the edit affordance only makes
  // sense for actual sources.
  const canEditMetadata = source.kind !== "note";

  const provenanceLabel =
    metadata?.provenance === "manual"
      ? "Manually entered"
      : metadata?.provenance === "crossref"
        ? "Verified against CrossRef"
        : metadata?.provenance === "pdf-metadata"
          ? "From the PDF's own embedded metadata"
          : metadata?.provenance === "heuristic"
            ? "Best-effort guess from the text (not verified)"
            : undefined;

  function startEditing() {
    setDraftTitle(metadata?.title ?? "");
    setDraftAuthors(metadata?.authors?.join(", ") ?? "");
    setDraftYear(metadata?.year ?? "");
    setSaveError(null);
    setIsEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await onSaveMetadata({
        title: draftTitle,
        authors: draftAuthors
          .split(",")
          .map((author) => author.trim())
          .filter(Boolean),
        year: draftYear,
      });
      setIsEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-start justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Checkbox
            className="mt-0.5"
            checked={selected}
            onCheckedChange={onToggleSelected}
            aria-label={`Scope chat to ${source.originalName}`}
          />
          <a
            href={`/api/ai/sources/${source.id}/file`}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 text-left"
            title={`Open ${source.originalName}`}
          >
            <div className="flex items-center gap-2">
              <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="truncate font-medium text-sm hover:underline">
                {metadata?.title ?? source.originalName}
              </div>
            </div>
            {(metadata?.authors?.length || metadata?.year) && (
              <div className="mt-0.5 truncate text-muted-foreground text-xs">
                {[metadata?.authors?.join(", "), metadata?.year]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
            <div className="mt-1 text-muted-foreground text-xs">
              {source.kind.toUpperCase()} · {Math.round(source.bytes / 1024)} KB
              {typeof source.pageCount === "number"
                ? ` · ${source.pageCount} pages`
                : ""}
            </div>
          </a>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-1.5 text-muted-foreground"
            onClick={() => setExpanded((value) => !value)}
            title={expanded ? "Hide details" : "Show details"}
            aria-label={
              expanded
                ? `Hide details for ${source.originalName}`
                : `Show details for ${source.originalName}`
            }
          >
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform",
                !expanded && "-rotate-90",
              )}
            />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-muted-foreground"
            onClick={onDelete}
            disabled={deleteDisabled}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="space-y-1.5 border-t px-3 py-2 text-xs">
          {isEditing ? (
            <div className="space-y-2.5">
              <div className="space-y-1">
                <Label htmlFor={`title-${source.id}`} className="text-muted-foreground">
                  Title
                </Label>
                <Input
                  id={`title-${source.id}`}
                  className="h-7 text-xs"
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  disabled={saving}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`authors-${source.id}`} className="text-muted-foreground">
                  Authors
                </Label>
                <Input
                  id={`authors-${source.id}`}
                  className="h-7 text-xs"
                  value={draftAuthors}
                  onChange={(event) => setDraftAuthors(event.target.value)}
                  placeholder="Jane Doe, John Smith"
                  disabled={saving}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`year-${source.id}`} className="text-muted-foreground">
                  Year
                </Label>
                <Input
                  id={`year-${source.id}`}
                  className="h-7 w-20 text-xs"
                  value={draftYear}
                  onChange={(event) => setDraftYear(event.target.value)}
                  disabled={saving}
                />
              </div>
              {saveError ? <p className="text-destructive">{saveError}</p> : null}
              <div className="flex gap-1.5 pt-0.5">
                <Button
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => setIsEditing(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <DetailRow
                label="Title"
                value={metadata?.title ?? source.originalName}
                note={
                  metadata?.title && metadata.titleIsHeuristic
                    ? "guessed from the text, not verified"
                    : undefined
                }
              />
              <DetailRow
                label="Authors"
                value={metadata?.authors?.join(", ")}
                note={
                  metadata?.authors?.length && metadata.authorsAreHeuristic
                    ? "guessed from the text, not verified"
                    : undefined
                }
              />
              <DetailRow label="Year" value={metadata?.year} />
              <DetailRow label="Metadata source" value={provenanceLabel} />
              {metadata?.doi ? (
                <DetailRow
                  label="DOI"
                  value={metadata.doi}
                  href={`https://doi.org/${metadata.doi}`}
                />
              ) : null}
              <DetailRow label="Filename" value={source.originalName} />
              <DetailRow label="Cite key" value={source.bibKey} />
              {canEditMetadata ? (
                <div className="pt-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 px-2 text-muted-foreground text-xs"
                    onClick={startEditing}
                  >
                    <PencilIcon className="size-3" />
                    Edit
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
