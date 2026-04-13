"use client";

import { useEffect, useRef } from "react";
import { useFsStore, flattenFiles } from "@/stores/fs-store";
import { useEditorStore } from "@/stores/editor-store";
import { usePdfStore } from "@/stores/pdf-store";
import { startFsWatcher, type FsEvent } from "@/lib/fs/fs-watcher-client";
import { compileLatex } from "@/lib/latex-compiler";

const COMPILE_DEBOUNCE_MS = 500;

export function useFsStartup() {
  const loadTree = useFsStore((s) => s.loadTree);
  const applyEvent = useFsStore((s) => s.applyEvent);
  const openFile = useEditorStore((s) => s.openFile);
  const startedRef = useRef(false);
  const compileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

    (async () => {
      await loadTree();
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

      // Any watched-file change → recompile.
      if (
        event.type === "add" ||
        event.type === "change" ||
        event.type === "unlink"
      ) {
        scheduleCompile();
      }
    };

    const handle = startFsWatcher(handler, (status) => {
      if (status === "connected") {
        // Resync tree after reconnect in case we missed events.
        loadTree();
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
      }
    });

    return () => {
      handle.close();
      unsubEditor();
      if (compileTimerRef.current) clearTimeout(compileTimerRef.current);
    };
  }, [applyEvent, loadTree, openFile]);
}
