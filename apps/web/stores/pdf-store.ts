import { create } from "zustand";

export interface SyncTexHighlight {
  page: number; // 1-based
  x: number; // PDF points, origin top-left
  y: number; // baseline (synctex `y`) in PDF points, origin top-left
  width: number; // PDF points
  height: number; // PDF points
  /** Bumped on each emit so identical coords still re-flash. */
  key: number;
}

interface PdfState {
  pdfData: Uint8Array | null;
  compileError: string | null;
  isCompiling: boolean;
  /** When set, PdfViewer scrolls to this page number. Cleared after scroll. */
  scrollToPage: number | null;
  /** Most recent build identifier, returned by the latex-api on compile. */
  buildId: string | null;
  /** Latest forward-sync hit; PdfViewer draws and fades a flash overlay. */
  synctexHighlight: SyncTexHighlight | null;

  setPdfData: (data: Uint8Array | null) => void;
  setCompileError: (error: string | null) => void;
  setIsCompiling: (value: boolean) => void;
  setScrollToPage: (page: number | null) => void;
  setBuildId: (id: string | null) => void;
  setSynctexHighlight: (highlight: SyncTexHighlight | null) => void;
}

export const usePdfStore = create<PdfState>((set) => ({
  pdfData: null,
  compileError: null,
  isCompiling: false,
  scrollToPage: null,
  buildId: null,
  synctexHighlight: null,

  setPdfData: (data) => set({ pdfData: data, compileError: null }),
  setCompileError: (error) => set({ compileError: error, pdfData: null }),
  setIsCompiling: (value) => set({ isCompiling: value }),
  setScrollToPage: (page) => set({ scrollToPage: page }),
  setBuildId: (id) => set({ buildId: id }),
  setSynctexHighlight: (highlight) => set({ synctexHighlight: highlight }),
}));
