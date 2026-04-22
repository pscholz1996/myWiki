"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ChevronDownIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { DirectoryBrowserModal } from "./directory-browser-modal";
import { basename } from "@/lib/project/path-utils";

interface Props {
  current: string;
  recent: string[];
}

async function switchTo(path: string): Promise<void> {
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

export function ProjectSwitcherButton({ current, recent }: Props) {
  const [browseOpen, setBrowseOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const others = recent.filter((p) => p !== current);

  const onPick = async (p: string) => {
    if (switching) return;
    setSwitching(true);
    let succeeded = false;
    try {
      await switchTo(p);
      succeeded = true;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to switch project",
      );
    } finally {
      if (!succeeded) setSwitching(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            disabled={switching}
          >
            <FolderIcon className="size-4" />
            <span className="max-w-[16rem] truncate font-medium">
              {basename(current)}
            </span>
            <ChevronDownIcon className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="truncate font-mono text-muted-foreground text-xs">
            {current}
          </DropdownMenuLabel>
          {others.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Recent</DropdownMenuLabel>
              {others.map((p) => (
                <DropdownMenuItem
                  key={p}
                  onSelect={() => void onPick(p)}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="truncate font-medium">{basename(p)}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {p}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => setBrowseOpen(true)}>
            <FolderOpenIcon className="mr-2 size-4" /> Browse other folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DirectoryBrowserModal
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(p) => {
          setBrowseOpen(false);
          void onPick(p);
        }}
      />
    </>
  );
}
