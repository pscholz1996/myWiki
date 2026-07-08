import { NextResponse } from "next/server";
import { submitClaudeLoginCode } from "@/lib/ai/claude-login";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { loginId?: unknown; code?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const loginId = typeof body.loginId === "string" ? body.loginId : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!loginId || !code) {
    return NextResponse.json(
      { error: "Both loginId and code are required." },
      { status: 400 },
    );
  }

  const submitted = submitClaudeLoginCode(loginId, code);
  if (!submitted) {
    return NextResponse.json(
      { error: "This sign-in attempt has already finished or expired." },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}
