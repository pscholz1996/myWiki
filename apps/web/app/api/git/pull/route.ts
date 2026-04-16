import { NextResponse } from "next/server";
import { gitRun } from "@/lib/git/git-runner";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await gitRun(["pull"]);
    if (result.exitCode !== 0) {
      return NextResponse.json(
        { error: result.stderr || result.stdout || "git pull failed" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      output: result.stdout.trim(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
