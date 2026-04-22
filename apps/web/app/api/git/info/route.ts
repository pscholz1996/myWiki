import { NextResponse } from "next/server";
import { gitRun, gitRunOk } from "@/lib/git/git-runner";
import { NoProjectSelectedError } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";

export interface GitInfo {
  isGitRepo: boolean;
  branch: string | null;
  remote: string | null;
  lastCommit: {
    hash: string;
    message: string;
    author: string;
    date: string;
  } | null;
  ahead: number;
  behind: number;
}

export async function GET() {
  try {
    const revParse = await gitRunOk(["rev-parse", "--is-inside-work-tree"]);
    if (revParse !== "true") {
      return NextResponse.json({
        isGitRepo: false,
        branch: null,
        remote: null,
        lastCommit: null,
        ahead: 0,
        behind: 0,
      } satisfies GitInfo);
    }

    // Branch name (empty string on detached HEAD)
    let branch = await gitRunOk(["branch", "--show-current"]);
    if (!branch) {
      // Detached HEAD — show short hash instead
      branch = (await gitRunOk(["rev-parse", "--short", "HEAD"])) ?? "HEAD";
    }

    // Remote URL for origin (null if no remote)
    const remote = await gitRunOk(["remote", "get-url", "origin"]);

    // Last commit info
    const SEP = "|||";
    const logFmt = `%H${SEP}%s${SEP}%an${SEP}%aI`;
    const logOutput = await gitRunOk(["log", "-1", `--format=${logFmt}`]);
    let lastCommit: GitInfo["lastCommit"] = null;
    if (logOutput) {
      const [hash, message, author, date] = logOutput.split(SEP);
      if (hash) {
        lastCommit = {
          hash: hash.slice(0, 8),
          message: message ?? "",
          author: author ?? "",
          date: date ?? "",
        };
      }
    }

    // Ahead/behind upstream
    let ahead = 0;
    let behind = 0;
    const countResult = await gitRun([
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{u}",
    ]);
    if (countResult.exitCode === 0) {
      const parts = countResult.stdout.trim().split(/\s+/);
      ahead = Number.parseInt(parts[0] ?? "0", 10) || 0;
      behind = Number.parseInt(parts[1] ?? "0", 10) || 0;
    }

    return NextResponse.json({
      isGitRepo: true,
      branch,
      remote,
      lastCommit,
      ahead,
      behind,
    } satisfies GitInfo);
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
