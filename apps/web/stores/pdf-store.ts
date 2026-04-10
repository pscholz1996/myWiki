import { create } from "zustand";

interface PdfState {
  pdfData: Uint8Array | null;
  compileError: string | null;
  isCompiling: boolean;

  setPdfData: (data: Uint8Array | null) => void;
  setCompileError: (error: string | null) => void;
  setIsCompiling: (value: boolean) => void;
}

export const usePdfStore = create<PdfState>((set) => ({
  pdfData: null,
  compileError: null,
  isCompiling: false,

  setPdfData: (data) => set({ pdfData: data, compileError: null }),
  setCompileError: (error) => set({ compileError: error, pdfData: null }),
  setIsCompiling: (value) => set({ isCompiling: value }),
}));
