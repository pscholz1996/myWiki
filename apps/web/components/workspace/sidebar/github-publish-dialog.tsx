"use client";

import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useGithubStore } from "@/stores/github-store";
import { useGitStore } from "@/stores/git-store";
import { useFsStore } from "@/stores/fs-store";
import { basename } from "@/lib/project/path-utils";

// GitHub repo names allow letters, digits, '.', '_', '-'.
function sanitizeRepoName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function GithubPublishDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const publish = useGithubStore((s) => s.publish);
  const publishing = useGithubStore((s) => s.publishing);
  const lastCommit = useGitStore((s) => s.lastCommit);
  const refresh = useGitStore((s) => s.refresh);
  const root = useFsStore((s) => s.root);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">(
    "private",
  );

  useEffect(() => {
    if (open && root) {
      setName(sanitizeRepoName(basename(root)));
    }
  }, [open, root]);

  const noCommitsYet = !lastCommit;

  const handlePublish = async () => {
    if (!name.trim()) return;
    try {
      const result = await publish({
        name: name.trim(),
        description: description.trim() || undefined,
        visibility,
      });
      toast.success("Published to GitHub", {
        description: result.url ?? undefined,
      });
      await refresh();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to publish");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Publish to GitHub</DialogTitle>
          <DialogDescription>
            Creates a new repository on your GitHub account and pushes this
            project's current history to it.
          </DialogDescription>
        </DialogHeader>

        {noCommitsYet ? (
          <div className="rounded-md border bg-muted/30 p-3 text-muted-foreground text-xs">
            Commit your work first — there's nothing to publish yet.
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="gh-repo-name">Repository name</Label>
              <Input
                id="gh-repo-name"
                value={name}
                onChange={(e) => setName(sanitizeRepoName(e.target.value))}
                disabled={publishing}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="gh-repo-description">
                Description <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="gh-repo-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={publishing}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Visibility</Label>
              <Select
                value={visibility}
                onValueChange={(v) => setVisibility(v as "public" | "private")}
              >
                <SelectTrigger className="w-full" disabled={publishing}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private</SelectItem>
                  <SelectItem value="public">Public</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={publishing}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handlePublish()}
            disabled={publishing || noCommitsYet || !name.trim()}
          >
            {publishing ? (
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
            ) : null}
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
