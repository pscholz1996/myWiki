"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FolderIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DirectoryBrowserModal } from "./directory-browser-modal";

interface Props {
  open: boolean;
  onClose: () => void;
}

async function createProject(parentPath: string, name: string): Promise<void> {
  const res = await fetch("/api/project/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentPath, name }),
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

export function NewProjectDialog({ open, onClose }: Props) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const trimmedName = name.trim();
  const canCreate = Boolean(location) && trimmedName.length > 0 && !submitting;
  const sep = location?.includes("\\") ? "\\" : "/";
  const previewPath =
    location && trimmedName
      ? `${location.replace(/[\\/]+$/, "")}${sep}${trimmedName}`
      : null;

  const reset = () => {
    setName("");
    setLocation(null);
  };

  const onCreate = async () => {
    if (!location || !trimmedName) return;
    setSubmitting(true);
    let succeeded = false;
    try {
      await createProject(location, trimmedName);
      succeeded = true;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create folder",
      );
    } finally {
      if (!succeeded) setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) {
            onClose();
            if (!submitting) reset();
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New knowledge folder</DialogTitle>
            <DialogDescription>
              Creates a new folder with a blank main.tex file, ready to write in.
            </DialogDescription>
          </DialogHeader>

          <div className="min-w-0 space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="new-project-name"
                className="font-medium text-sm"
              >
                Folder name
              </label>
              <Input
                id="new-project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-thesis"
                disabled={submitting}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <span className="font-medium text-sm">Location</span>
              <button
                type="button"
                onClick={() => setBrowseOpen(true)}
                disabled={submitting}
                className="flex w-full min-w-0 items-center gap-2 rounded-md border bg-muted px-3 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
              >
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-mono">
                  {location ?? "Choose a folder…"}
                </span>
              </button>
            </div>

            {previewPath && (
              <p className="min-w-0 truncate font-mono text-muted-foreground text-xs">
                Will create: {previewPath}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button onClick={() => void onCreate()} disabled={!canCreate}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DirectoryBrowserModal
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(p) => {
          setLocation(p);
          setBrowseOpen(false);
        }}
        title="Choose a location"
        selectLabel="Use this folder"
      />
    </>
  );
}
