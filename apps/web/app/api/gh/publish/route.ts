import { NextResponse } from "next/server";
import { GhNotInstalledError, ghRun, ghRunOk } from "@/lib/git/gh-runner";
import { gitRun, gitRunOk } from "@/lib/git/git-runner";
import { NoProjectSelectedError, getProjectDir } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

// Project-scoped (unlike status/login/logout) — this operates on the
// project's own working tree, turning it into a GitHub-backed repo.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const name: unknown = body?.name;
    const description: unknown = body?.description;
    const visibility: unknown = body?.visibility;

    if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
      return NextResponse.json(
        {
          error:
            "Repository name must contain only letters, digits, '.', '_' or '-'.",
        },
        { status: 400 },
      );
    }
    if (visibility !== "public" && visibility !== "private") {
      return NextResponse.json(
        { error: "visibility must be 'public' or 'private'" },
        { status: 400 },
      );
    }

    const projectDir = getProjectDir();

    const isRepo = await gitRunOk(["rev-parse", "--is-inside-work-tree"]);
    if (isRepo !== "true") {
      const initResult = await gitRun(["init"]);
      if (initResult.exitCode !== 0) {
        return NextResponse.json(
          { error: initResult.stderr || "git init failed" },
          { status: 500 },
        );
      }
    }

    // No-magic choice, matching restore's never-auto-commit stance: publish
    // requires at least one real commit rather than fabricating one.
    const hasCommit = await gitRunOk(["rev-parse", "HEAD"]);
    if (!hasCommit) {
      return NextResponse.json(
        {
          error:
            "Commit your work before publishing — there's nothing to push yet.",
        },
        { status: 400 },
      );
    }

    const createArgs = [
      "repo",
      "create",
      name,
      "--source=.",
      "--remote=origin",
      "--push",
      visibility === "public" ? "--public" : "--private",
    ];
    if (typeof description === "string" && description.trim()) {
      createArgs.push("--description", description.trim());
    }

    const createResult = await ghRun(createArgs, { cwd: projectDir });
    if (createResult.exitCode !== 0) {
      return NextResponse.json(
        { error: createResult.stderr || "gh repo create failed" },
        { status: 500 },
      );
    }

    // Separate call for the URL rather than trusting repo create's own
    // stdout format — `repo view --json` has been the more stable surface
    // across gh versions.
    const url = await ghRunOk(["repo", "view", "--json", "url", "-q", ".url"], {
      cwd: projectDir,
    });

    return NextResponse.json({ ok: true, url });
  } catch (error) {
    if (error instanceof NoProjectSelectedError) {
      return NextResponse.json(
        { error: "no-project-selected" },
        { status: 409 },
      );
    }
    if (error instanceof GhNotInstalledError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
