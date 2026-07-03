"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ListIcon,
  HashIcon,
  GitBranchIcon,
  ChevronDownIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { toast } from "sonner";
import { useFsStore, flattenFiles } from "@/stores/fs-store";
import { useEditorStore } from "@/stores/editor-store";
import { usePdfStore } from "@/stores/pdf-store";
import { readFile } from "@/lib/fs/fs-client";
import { describeOutcome, syncForward } from "@/lib/synctex";
import { Button } from "@/components/ui/button";
import { FileTree } from "./file-tree";
import { SourceControl } from "./source-control";
import { GithubAccountMenu } from "./github-account-menu";
import { useGitStore } from "@/stores/git-store";
import { cn } from "@/lib/utils";
import packageJson from "@/package.json";

interface TocItem {
  level: number;
  title: string;
  line: number;
  /** Project-relative path of the file this entry came from — a multi-file
   * document's outline spans \input/\include'd chapter files, not just
   * whichever one happens to be open in the editor. */
  file: string;
}

const SECTION_REGEX =
  /\\(part|chapter|section|subsection|subsubsection)\*?\s*\{([^}]*)\}/;
const INCLUDE_REGEX = /\\(?:input|include)\s*\{([^}]+)\}/;
const TOC_LEVEL_MAP: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
};

/** Resolve a \input/\include argument to a project-relative .tex path. */
function resolveIncludeTarget(raw: string): string {
  const target = raw.trim().replace(/^\.\//, "");
  return target.toLowerCase().endsWith(".tex") ? target : `${target}.tex`;
}

/**
 * Recursively walks a .tex file's own sections plus anything it
 * \input/\include's, so the outline reflects the whole document rather than
 * just whichever chapter file happens to be open — thesis/report projects
 * routinely split chapters into separate files included from a root main.tex
 * that has no section commands of its own.
 */
async function buildTocForFile(
  filePath: string,
  content: string,
  visited: Set<string>,
  readSource: (path: string) => Promise<string | null>,
  depth: number,
): Promise<TocItem[]> {
  if (depth > 20 || visited.has(filePath)) return [];
  visited.add(filePath);

  const items: TocItem[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*%/.test(line)) continue;

    const sectionMatch = line.match(SECTION_REGEX);
    if (sectionMatch) {
      const [, type, title] = sectionMatch;
      items.push({
        level: TOC_LEVEL_MAP[type] ?? 2,
        title: title.trim(),
        line: i + 1,
        file: filePath,
      });
      continue;
    }

    const includeMatch = line.match(INCLUDE_REGEX);
    if (includeMatch) {
      const targetPath = resolveIncludeTarget(includeMatch[1]);
      if (!visited.has(targetPath)) {
        const targetContent = await readSource(targetPath);
        if (targetContent != null) {
          items.push(
            ...(await buildTocForFile(
              targetPath,
              targetContent,
              visited,
              readSource,
              depth + 1,
            )),
          );
        }
      }
    }
  }

  return items;
}

/**
 * Picks the document's root file the same way the compile route does:
 * prefer a root-level .tex containing \documentclass, then main(.tex) /
 * main_thesis.tex, then the first root-level .tex — so the outline starts
 * walking from the same place pdflatex would.
 */
async function pickMainTexPath(
  candidates: string[],
  readSource: (path: string) => Promise<string | null>,
): Promise<string | null> {
  if (candidates.length <= 1) return candidates[0] ?? null;

  for (const path of candidates) {
    const content = await readSource(path);
    if (content?.includes("\\documentclass")) return path;
  }
  return (
    candidates.find((p) => p === "main.tex") ??
    candidates.find((p) => p === "main_thesis.tex") ??
    candidates[0]
  );
}

