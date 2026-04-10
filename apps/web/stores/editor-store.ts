import { create } from "zustand";
import { readFile, writeFile } from "@/lib/fs/fs-client";

const WRITE_DEBOUNCE_MS = 300;

interface EditorState {
  activePath: string | null;
  /** Kind of the active file — "text" means editable in CodeMirror. */
  activeKind: "text" | "binary" | null;
  /** Current in-editor buffer for text files. */
  buffer: string;
  /** Data URL for binary previews. */
  activeDataUrl: string | null;
  /** True while a local edit is queued to be written. Used to gate watcher reloads. */
  writePending: boolean;
  loading: boolean;
  loadError: string | null;
  saveError: string | null;

  openFile: (path: string) => Promise<void>;
  closeFile: () => void;
  setBuffer: (next: string) => void;
  /** Called by the fs-watcher when the active file changed externally. */
  reloadFromDisk: () => Promise<void>;
  /** Called by the fs-watcher when the active file was deleted externally. */
  handleExternalDelete: () => void;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

async function flushWrite(
  get: () => EditorState,
  set: (p: Partial<EditorState>) => void,
) {
  const { activePath, buffer, activeKind } = get();
  if (!activePath || activeKind !== "text") {
    set({ writePending: false });
    return;
  }
  try {
    await writeFile(activePath, buffer);
    set({ saveError: null, writePending: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Save failed";
    set({ saveError: message, writePending: false });
  }
}

export const useEditorStore = create<EditorState>((set, get) => ({
  activePath: null,
  activeKind: null,
  buffer: "",
  activeDataUrl: null,
  writePending: false,
  loading: false,
  loadError: null,
  saveError: null,

  async openFile(path) {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
      await flushWrite(get, (p) => set(p));
    }

    set({
      activePath: path,
      activeKind: null,
      buffer: "",
      activeDataUrl: null,
      loading: true,
      loadError: null,
    });

    try {
      const res = await readFile(path);
      if (res.type === "text") {
        set({ activeKind: "text", buffer: res.content, loading: false });
      } else {
        set({
          activeKind: "binary",
          activeDataUrl: res.dataUrl,
          loading: false,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to open file";
      set({ loadError: message, loading: false });
    }
  },

  closeFile() {
    set({
      activePath: null,
      activeKind: null,
      buffer: "",
      activeDataUrl: null,
      writePending: false,
    });
  },

  setBuffer(next) {
    set({ buffer: next, writePending: true });
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flushWrite(get, (p) => set(p));
    }, WRITE_DEBOUNCE_MS);
  },

  async reloadFromDisk() {
    const { activePath, writePending } = get();
    if (!activePath) return;
    if (writePending) return; // skip — our pending write will land after
    try {
      const res = await readFile(activePath);
      if (res.type === "text") set({ buffer: res.content });
      else set({ activeDataUrl: res.dataUrl });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to reload file";
      set({ loadError: message });
    }
  },

  handleExternalDelete() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    set({
      activePath: null,
      activeKind: null,
      buffer: "",
      activeDataUrl: null,
      writePending: false,
    });
  },
}));
