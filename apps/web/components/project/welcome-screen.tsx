"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FolderOpenIcon, FolderIcon, GithubIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DirectoryBrowserModal } from "./directory-browser-modal";
import { basename } from "@/lib/project/path-utils";

interface WelcomeScreenProps {
  recent: string[];
}

async function selectProject(path: string): Promise<void> {
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

export function WelcomeScreen({ recent }: WelcomeScreenProps) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);

  const onOpen = async (p: string) => {
    if (!p.trim()) return;
    setSubmitting(true);
    let succeeded = false;
    try {
      await selectProject(p.trim());
      succeeded = true;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to open project",
      );
    } finally {
      if (!succeeded) setSubmitting(false);
    }
  };

  return (
    <>
      <div className="relative flex h-full w-full items-center justify-center bg-background">
        <div className="w-full max-w-lg space-y-6 px-6">
          <div className="space-y-1">
            <h1 className="font-semibold text-2xl">OpenLaTex</h1>
            <p className="text-muted-foreground text-sm">
              Open a folder that contains your LaTeX project to get started.
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onOpen(input);
            }}
            className="flex gap-2"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="C:\path\to\your\latex-project"
              disabled={submitting}
              autoFocus
            />
            <Button type="submit" disabled={submitting || !input.trim()}>
              Open
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setBrowseOpen(true)}
              disabled={submitting}
            >
              <FolderOpenIcon className="size-4" /> Browse…
            </Button>
          </form>

          {recent.length > 0 && (
            <div className="space-y-2">
              <h2 className="font-medium text-muted-foreground text-sm">
                Recent projects
              </h2>
              <ul className="divide-y rounded-md border">
                {recent.map((p) => (
                  <li key={p}>
                    <button
                      onClick={() => void onOpen(p)}
                      disabled={submitting}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                    >
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">
                        {basename(p)}
                      </span>
                      <span className="ml-auto truncate text-muted-foreground text-xs">
                        {p}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <footer className="absolute right-0 bottom-0 left-0 flex items-center justify-center gap-2 py-4 text-muted-foreground text-xs">
        <span>by xTazah</span>
        <span>·</span>
        <a
          href="https://github.com/xTazah/OpenLatex"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 transition-colors hover:text-foreground"
        >
          <GithubIcon className="size-3.5" />
          GitHub
        </a>
      </footer>

      <DirectoryBrowserModal
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(p) => {
          setBrowseOpen(false);
          void onOpen(p);
        }}
      />
    </>
  );
}
