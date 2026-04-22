import { NextResponse } from "next/server";
import { gitRun } from "@/lib/git/git-runner";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import { resolveInProject } from "@/lib/fs/sandbox";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const paths: unknown = body?.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return NextResponse.json(
        { error: "Missing 'paths' array in request body" },
        { status: 400 },
      );
    }

    const projectDir = getProjectDir();
    const safePaths: string[] = [];
    for (const p of paths) {
      if (typeof p !== "string") {
        return NextResponse.json(
          { error: "All paths must be strings" },
          { status: 400 },
        );
      }
      resolveInProject(projectDir, p);
      safePaths.push(p);
    }

    const result = await gitRun(["restore", "--staged", "--", ...safePaths]);
    if (result.exitCode !== 0) {
      return NextResponse.json(
        { error: result.stderr || "git restore --staged failed" },
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
