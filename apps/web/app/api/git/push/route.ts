import { NextResponse } from "next/server";
import { gitRun } from "@/lib/git/git-runner";
import { NoProjectSelectedError } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await gitRun(["push"]);
    if (result.exitCode !== 0) {
      return NextResponse.json(
        { error: result.stderr || result.stdout || "git push failed" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      output: result.stdout.trim(),
    });
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