export function Sidebar() {
  const tree = useFsStore((s) => s.tree);
  const root = useFsStore((s) => s.root);
  const activePath = useEditorStore((s) => s.activePath);
  const buffer = useEditorStore((s) => s.buffer);
  const activeKind = useEditorStore((s) => s.activeKind);
  const openFile = useEditorStore((s) => s.openFile);
  const isGitRepo = useGitStore((s) => s.isGitRepo);
  const branch = useGitStore((s) => s.branch);
  const ahead = useGitStore((s) => s.ahead);
  const behind = useGitStore((s) => s.behind);
  const fileStatuses = useGitStore((s) => s.fileStatuses);
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const filesPanelRef = useRef<ImperativePanelHandle>(null);
  const scPanelRef = useRef<ImperativePanelHandle>(null);
  const outlinePanelRef = useRef<ImperativePanelHandle>(null);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [scCollapsed, setScCollapsed] = useState(false);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);

  const [toc, setToc] = useState<TocItem[]>([]);

  // Builds the outline from the whole document (root file + everything it
  // \input/\include's), not just the currently active buffer — debounced
  // since it re-walks on every keystroke in the active file. The active
  // file's own content is read from the live buffer so its section still
  // updates as you type; every other file is read from disk.
  useEffect(() => {
    let cancelled = false;

    const readSource = async (path: string): Promise<string | null> => {
      if (path === activePath && activeKind === "text") return buffer;
      try {
        const res = await readFile(path);
        return res.type === "text" ? res.content : null;
      } catch {
        return null;
      }
    };

    const timer = setTimeout(() => {
      void (async () => {
        const texPaths = flattenFiles(tree).filter((p) =>
          p.toLowerCase().endsWith(".tex"),
        );
        if (texPaths.length === 0) {
          if (!cancelled) setToc([]);
          return;
        }

        const rootLevel = texPaths.filter((p) => !p.includes("/"));
        const mainPath =
          (await pickMainTexPath(
            rootLevel.length > 0 ? rootLevel : texPaths,
            readSource,
          )) ??
          activePath ??
          texPaths[0];

        const mainContent = await readSource(mainPath);
        if (cancelled) return;
        if (mainContent == null) {
          setToc([]);
          return;
        }

        const items = await buildTocForFile(
          mainPath,
          mainContent,
          new Set(),
          readSource,
          0,
        );
        if (!cancelled) setToc(items);
      })();
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tree, activePath, activeKind, buffer]);

  const rootName = useMemo(() => {
    if (!root) return "Project";
    const parts = root.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? "Project";
  }, [root]);

  const handleTocClick = useCallback(async (item: TocItem) => {
    await useEditorStore.getState().goToLocation(item.file, item.line, 0);
    const outcome = await syncForward(item.file, item.line, 0);
    if (outcome.kind === "ok") {
      const { page, h, v, width, height } = outcome.value;
      usePdfStore.getState().setSynctexHighlight({
        page,
        x: h,
        y: v,
        width,
        height,
        key: Date.now(),
      });
      usePdfStore.getState().setScrollToPage(page);
    } else {
      const msg = describeOutcome(outcome);
      if (msg) toast(msg);
    }
  }, []);

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-12 items-center border-sidebar-border border-b px-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-semibold text-sm">OpenLatex</span>
          <span className="truncate text-muted-foreground text-xs">
            {rootName}
          </span>
        </div>
        {isGitRepo && branch && (
          <div
            className="flex shrink-0 items-center gap-1 rounded-full bg-primary px-2 py-1 font-medium text-primary-foreground text-xs"
            title={`On branch ${branch}`}
          >
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span className="max-w-[80px] truncate">{branch}</span>
            {(ahead > 0 || behind > 0) && (
              <span className="flex items-center gap-0.5 border-primary-foreground/30 border-l pl-1 font-mono text-[10px] opacity-90">
                {ahead > 0 && (
                  <span className="flex items-center">
                    <ArrowUpIcon className="size-2.5" />
                    {ahead}
                  </span>
                )}
                {behind > 0 && (
                  <span className="flex items-center">
                    <ArrowDownIcon className="size-2.5" />
                    {behind}
                  </span>
                )}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Files header */}
      <button
        onClick={() =>
          filesCollapsed
            ? filesPanelRef.current?.expand()
            : filesPanelRef.current?.collapse()
        }
        className="flex h-9 w-full cursor-pointer items-center gap-2 border-sidebar-border border-b px-3 transition-colors hover:bg-sidebar-accent/50"
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
            <FileTree
              nodes={tree}
              activePath={activePath}
              onOpen={openFile}
              fileStatuses={fileStatuses}
            />
          </div>
        </Panel>

        {/* Source Control header doubles as the resize handle. Always
            rendered — git is optional, and SourceControl itself shows an
            "Initialize Repository" opt-in when isGitRepo is false, so this
            section must stay reachable regardless. */}
        <PanelResizeHandle className="shrink-0">
          <button
            onClick={() =>
              scCollapsed
                ? scPanelRef.current?.expand()
                : scPanelRef.current?.collapse()
            }
            className="flex h-9 w-full cursor-pointer items-center gap-2 border-sidebar-border border-y px-3 transition-colors hover:bg-sidebar-accent/50"
          >
            <ChevronDownIcon
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                scCollapsed && "-rotate-90",
              )}
            />
            <GitBranchIcon className="size-4 text-muted-foreground" />
            <span className="font-medium text-xs">Source Control</span>
          </button>
        </PanelResizeHandle>

        <Panel
          ref={scPanelRef}
          defaultSize={25}
          minSize={0}
          collapsible
          collapsedSize={0}
          onCollapse={() => setScCollapsed(true)}
          onExpand={() => setScCollapsed(false)}
        >
          <SourceControl />
        </Panel>

        {/* Outline header doubles as the resize handle */}
        <PanelResizeHandle className="shrink-0">
          <button
            onClick={() =>
              outlineCollapsed
                ? outlinePanelRef.current?.expand()
                : outlinePanelRef.current?.collapse()
            }
            className="flex h-9 w-full cursor-pointer items-center gap-2 border-sidebar-border border-y px-3 transition-colors hover:bg-sidebar-accent/50"
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
              toc.map((item) => (
                <button
                  key={`${item.file}:${item.line}`}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50"
                  style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
                  title={item.file}
                  onClick={() => handleTocClick(item)}
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
          <GithubAccountMenu />
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
