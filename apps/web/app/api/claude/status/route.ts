import { NextResponse } from "next/server";
import { getClaudeAuthStatus } from "@/lib/ai/claude-login";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Account-level state, same as /api/gh/status — not scoped to whichever
// project happens to be open.
export async function GET() {
  const status = await getClaudeAuthStatus();
  return NextResponse.json(status);
}
