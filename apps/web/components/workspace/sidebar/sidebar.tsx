"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ListIcon,
  HashIcon,
  GithubIcon,
  ChevronDownIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { useFsStore } from "@/stores/fs-store";
import { useEditorStore } from "@/stores/editor-store";
import { usePdfStore } from "@/stores/pdf-store";
import { Button } from "@/components/ui/button";
import { FileTree } from "./file-tree";
import { cn } from "@/lib/utils";
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
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const filesPanelRef = useRef<ImperativePanelHandle>(null);
  const outlinePanelRef = useRef<ImperativePanelHandle>(null);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);

  const toc = useMemo(
    () => (activeKind === "text" ? parseTableOfContents(buffer) : []),
    [buffer, activeKind],
  );

  const rootName = useMemo(() => {
    if (!root) return "Project";
    const parts = root.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? "Project";
  }, [root]);

  const handleTocClick = useCallback((title: string) => {
    const pdf = usePdfStore.getState();
    const page = pdf.findPage(title);
    if (page) pdf.setScrollToPage(page);
  }, []);

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-12 items-center border-sidebar-border border-b px-3">
        <div className="flex flex-col">
          <span className="font-semibold text-sm">OpenLatex</span>
          <span className="truncate text-muted-foreground text-xs">
            {rootName}
          </span>
        </div>
      </div>

      {/* Files header */}
      <button
        onClick={() =>
          filesCollapsed
            ? filesPanelRef.current?.expand()
            : filesPanelRef.current?.collapse()
        }
        className="flex h-9 w-full items-center gap-2 border-sidebar-border border-b px-3 cursor-pointer transition-colors hover:bg-sidebar-accent/50"
      >
        <ChevronDownIcon
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            filesCollapsed && "-rotate-90",
          )}
        />
        <FolderIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-xs">Files</span>
      </button>

      <PanelGroup direction="vertical" className="min-h-0 flex-1">
        <Panel
          ref={filesPanelRef}
          defaultSize={50}
          minSize={0}
          collapsible
          collapsedSize={0}
          onCollapse={() => setFilesCollapsed(true)}
          onExpand={() => setFilesCollapsed(false)}
        >
          <div className="h-full overflow-y-auto p-2">
            <FileTree nodes={tree} activePath={activePath} onOpen={openFile} />
          </div>
        </Panel>

        {/* Outline header doubles as the resize handle */}
        <PanelResizeHandle className="shrink-0">
          <button
            onClick={() =>
              outlineCollapsed
                ? outlinePanelRef.current?.expand()
                : outlinePanelRef.current?.collapse()
            }
            className="flex h-9 w-full items-center gap-2 border-sidebar-border border-y px-3 cursor-pointer transition-colors hover:bg-sidebar-accent/50"
          >
            <ChevronDownIcon
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                outlineCollapsed && "-rotate-90",
              )}
            />
            <ListIcon className="size-4 text-muted-foreground" />
            <span className="font-medium text-xs">Outline</span>
          </button>
        </PanelResizeHandle>

        <Panel
          ref={outlinePanelRef}
          defaultSize={50}
          minSize={0}
          collapsible
          collapsedSize={0}
          onCollapse={() => setOutlineCollapsed(true)}
          onExpand={() => setOutlineCollapsed(false)}
        >
          <div className="h-full space-y-1 overflow-y-auto p-2">
            {toc.length > 0 ? (
              toc.map((item, index) => (
                <button
                  key={index}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50"
                  style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
                  onClick={() => handleTocClick(item.title)}
                >
                  <HashIcon className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{item.title}</span>
                </button>
              ))
            ) : (
              <div className="px-2 py-1 text-muted-foreground text-xs">
                No sections found
              </div>
            )}
          </div>
        </Panel>
      </PanelGroup>

      <div className="flex items-center justify-between border-sidebar-border border-t px-3 py-2 text-muted-foreground text-xs">
        <span>OpenLatex v{packageJson.version}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-6" asChild>
            <a
              href="https://github.com/xTazah/OpenLatex"
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub"
            >
              <GithubIcon className="size-3.5" />
            </a>
          </Button>
          {mounted && (
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
                theme === "system"
                  ? "System theme"
                  : theme === "light"
                    ? "Light mode"
                    : "Dark mode"
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
          )}
        </div>
      </div>
    </div>
  );
}
