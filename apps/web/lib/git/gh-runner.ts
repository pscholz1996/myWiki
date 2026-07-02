import { execFile } from "node:child_process";
import type { GitResult } from "@/lib/git/git-runner";

const TIMEOUT_MS = 15_000;

// Distinct from a generic failure — routes special-case this into "gh isn't
// installed, here's how to install it" instead of a raw error string, the
// same way NoProjectSelectedError gets its own JSON shape.
export class GhNotInstalledError extends Error {
  constructor() {
    super("The GitHub CLI (gh) is not installed.");
    this.name = "GhNotInstalledError";
  }
}

/**
 * Runs a `gh` command. Unlike gitRun, cwd is optional — most gh calls
 * (auth status, login, logout) are account-level, not project-scoped; only
 * commands like `gh repo create --source=.` need the project directory.
 * Throws GhNotInstalledError on ENOENT; otherwise never throws — a
 * non-zero exit is just `exitCode !== 0`, same contract as gitRun.
 */
export function ghRun(
  args: string[],
  opts?: { cwd?: string },
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { cwd: opts?.cwd, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && "code" in error && error.code === "ENOENT") {
          reject(new GhNotInstalledError());
          return;
        }
        const exitCode =
          error && "code" in error && typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0;
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode,
        });
      },
    );
  });
}

/** Convenience: run a gh command and return trimmed stdout if exitCode === 0, else null. */
export async function ghRunOk(
  args: string[],
  opts?: { cwd?: string },
): Promise<string | null> {
  const result = await ghRun(args, opts);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}
