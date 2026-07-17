import { NextResponse } from "next/server";
import { interruptLiveSession } from "@/lib/ai/agent";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import { MAIN_CONVERSATION_ID } from "@/lib/ai/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The stop button: aborts the running turn of one conversation. The
 * session itself survives — the next message resumes with full context.
 * Whatever text the turn produced before the interrupt is persisted by the
 * still-open /api/ai/chat stream, which ends normally after the abort.
 */
export async function POST(req: Request) {
  try {
    const projectDir = getProjectDir();
    const body = (await req.json().catch(() => ({}))) as {
      conversationId?: string;
    };
    const stopped = await interruptLiveSession(
      projectDir,
      body.conversationId ?? MAIN_CONVERSATION_ID,
    );
    return NextResponse.json({ stopped });
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
