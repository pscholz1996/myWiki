import fs from "node:fs";
import path from "node:path";

let cached: string | null = null;

/**
 * Returns the absolute, realpath-resolved PROJECT_DIR.
 * Validates on first call; throws a clear error if unset or missing.
 * Ensures `.openprism/` and `.openprism/.gitignore` exist.
 */
export function getProjectDir(): string {
  if (cached) return cached;

  const raw = process.env.PROJECT_DIR;
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      "PROJECT_DIR is not set. Add PROJECT_DIR=<path-to-your-latex-project> to apps/web/.env.local.",
    );
  }

  const resolved = path.resolve(raw.trim());

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `PROJECT_DIR does not exist: ${resolved}. Create the directory or fix the path in apps/web/.env.local.`,
    );
  }

  const stats = fs.statSync(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`PROJECT_DIR must be a directory: ${resolved}`);
  }

  // Resolve symlinks for consistency. Keep native path format for system operations.
  const real = fs.realpathSync(resolved);

  // Ensure .openlatex/ exists with a .gitignore that hides its contents.
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
