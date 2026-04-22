import { create } from "zustand";

interface PdfState {
  pdfData: Uint8Array | null;
  compileError: string | null;
  isCompiling: boolean;
  /** When set, PdfViewer scrolls to this page number. Cleared after scroll. */
  scrollToPage: number | null;
  /** Whether opening a file auto-scrolls the PDF to its first heading. */
  syncScrollEnabled: boolean;
  /** Outline title → 1-indexed page number. Built by PdfViewer on load. */
  outlineMap: Map<string, number>;

  setPdfData: (data: Uint8Array | null) => void;
  setCompileError: (error: string | null) => void;
  setIsCompiling: (value: boolean) => void;
  setScrollToPage: (page: number | null) => void;
  setSyncScrollEnabled: (enabled: boolean) => void;
  setOutlineMap: (map: Map<string, number>) => void;
  /** Look up a heading in the outline map. Returns page number or null. */
  findPage: (heading: string) => number | null;
}

export const usePdfStore = create<PdfState>((set) => ({
  pdfData: null,
  compileError: null,
  isCompiling: false,
  scrollToPage: null,
  syncScrollEnabled: true,
  outlineMap: new Map(),

  setPdfData: (data) => set({ pdfData: data, compileError: null }),
  setCompileError: (error) => set({ compileError: error, pdfData: null }),
  setIsCompiling: (value) => set({ isCompiling: value }),
  setScrollToPage: (page) => set({ scrollToPage: page }),
  setSyncScrollEnabled: (enabled) => set({ syncScrollEnabled: enabled }),
  setOutlineMap: (map) => set({ outlineMap: map }),
  findPage: (heading: string): number | null => {
    const { outlineMap } = usePdfStore.getState();
    for (const [title, pg] of outlineMap) {
      if (title === heading) return pg;
    }
    for (const [title, pg] of outlineMap) {
      if (title.includes(heading) || heading.includes(title)) return pg;
    }
    return null;
  },
}));
