import fs from "node:fs";
import path from "node:path";
import { readCurrentProject } from "@/lib/project/config";

let cached: string | null = null;

export class NoProjectSelectedError extends Error {
  constructor() {
    super("No project selected.");
    this.name = "NoProjectSelectedError";
  }
}

/**
 * Returns the absolute, realpath-resolved path of the currently-selected
 * project. Throws NoProjectSelectedError if none is selected.
 * Ensures `.openlatex/` and `.openlatex/.gitignore` exist on first call.
 */
export function getProjectDir(): string {
  if (cached) return cached;

  const current = readCurrentProject();
  if (!current) {
    throw new NoProjectSelectedError();
  }

  const resolved = path.resolve(current);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Project directory does not exist: ${resolved}`);
  }

  const stats = fs.statSync(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`Project path must be a directory: ${resolved}`);
  }

  const real = fs.realpathSync(resolved);

  const buildDir = path.join(real, ".openlatex");
  if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
  }
  const gitignore = path.join(buildDir, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, "*\n", "utf8");
  }

  cached = real;
  return real;
}

/** Clears the module cache. Called after the current project is changed. */
export function resetProjectDirCache(): void {
  cached = null;
}

export const BUILD_DIR_NAME = ".openlatex";
export const EXCLUDED_DIRS = new Set([".git", "node_modules", BUILD_DIR_NAME]);
export const ALLOWED_EXTS = new Set([
  ".tex",
  ".bib",
  ".cls",
  ".sty",
  ".png",
  ".jpg",
  ".jpeg",
  ".pdf",
]);
export const TEXT_EXTS = new Set([".tex", ".bib", ".cls", ".sty"]);
