import { NextResponse } from "next/server";
import { gitRun, gitRunOk } from "@/lib/git/git-runner";

export const dynamic = "force-dynamic";

export type GitFileStatus =
  | "modified"
  | "staged"
  | "staged-modified"
  | "untracked"
  | "deleted"
  | "staged-deleted"
  | "renamed"
  | "conflicted";

export interface GitFileEntry {
  path: string;
  status: GitFileStatus;
}

export interface GitStatusResponse {
  isGitRepo: boolean;
  files: GitFileEntry[];
  stagedCount: number;
  modifiedCount: number;
  untrackedCount: number;
}

/**
 * Parse `git status --porcelain=v1` output into structured file statuses.
 *
 * Porcelain v1 format: XY <path>
 * X = index (staging area), Y = working tree
 * See: https://git-scm.com/docs/git-status#_short_format
 */
function parsePorcelain(output: string): GitFileEntry[] {
  const entries: GitFileEntry[] = [];
  const lines = output.split("\n").filter((l) => l.length >= 3);

  for (const line of lines) {
    const X = line[0]; // index status
    const Y = line[1]; // worktree status
    // Porcelain v1: XY followed by a space, then the path.
    // For renames: "R  old -> new" — we take the new path.
    let filePath = line.slice(3);

    // Handle rename: "old -> new"
    const arrowIdx = filePath.indexOf(" -> ");
    if (arrowIdx !== -1) {
      filePath = filePath.slice(arrowIdx + 4);
    }

    // Normalize path separators
    filePath = filePath.replace(/\\/g, "/");

    let status: GitFileStatus;

    // Conflict markers: both modified, added by both, etc.
    if (
      (X === "U" || Y === "U") ||
      (X === "A" && Y === "A") ||
      (X === "D" && Y === "D")
    ) {
      status = "conflicted";
    } else if (X === "?" && Y === "?") {
      status = "untracked";
    } else if (X === "R") {
      status = "renamed";
    } else if (X === "D" && Y === " ") {
      status = "staged-deleted";
    } else if (Y === "D") {
      status = "deleted";
    } else if (
      (X === "M" || X === "A") &&
      (Y === "M" || Y === "D")
    ) {
      status = "staged-modified";
    } else if (X === "M" || X === "A" || X === "R") {
      status = "staged";
    } else if (Y === "M") {
      status = "modified";
    } else {
      // Fallback for any other combinations
      status = "modified";
    }

    entries.push({ path: filePath, status });
  }

  return entries;
}

export async function GET() {
  try {
    const revParse = await gitRunOk(["rev-parse", "--is-inside-work-tree"]);
    if (revParse !== "true") {
      return NextResponse.json({
        isGitRepo: false,
        files: [],
        stagedCount: 0,
        modifiedCount: 0,
        untrackedCount: 0,
      } satisfies GitStatusResponse);
    }

    const result = await gitRun(["status", "--porcelain=v1"]);
    const files = result.exitCode === 0 ? parsePorcelain(result.stdout) : [];

    let stagedCount = 0;
    let modifiedCount = 0;
    let untrackedCount = 0;

    for (const f of files) {
      if (
        f.status === "staged" ||
        f.status === "staged-modified" ||
        f.status === "staged-deleted" ||
        f.status === "renamed"
      ) {
        stagedCount++;
      }
      if (
        f.status === "modified" ||
        f.status === "staged-modified" ||
        f.status === "deleted"
      ) {
        modifiedCount++;
      }
      if (f.status === "untracked") {
        untrackedCount++;
      }
    }

    return NextResponse.json({
      isGitRepo: true,
      files,
      stagedCount,
      modifiedCount,
      untrackedCount,
    } satisfies GitStatusResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
