import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  createAiConversation,
  listAiConversations,
} from "@/lib/ai/conversations";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown) {
  if (error instanceof NoProjectSelectedError) {
    return NextResponse.json({ error: "no-project-selected" }, { status: 409 });
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return NextResponse.json({ error: message }, { status: 500 });
}

/** History list: every non-empty conversation, newest first. */
export async function GET() {
  try {
    const projectDir = getProjectDir();
    return NextResponse.json({
      conversations: await listAiConversations(projectDir),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Starts a fresh conversation and returns it. */
export async function POST(req: Request) {
  try {
    const projectDir = getProjectDir();
    const body = (await req.json().catch(() => ({}))) as { model?: string };
    const conversation = await createAiConversation({
      projectDir,
      // A real UUID from the start — the SDK's --resume needs one, and the
      // conversation id doubles as the on-disk filename.
      conversationId: randomUUID(),
      model: body.model,
    });
    return NextResponse.json({ conversation });
  } catch (error) {
    return errorResponse(error);
  }
}
