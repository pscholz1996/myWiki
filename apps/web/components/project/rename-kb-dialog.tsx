"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
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

interface Props {
  open: boolean;
  onClose: () => void;
  path: string;
  currentName: string;
}

async function renameKb(path: string, name: string): Promise<void> {
  const res = await fetch("/api/project/name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, name }),
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

export function RenameKbDialog({ open, onClose, path, currentName }: Props) {
  const [name, setName] = useState(currentName);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setName(currentName);
  }, [open, currentName]);

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && trimmed !== currentName && !submitting;

  const onSave = async () => {
    if (!canSave) return;
    setSubmitting(true);
    let succeeded = false;
    try {
      await renameKb(path, trimmed);
      succeeded = true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to rename");
    } finally {
      if (!succeeded) setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !submitting) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rename knowledge base</DialogTitle>
          <DialogDescription>
            The display name is stored inside the knowledge folder and shown
            everywhere instead of the folder path.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
          className="space-y-2"
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. MBSE library"
            disabled={submitting}
            autoFocus
          />
          <p className="truncate font-mono text-muted-foreground text-xs">
            {path}
          </p>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void onSave()} disabled={!canSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
