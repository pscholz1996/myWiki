import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Bridge to the Docling conversion sidecar (tools/docling). Docling gives
 * layout-aware, reading-ordered text with real markdown tables — a large
 * quality jump over pdfjs's raw text-run concatenation, especially for
 * norms and multi-column papers. It is strictly optional: when the sidecar
 * venv isn't set up, ingestion falls back to the built-in extractors.
 */

export interface DoclingResult {
  pageCount: number;
  pages: Array<{ page: number; text: string }>;
}

// A big norm on CPU can legitimately take minutes; this is a ceiling
// against hangs, not an expectation.
const CONVERT_TIMEOUT_MS = 15 * 60 * 1000;

// stdout carries the entire extracted document as JSON — a 1,000-page norm
// is still well under this.
const MAX_STDOUT_BYTES = 256 * 1024 * 1024;

function candidatePythonPaths(): string[] {
  const override = process.env.MYWIKI_DOCLING_PYTHON;
  const fromCwd = (relative: string) =>
    path.resolve(process.cwd(), relative, "tools/docling/.venv/bin/python");
  return [
    ...(override ? [override] : []),
    // next dev/start runs with cwd at apps/web; tests and scripts may run
    // from the repo root.
    fromCwd("../.."),
    fromCwd("."),
  ];
}

function convertScriptPath(pythonPath: string): string {
  return path.join(path.dirname(pythonPath), "..", "..", "convert.py");
}

let resolvedPythonPromise: Promise<string | null> | null = null;

/** Path to the sidecar's python, or null when the venv isn't set up. */
export function resolveDoclingPython(): Promise<string | null> {
  // Kill-switch: unit tests (and any user who wants pure-JS ingestion)
  // must not spawn a Python process per PDF. Checked per call, not cached,
  // so tests can rely on it regardless of module-instance reuse.
  if (process.env.MYWIKI_DISABLE_DOCLING === "1") {
    return Promise.resolve(null);
  }
  if (!resolvedPythonPromise) {
    resolvedPythonPromise = (async () => {
      for (const candidate of candidatePythonPaths()) {
        try {
          await fs.access(candidate);
          return candidate;
        } catch {
          // try next
        }
      }
      return null;
    })();
  }
  return resolvedPythonPromise;
}

export async function isDoclingAvailable(): Promise<boolean> {
  return (await resolveDoclingPython()) !== null;
}

/**
 * Converts one document via the sidecar. Returns null when the sidecar is
 * not installed; throws when it is installed but the conversion fails
 * (callers decide whether to fall back or surface the error).
 */
export async function convertWithDocling(
  filePath: string,
): Promise<DoclingResult | null> {
  const python = await resolveDoclingPython();
  if (!python) return null;

  const { stdout } = await execFileAsync(
    python,
    [convertScriptPath(python), filePath],
    {
      timeout: CONVERT_TIMEOUT_MS,
      maxBuffer: MAX_STDOUT_BYTES,
      env: {
        ...process.env,
        // Keep HF/torch from writing progress bars that some environments
        // treat as terminal control noise.
        HF_HUB_DISABLE_PROGRESS_BARS: "1",
        TOKENIZERS_PARALLELISM: "false",
      },
    },
  );

  const parsed = JSON.parse(stdout) as DoclingResult;
  if (!Array.isArray(parsed.pages) || typeof parsed.pageCount !== "number") {
    throw new Error("Docling returned an unexpected payload");
  }
  return parsed;
}
