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
 */
export function gitRun(args: string[]): Promise<GitResult> {
  const cwd = getProjectDir();
  return new Promise((resolve) => {
    execFile(
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
  });
}

/** Convenience: run a git command and return trimmed stdout if exitCode === 0, else null. */
export async function gitRunOk(args: string[]): Promise<string | null> {
  const result = await gitRun(args);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}
