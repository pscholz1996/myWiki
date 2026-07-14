"use client";

import { useEffect, useRef } from "react";
import { useFsStore, flattenFiles } from "@/stores/fs-store";
import { useEditorStore } from "@/stores/editor-store";
import { useViewerStore } from "@/stores/viewer-store";
import { useGitStore } from "@/stores/git-store";
import { startFsWatcher, type FsEvent } from "@/lib/fs/fs-watcher-client";

const GIT_STATUS_DEBOUNCE_MS = 1000;
const GIT_POLL_INTERVAL_MS = 3000;

/** Pick the wiki's landing page: Home.md > index.md > README.md > first .md. */
function pickHomePage(files: string[]): string | null {
  const mdFiles = files.filter((p) => p.toLowerCase().endsWith(".md"));
  const rootLevel = mdFiles.filter((p) => !p.includes("/"));
  const byName = (name: string) =>
    rootLevel.find((p) => p.toLowerCase() === name) ??
    mdFiles.find((p) => p.toLowerCase().endsWith(`/${name}`));
  return (
    byName("home.md") ??
    byName("index.md") ??
    byName("readme.md") ??
    rootLevel[0] ??
    mdFiles[0] ??
    null
  );
}

export function useFsStartup() {
  const loadTree = useFsStore((s) => s.loadTree);
  const applyEvent = useFsStore((s) => s.applyEvent);
  const openFile = useEditorStore((s) => s.openFile);
  const startedRef = useRef(false);
  const gitStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gitPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const scheduleGitRefresh = () => {
      if (gitStatusTimerRef.current) clearTimeout(gitStatusTimerRef.current);
      gitStatusTimerRef.current = setTimeout(() => {
        useGitStore.getState().loadStatus();
      }, GIT_STATUS_DEBOUNCE_MS);
    };

    (async () => {
      await loadTree();

      // Load git info + status (non-blocking; ok if not a git repo)
      useGitStore.getState().refresh();

      const { tree } = useFsStore.getState();
      const files = flattenFiles(tree);
      const home = pickHomePage(files);
      if (home) await openFile(home);
    })();

    const handler = (event: FsEvent) => {
      applyEvent(event);

      const editor = useEditorStore.getState();
      if (editor.activePath && event.path === editor.activePath) {
        if (event.type === "unlink") editor.handleExternalDelete();
        else if (event.type === "change" || event.type === "add")
          editor.reloadFromDisk();
      }

      const viewer = useViewerStore.getState();
      if (viewer.path && event.path === viewer.path) {
        if (event.type === "unlink") viewer.close();
        else if (event.type === "change") viewer.reloadFromDisk();
      }

      if (
        event.type === "add" ||
        event.type === "change" ||
        event.type === "unlink"
      ) {
        scheduleGitRefresh();
      }
    };

    const handle = startFsWatcher(handler, (status) => {
      if (status === "connected") {
        // Resync tree and git status after reconnect in case we missed events.
        loadTree();
        useGitStore.getState().refresh();
      }
    });

    const unsubEditor = useEditorStore.subscribe((state, prev) => {
      if (
        state.writePending !== prev.writePending &&
        prev.writePending &&
        !state.writePending
      ) {
        // write just flushed to disk (echo-suppressed, so watcher won't fire)
        scheduleGitRefresh();
      }
    });

    // Poll git status periodically to catch external git operations
    // (e.g. git reset, git checkout, git stash) that only touch .git/ internals
    // and don't trigger chokidar file events.
    gitPollRef.current = setInterval(() => {
      const git = useGitStore.getState();
      if (git.isGitRepo && !git.actionLoading) {
        git.loadStatus();
      }
    }, GIT_POLL_INTERVAL_MS);

    return () => {
      startedRef.current = false;
      handle.close();
      unsubEditor();
      if (gitStatusTimerRef.current) clearTimeout(gitStatusTimerRef.current);
      if (gitPollRef.current) clearInterval(gitPollRef.current);
    };
  }, [applyEvent, loadTree, openFile]);
}
