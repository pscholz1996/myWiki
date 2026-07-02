import { NextResponse } from "next/server";
import { gitRun, isValidGitHash } from "@/lib/git/git-runner";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import { resolveInProject } from "@/lib/fs/sandbox";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const hash: unknown = body?.hash;
    const path: unknown = body?.path;

    if (typeof hash !== "string" || !isValidGitHash(hash)) {
      return NextResponse.json({ error: "Invalid commit hash" }, { status: 400 });
    }
    if (typeof path !== "string" || !path) {
      return NextResponse.json({ error: "Missing 'path'" }, { status: 400 });
    }

    const projectDir = getProjectDir();
    resolveInProject(projectDir, path);

    // Working-tree only — never auto-commits, matching VS Code's own
    // "Restore Contents" behavior. The chokidar watcher picks up this
    // external write the same way it picks up any other out-of-band git
    // operation, so the editor reloads the restored content automatically.
    const result = await gitRun(["restore", `--source=${hash}`, "--", path]);
    if (result.exitCode !== 0) {
      return NextResponse.json(
        { error: result.stderr || "git restore failed" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
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
