import { create } from "zustand";
import { readFile } from "@/lib/fs/fs-client";

/**
 * Holds the source PDF currently shown in the viewer pane. Unlike the old
 * compile-preview store this is driven purely by opening PDF files from the
 * project (sources, norms, papers) — there is no build step.
 */
interface ViewerState {
  /** Project-relative path of the open PDF, or null when the pane is empty. */
  path: string | null;
  data: Uint8Array | null;
  loading: boolean;
  error: string | null;
  /** When set, the viewer scrolls to this page number. Cleared after scroll. */
  scrollToPage: number | null;

  openPdf: (path: string, page?: number) => Promise<void>;
  close: () => void;
  setScrollToPage: (page: number | null) => void;
  /** Called by the fs-watcher when the open PDF changed on disk. */
  reloadFromDisk: () => Promise<void>;
}

async function loadPdfBytes(path: string): Promise<Uint8Array> {
  const res = await readFile(path);
  if (res.type !== "binary") {
    throw new Error(`Not a binary file: ${path}`);
  }
  const buf = await (await fetch(res.dataUrl)).arrayBuffer();
  return new Uint8Array(buf);
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  path: null,
  data: null,
  loading: false,
  error: null,
  scrollToPage: null,

  async openPdf(path, page) {
    set({ path, loading: true, error: null, scrollToPage: page ?? null });
    try {
      const data = await loadPdfBytes(path);
      // Ignore stale loads if another PDF was opened meanwhile.
      if (get().path !== path) return;
      set({ data, loading: false });
    } catch (error) {
      if (get().path !== path) return;
      const message =
        error instanceof Error ? error.message : "Failed to open PDF";
      set({ data: null, loading: false, error: message });
    }
  },

  close() {
    set({ path: null, data: null, loading: false, error: null });
  },

  setScrollToPage(page) {
    set({ scrollToPage: page });
  },

  async reloadFromDisk() {
    const { path } = get();
    if (!path) return;
    try {
      const data = await loadPdfBytes(path);
      if (get().path !== path) return;
      set({ data });
    } catch {
      // keep showing the last good render
    }
  },
}));
