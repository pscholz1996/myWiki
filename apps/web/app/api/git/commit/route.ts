import { NextResponse } from "next/server";
import { gitRun } from "@/lib/git/git-runner";
import { NoProjectSelectedError } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message: unknown = body?.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      return NextResponse.json(
        { error: "Missing or empty 'message' in request body" },
        { status: 400 },
      );
    }

    const result = await gitRun(["commit", "-m", message.trim()]);
    if (result.exitCode !== 0) {
      return NextResponse.json(
        { error: result.stderr || result.stdout || "git commit failed" },
        { status: 500 },
      );
    }

    // Parse the commit output for confirmation
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
