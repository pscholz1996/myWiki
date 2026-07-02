import { NextResponse } from "next/server";
import { gitRun, gitRunOk } from "@/lib/git/git-runner";
import { NoProjectSelectedError } from "@/lib/fs/project-dir";
import { GIT_LOG_FORMAT, parseGitLog, type GitLogEntry } from "@/lib/git/git-log-format";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface GitLogResponse {
  isGitRepo: boolean;
  commits: GitLogEntry[];
  hasMore: boolean;
}

export async function GET(req: Request) {
  try {
    const revParse = await gitRunOk(["rev-parse", "--is-inside-work-tree"]);
    if (revParse !== "true") {
      return NextResponse.json({
        isGitRepo: false,
        commits: [],
        hasMore: false,
      } satisfies GitLogResponse);
    }

    const { searchParams } = new URL(req.url);
    const offset = Math.max(
      0,
      Number.parseInt(searchParams.get("offset") ?? "0", 10) || 0,
    );
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(
        1,
        Number.parseInt(searchParams.get("limit") ?? "", 10) || DEFAULT_LIMIT,
      ),
    );

    // Fetch one extra row to know whether there's a next page without a
    // separate `rev-list --count` round trip.
    const result = await gitRun([
      "log",
      "HEAD",
      `--max-count=${limit + 1}`,
      `--skip=${offset}`,
      `--format=${GIT_LOG_FORMAT}`,
    ]);

    // Exit 128 on a repo with zero commits yet ("does not have any commits
    // yet") — not an error, just an empty history.
    if (result.exitCode !== 0) {
      return NextResponse.json({
        isGitRepo: true,
        commits: [],
        hasMore: false,
      } satisfies GitLogResponse);
    }

    const parsed = parseGitLog(result.stdout);
    const hasMore = parsed.length > limit;

    return NextResponse.json({
      isGitRepo: true,
      commits: hasMore ? parsed.slice(0, limit) : parsed,
      hasMore,
    } satisfies GitLogResponse);
  } catch (error) {
    if (error instanceof NoProjectSelectedError) {
      return NextResponse.json(
        { error: "no-project-selected" },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
