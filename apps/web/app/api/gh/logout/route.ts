import { NextResponse } from "next/server";
import { GhNotInstalledError, ghRun } from "@/lib/git/gh-runner";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await ghRun(["auth", "logout", "--hostname", "github.com"]);
    if (result.exitCode !== 0) {
      return NextResponse.json(
        { error: result.stderr || "gh auth logout failed" },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof GhNotInstalledError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
