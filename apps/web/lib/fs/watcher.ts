import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import { ALLOWED_EXTS, BUILD_DIR_NAME, getProjectDir } from "./project-dir";
import { createEchoTracker } from "./echo-suppression";

export type FsEventType = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

export interface FsEvent {
  type: FsEventType;
  /** POSIX-style relative path from PROJECT_DIR. */
  path: string;
}

type Listener = (event: FsEvent) => void;

let watcher: FSWatcher | null = null;
const listeners = new Set<Listener>();
export const echo = createEchoTracker(100);

function toRelativePosix(absolutePath: string, projectDir: string): string {
  const rel = path.relative(projectDir, absolutePath).replace(/\\/g, "/");
  return rel;
}

function shouldEmit(type: FsEventType, relPath: string): boolean {
  // Never forward events from excluded dirs.
  const segments = relPath.split("/");
  if (
    segments.some(
      (s) => s === ".git" || s === "node_modules" || s === BUILD_DIR_NAME,
    )
  ) {
    return false;
  }

  if (type === "addDir" || type === "unlinkDir") return true;

  const ext = path.extname(relPath).toLowerCase();
  return ALLOWED_EXTS.has(ext);
}

function getWatcher(): FSWatcher {
  if (watcher) return watcher;

  const projectDir = getProjectDir();
  watcher = chokidar.watch(projectDir, {
    ignored: (target) => {
      const rel = toRelativePosix(target, projectDir);
      if (rel === "") return false;
      const first = rel.split("/")[0];
      return (
        first === ".git" || first === "node_modules" || first === BUILD_DIR_NAME
      );
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
  });

  const dispatch = (type: FsEventType) => (absPath: string) => {
    const absPathPosix = absPath.replace(/\\/g, "/");
    const rel = toRelativePosix(absPath, projectDir);
    if (!shouldEmit(type, rel)) return;
    if (
      (type === "add" || type === "change") &&
      echo.shouldSuppress(absPathPosix)
    )
      return;
    const event: FsEvent = { type, path: rel };
    for (const listener of listeners) listener(event);
  };

  watcher.on("add", dispatch("add"));
  watcher.on("change", dispatch("change"));
  watcher.on("unlink", dispatch("unlink"));
  watcher.on("addDir", dispatch("addDir"));
  watcher.on("unlinkDir", dispatch("unlinkDir"));

  return watcher;
}

export function subscribe(listener: Listener): () => void {
  getWatcher();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
