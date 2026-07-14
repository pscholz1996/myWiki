import fs from "node:fs";
import path from "node:path";
import { readCurrentProject } from "@/lib/project/config";

export class NoProjectSelectedError extends Error {
  constructor() {
    super("No project selected.");
    this.name = "NoProjectSelectedError";
  }
}

/**
 * Returns the absolute, realpath-resolved path of the currently-selected
 * project. Throws NoProjectSelectedError if none is selected.
 * Ensures `.mywiki/` and `.mywiki/.gitignore` exist on every call.
 *
 * Deliberately uncached: this used to memoize its result in a module-level
 * variable, invalidated by resetProjectDirCache() when the project changed.
 * In practice that cache could go stale independently per route (reproduced
 * live: switching projects twice left one dynamic API route — but not
 * others — still resolving an earlier project, silently running git
 * commands against the wrong repo). The underlying fs work here (a JSON
 * read, a stat, a realpath) is cheap and this isn't a hot path, so the
 * simplest fix is to not cache at all rather than chase cache-invalidation
 * bugs across however many module instances a dev-mode bundler creates.
 */
export function getProjectDir(): string {
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

  const buildDir = path.join(real, ".mywiki");
  if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
  }
  const gitignore = path.join(buildDir, ".gitignore");
  // Ignore everything under .mywiki/ (the AI index,
  // conversation history — all regenerable/ephemeral) EXCEPT the knowledge
  // base's raw sources, which are real user data (uploaded PDFs/notes) and
  // should be versioned in the project's own repo like any other file.
  // Each parent directory needs its own "!" — git won't recurse into an
  // already-ignored directory to check a deeper negation.
  const desiredGitignore = "*\n!ai/\n!ai/sources/\n!ai/sources/**\n";
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, desiredGitignore, "utf8");
  } else {
    const current = fs.readFileSync(gitignore, "utf8");
    // Only upgrade the known untouched old default (blanket "ignore
    // everything") — never overwrite a gitignore that's been customized.
    if (current === "*\n") {
      fs.writeFileSync(gitignore, desiredGitignore, "utf8");
    }
  }

  return real;
}

export const BUILD_DIR_NAME = ".mywiki";
export const EXCLUDED_DIRS = new Set([".git", "node_modules", BUILD_DIR_NAME]);
export const ALLOWED_EXTS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".yaml",
  ".yml",
  ".bib",
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".pdf",
]);
export const TEXT_EXTS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".yaml",
  ".yml",
  ".bib",
]);
