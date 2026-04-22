"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowUpIcon,
  FolderIcon,
  HardDriveIcon,
  RefreshCwIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Entry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path: string | null;
  parent: string | null;
  entries: Entry[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}

export function DirectoryBrowserModal({ open, onClose, onSelect }: Props) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [inputPath, setInputPath] = useState("");
  const [suggestions, setSuggestions] = useState<Entry[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const load = useCallback(async (target: string | null) => {
    setLoading(true);
    setError(null);
    const qs = target ? `?path=${encodeURIComponent(target)}` : "";
    try {
      const res = await fetch(`/api/project/browse${qs}`);
      const data = (await res.json()) as BrowseResponse & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      setCurrentPath(data.path);
      setParent(data.parent);
      setEntries(data.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to browse");
    } finally {
      setLoading(false);
    }
  }, []);

  // Keep input in sync when navigation updates currentPath
  useEffect(() => {
    setInputPath(currentPath ?? "");
    setSuggestions([]);
    setShowSuggestions(false);
    setHighlightedIndex(-1);
  }, [currentPath]);

  useEffect(() => {
    if (open) void load(null);
  }, [open, load]);

  const fetchSuggestions = useCallback((value: string) => {
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (!value.trim()) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    suggestTimer.current = setTimeout(async () => {
      // If the value ends with a separator, query the directory itself
      const endsWithSep = /[/\\]$/.test(value);
      const lastSep = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
      const parentDir = endsWithSep
        ? value
        : lastSep > 0
          ? value.slice(0, lastSep)
          : "";
      const prefix = endsWithSep
        ? ""
        : (lastSep >= 0 ? value.slice(lastSep + 1) : value).toLowerCase();

      if (!parentDir) {
        setSuggestions([]);
        setShowSuggestions(false);
        return;
      }

      try {
        const res = await fetch(
          `/api/project/browse?path=${encodeURIComponent(parentDir)}`,
        );
        if (!res.ok) {
          setSuggestions([]);
          return;
        }
        const data = (await res.json()) as BrowseResponse;
        const filtered = prefix
          ? data.entries.filter((e) => e.name.toLowerCase().startsWith(prefix))
          : data.entries;
        setSuggestions(filtered);
        setHighlightedIndex(-1);
        setShowSuggestions(filtered.length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 150);
  }, []);

  const handleInputChange = (value: string) => {
    setInputPath(value);
    fetchSuggestions(value);
  };

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) {
      if (e.key === "Enter") {
        e.preventDefault();
        void load(inputPath.trim() || null);
      }
      if (e.key === "Escape") {
        setInputPath(currentPath ?? "");
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(highlightedIndex + 1, suggestions.length - 1);
      setHighlightedIndex(next);
      suggestionRefs.current[next]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = highlightedIndex - 1;
      if (prev < 0) {
        setHighlightedIndex(-1);
      } else {
        setHighlightedIndex(prev);
        suggestionRefs.current[prev]?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedIndex >= 0 && suggestions[highlightedIndex]) {
        setShowSuggestions(false);
        void load(suggestions[highlightedIndex]!.path);
      } else {
        setShowSuggestions(false);
        void load(inputPath.trim() || null);
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      const idx = highlightedIndex >= 0 ? highlightedIndex : 0;
      if (suggestions[idx]) {
        setShowSuggestions(false);
        void load(suggestions[idx]!.path);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setShowSuggestions(false);
      setHighlightedIndex(-1);
      setInputPath(currentPath ?? "");
    }
  };

  const canSelect = currentPath !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Open folder</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load(parent)}
              disabled={loading || currentPath === null}
            >
              <ArrowUpIcon className="size-4" /> Up
            </Button>

            <div className="relative flex-1">
              <input
                value={inputPath}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={handleInputKeyDown}
                onFocus={() => {
                  if (suggestions.length > 0) setShowSuggestions(true);
                }}
                onBlur={() => {
                  setTimeout(() => {
                    setShowSuggestions(false);
                    setHighlightedIndex(-1);
                  }, 120);
                }}
                placeholder="(root)"
                className="w-full rounded-md border bg-muted px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {showSuggestions && (
                <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
                  {suggestions.map((s, i) => (
                    <li key={s.path}>
                      <button
                        ref={(el) => {
                          suggestionRefs.current[i] = el;
                        }}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setShowSuggestions(false);
                          void load(s.path);
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === highlightedIndex ? "bg-accent" : "hover:bg-accent"}`}
                      >
                        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate font-mono">{s.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load(currentPath)}
              disabled={loading}
            >
              <RefreshCwIcon className="size-4" />
            </Button>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-destructive text-sm">
              {error}.{" "}
              <button
                className="underline disabled:opacity-50"
                disabled={loading}
                onClick={() => void load(null)}
              >
                Go to root
              </button>
            </div>
          )}

          <ul className="h-72 overflow-y-auto rounded-md border">
            {entries.length === 0 && !loading && !error && (
              <li className="px-3 py-6 text-center text-muted-foreground text-sm">
                (no subdirectories)
              </li>
            )}
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  onClick={() => void load(entry.path)}
                  disabled={loading}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                >
                  {currentPath === null ? (
                    <HardDriveIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSelect} onClick={() => onSelect(currentPath!)}>
            Open this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
