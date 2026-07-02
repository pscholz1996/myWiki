import { NextResponse } from "next/server";
import { gitRun } from "@/lib/git/git-runner";
import { NoProjectSelectedError } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";

// Opt-in only — git is never required to use OpenLatex. This is the one
// explicit action that turns a plain folder into a repo; nothing else in
// the app calls `git init` implicitly (Publish to GitHub does, but only
// after the user explicitly asks to publish).
export async function POST() {
  try {
    const result = await gitRun(["init"]);
    if (result.exitCode !== 0) {
      return NextResponse.json(
        { error: result.stderr || "git init failed" },
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
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
