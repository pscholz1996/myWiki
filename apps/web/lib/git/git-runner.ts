import { execFile } from "node:child_process";
import { getProjectDir } from "@/lib/fs/project-dir";

const TIMEOUT_MS = 10_000;

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs a git command in PROJECT_DIR.
 * Uses `execFile` (not `exec`) to avoid shell injection — args are passed as an array.
 * Returns stdout/stderr/exitCode; never throws on non-zero exit.
 * opts.input, if given, is written to the child's stdin and the stream is
 * closed — needed by commands like `git hash-object -w --stdin`. Omitted
 * for every other caller, leaving stdin untouched (unchanged behavior).
 */
export function gitRun(
  args: string[],
  opts?: { input?: string },
): Promise<GitResult> {
  const cwd = getProjectDir();
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
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
    if (opts?.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** Convenience: run a git command and return trimmed stdout if exitCode === 0, else null. */
export async function gitRunOk(args: string[]): Promise<string | null> {
  const result = await gitRun(args);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

// Args passed to execFile can't trigger shell injection, but a value like
// "--upload-pack=..." could still be misread by git as a flag rather than a
// ref if it reaches a route that accepts a caller-supplied "hash". Routes
// that take a git ref from the request (show, restore) must validate with
// this before passing it to gitRun.
const GIT_HASH_PATTERN = /^[0-9a-fA-F]{4,40}$/;

export function isValidGitHash(value: string): boolean {
  return GIT_HASH_PATTERN.test(value);
}
