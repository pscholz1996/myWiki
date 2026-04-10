"use client";

import { useCallback, useMemo } from "react";
import {
  FolderIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ListIcon,
  HashIcon,
  GithubIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useFsStore } from "@/stores/fs-store";
import { useEditorStore } from "@/stores/editor-store";
import { Button } from "@/components/ui/button";
import { FileTree } from "./file-tree";
import packageJson from "@/package.json";

interface TocItem {
  level: number;
  title: string;
  line: number;
}

function parseTableOfContents(content: string): TocItem[] {
  const lines = content.split("\n");
  const toc: TocItem[] = [];
  const sectionRegex =
    /\\(section|subsection|subsubsection|chapter|part)\*?\s*\{([^}]*)\}/;
  const levelMap: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 2,
    subsection: 3,
    subsubsection: 4,
  };

  lines.forEach((line, index) => {
    const match = line.match(sectionRegex);
    if (match) {
      const [, type, title] = match;
      toc.push({
        level: levelMap[type] ?? 2,
        title: title.trim(),
        line: index + 1,
      });
    }
  });
  return toc;
}

export function Sidebar() {
  const tree = useFsStore((s) => s.tree);
  const root = useFsStore((s) => s.root);
  const activePath = useEditorStore((s) => s.activePath);
  const buffer = useEditorStore((s) => s.buffer);
  const activeKind = useEditorStore((s) => s.activeKind);
  const openFile = useEditorStore((s) => s.openFile);
  const { theme, setTheme } = useTheme();

  const toc = useMemo(
    () => (activeKind === "text" ? parseTableOfContents(buffer) : []),
    [buffer, activeKind],
  );

  const rootName = useMemo(() => {
    if (!root) return "Project";
    const parts = root.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? "Project";
  }, [root]);

  const handleTocClick = useCallback((_line: number) => {
    // Wired later when we add position-jumping in the editor; for now no-op.
  }, []);

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-12 items-center border-sidebar-border border-b px-3">
        <div className="flex flex-col">
          <span className="font-semibold text-sm">OpenPrism</span>
          <span className="text-muted-foreground text-xs truncate">{rootName}</span>
        </div>
      </div>

      <div className="flex h-9 items-center justify-between border-sidebar-border border-b px-3">
        <div className="flex items-center gap-2">
          <FolderIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-xs">Files</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <FileTree nodes={tree} activePath={activePath} onOpen={openFile} />
      </div>

      <div className="flex h-9 items-center gap-2 border-sidebar-border border-t px-3">
        <ListIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-xs">Outline</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {toc.length > 0 ? (
          toc.map((item, index) => (
            <button
              key={index}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50"
              style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
              onClick={() => handleTocClick(item.line)}
            >
              <HashIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{item.title}</span>
            </button>
          ))
        ) : (
          <div className="px-2 py-1 text-muted-foreground text-xs">No sections found</div>
        )}
      </div>

      <div className="flex items-center justify-between border-sidebar-border border-t px-3 py-2 text-muted-foreground text-xs">
        <span>OpenPrism v{packageJson.version}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-6" asChild>
            <a
              href="https://github.com/assistant-ui/open-prism"
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub"
            >
              <GithubIcon className="size-3.5" />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => {
              if (theme === "system") setTheme("light");
              else if (theme === "light") setTheme("dark");
              else setTheme("system");
            }}
            title={
              theme === "system" ? "System theme" : theme === "light" ? "Light mode" : "Dark mode"
            }
          >
            {theme === "system" ? (
              <MonitorIcon className="size-3.5" />
            ) : theme === "light" ? (
              <SunIcon className="size-3.5" />
            ) : (
              <MoonIcon className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
