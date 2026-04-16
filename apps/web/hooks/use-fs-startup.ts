"use client";

import { useEffect, useRef } from "react";
import { useFsStore, flattenFiles } from "@/stores/fs-store";
import { useEditorStore } from "@/stores/editor-store";
import { usePdfStore } from "@/stores/pdf-store";
import { useGitStore } from "@/stores/git-store";
import { startFsWatcher, type FsEvent } from "@/lib/fs/fs-watcher-client";
import { compileLatex } from "@/lib/latex-compiler";

const COMPILE_DEBOUNCE_MS = 500;
const GIT_STATUS_DEBOUNCE_MS = 1000;
const GIT_POLL_INTERVAL_MS = 3000;

export function useFsStartup() {
  const loadTree = useFsStore((s) => s.loadTree);
  const applyEvent = useFsStore((s) => s.applyEvent);
  const openFile = useEditorStore((s) => s.openFile);
  const startedRef = useRef(false);
  const compileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gitStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gitPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const runCompile = async () => {
      const pdf = usePdfStore.getState();
      pdf.setIsCompiling(true);
      try {
        const data = await compileLatex();
        pdf.setPdfData(data);
      } catch (error) {
        pdf.setCompileError(
          error instanceof Error ? error.message : "Compile failed",
        );
      } finally {
        pdf.setIsCompiling(false);
        if (dirtyRef.current) {
          dirtyRef.current = false;
          runCompile();
        }
      }
    };

    const scheduleCompile = () => {
      const pdf = usePdfStore.getState();
      if (pdf.isCompiling) {
        dirtyRef.current = true;
        return;
      }
      if (compileTimerRef.current) clearTimeout(compileTimerRef.current);
      compileTimerRef.current = setTimeout(() => {
        dirtyRef.current = false;
        runCompile();
      }, COMPILE_DEBOUNCE_MS);
    };

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

      // Auto-select the root document: prefer root-level .tex files with common names.
      const rootFiles = files.filter((p) => !p.includes("/"));
      const main =
        rootFiles.find((p) => p === "main.tex") ??
        rootFiles.find((p) => p === "main_thesis.tex") ??
        rootFiles.find((p) => p.endsWith(".tex")) ??
        files.find((p) => p.endsWith(".tex"));
      if (main) await openFile(main);

      // Try to load the cached PDF first. If fresh, show it immediately.
      // If 404 (stale or missing), fall back to a fresh compile.
      const pdf = usePdfStore.getState();
      try {
        const res = await fetch("/api/pdf/cached", { cache: "no-store" });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          pdf.setPdfData(new Uint8Array(buf));
          return;
        }
      } catch {
        // ignore — fall through to compile
      }
      scheduleCompile();
    })();

    const handler = (event: FsEvent) => {
      applyEvent(event);

      const editor = useEditorStore.getState();
      if (editor.activePath && event.path === editor.activePath) {
        if (event.type === "unlink") editor.handleExternalDelete();
        else if (event.type === "change" || event.type === "add")
          editor.reloadFromDisk();
      }

      // Any watched-file change → recompile + refresh git status.
      if (
        event.type === "add" ||
        event.type === "change" ||
        event.type === "unlink"
      ) {
        scheduleCompile();
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
        // write just flushed to disk → compile (echo-suppressed, so watcher won't)
        scheduleCompile();
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
      handle.close();
      unsubEditor();
      if (compileTimerRef.current) clearTimeout(compileTimerRef.current);
      if (gitStatusTimerRef.current) clearTimeout(gitStatusTimerRef.current);
      if (gitPollRef.current) clearInterval(gitPollRef.current);
    };
  }, [applyEvent, loadTree, openFile]);
}
