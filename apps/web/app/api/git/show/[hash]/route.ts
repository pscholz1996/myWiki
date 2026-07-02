import { NextResponse } from "next/server";
import { gitRun, gitRunOk, isValidGitHash } from "@/lib/git/git-runner";
import { NoProjectSelectedError, getProjectDir } from "@/lib/fs/project-dir";
import { resolveInProject } from "@/lib/fs/sandbox";
import { GIT_LOG_FORMAT, parseGitLog, type GitLogEntry } from "@/lib/git/git-log-format";
import {
  parseNameStatus,
  type GitCommitFileEntry,
} from "@/lib/git/commit-detail-format";
import { parseUnifiedDiff, type ParsedDiff } from "@/lib/git/diff-format";

export const dynamic = "force-dynamic";

export interface GitShowResponse {
  commit: GitLogEntry | null;
  files: GitCommitFileEntry[];
  diff: (ParsedDiff & { path: string }) | null;
}

// The empty blob — a well-known, always-present git object (the SHA-1 of
// zero bytes). Used as a stand-in for "this side of the diff has no file"
// (added/deleted files, or a root commit with no parent).
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

// Resolves a "<rev>:<path>" object expression to itself if it names a real
// blob, else EMPTY_BLOB. No "^{blob}" dereference suffix — appending one
// paradoxically breaks resolution of an already-unambiguous <tree-ish>:<path>
// expression (reproduced directly against git 2.50.1; the colon-path form
// alone is already exactly a blob reference and needs no further coercion).
async function resolveBlobRef(revExpr: string): Promise<string> {
  const exists = await gitRunOk(["rev-parse", "--verify", "--quiet", revExpr]);
  return exists ? revExpr : EMPTY_BLOB;
}

// EMPTY_BLOB's SHA is a well-known constant, but the object itself is only
// physically present in a repo's object store if something has actually
// written it before (e.g. an empty file was ever committed) — reproduced
// directly: `git diff` against it fails with "fatal: bad object" on a small
// repo that's never happened to create one. `git hash-object -w` is a
// idempotent no-op if it already exists, so it's safe to call before every
// add/delete/root-commit diff rather than trying to detect staleness.
async function ensureEmptyBlobExists(): Promise<void> {
  await gitRun(["hash-object", "-w", "--stdin"], { input: "" });
}

export async function GET(
  req: Request,
  context: { params: Promise<{ hash: string }> },
) {
  try {
    const { hash } = await context.params;
    if (!isValidGitHash(hash)) {
      return NextResponse.json({ error: "Invalid commit hash" }, { status: 400 });
    }

    const projectDir = getProjectDir();
    const { searchParams } = new URL(req.url);
    const path = searchParams.get("path");
    if (path) {
      // Validate the path stays inside the project before it reaches git.
      resolveInProject(projectDir, path);
    }

    const showResult = await gitRun([
      "show",
      `--format=${GIT_LOG_FORMAT}`,
      "--name-status",
      hash,
    ]);

    if (showResult.exitCode !== 0) {
      return NextResponse.json(
        { error: showResult.stderr || "Commit not found" },
        { status: 404 },
      );
    }

    const sepIdx = showResult.stdout.indexOf("\n\n");
    const headerPart =
      sepIdx === -1 ? showResult.stdout : showResult.stdout.slice(0, sepIdx);
    const bodyPart = sepIdx === -1 ? "" : showResult.stdout.slice(sepIdx + 2);

    const commit = parseGitLog(headerPart)[0] ?? null;
    const files = parseNameStatus(bodyPart);

    let diff: GitShowResponse["diff"] = null;
    if (path) {
      // `git show <hash> -- <path>` (and every commit-range-plus-pathspec
      // variant) silently produces NO output for a path that no longer
      // exists in the current working tree/index, even though the
      // historical diff is perfectly real — reproduced against this
      // project's own repo. Resolving each side to its blob object and
      // diffing those directly sidesteps pathspec matching entirely and
      // works regardless of the file's current-tree state (renamed,
      // deleted, or a root commit with no parent).
      const oldPath = files.find((f) => f.path === path)?.oldPath ?? path;
      // "<hash>^:<path>" as one compound expression (not a separately
      // resolved parent hash) — a root commit's "^" simply fails to
      // resolve, which correctly falls back to EMPTY_BLOB below.
      const newRef = await resolveBlobRef(`${hash}:${path}`);
      const oldRef = await resolveBlobRef(`${hash}^:${oldPath}`);

      if (newRef === EMPTY_BLOB || oldRef === EMPTY_BLOB) {
        await ensureEmptyBlobExists();
      }

      const diffResult = await gitRun(["diff", "--no-color", oldRef, newRef]);
      // A blob has no path of its own, so when one side is EMPTY_BLOB (an
      // added or deleted file) git prints that raw SHA as the "a/"/"b/"
      // filename instead of a real path. Swap in the conventional
      // "/dev/null" git itself uses for the same case in a normal
      // (non-blob-diff) invocation, so it reads the same way.
      const diffText = (
        diffResult.exitCode === 0 ? diffResult.stdout : ""
      ).replaceAll(EMPTY_BLOB, "dev/null");
      const parsed = parseUnifiedDiff(diffText);
      diff = { ...parsed, path };
    }

    return NextResponse.json({ commit, files, diff } satisfies GitShowResponse);
  } catch (error) {
    if (error instanceof NoProjectSelectedError) {
      return NextResponse.json(
        { error: "no-project-selected" },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    const code = /outside|absolute|empty|invalid/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status: code });
  }
}
