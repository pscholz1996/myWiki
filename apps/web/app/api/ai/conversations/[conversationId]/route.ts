import { NextResponse } from "next/server";
import {
  deleteAiConversation,
  readAiConversation,
} from "@/lib/ai/conversations";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: { conversationId: string } },
) {
  try {
    const projectDir = getProjectDir();
    const conversation = await readAiConversation(
      projectDir,
      context.params.conversationId,
    );
    if (!conversation) {
      return NextResponse.json(
        { error: "conversation-not-found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ conversation });
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

export async function DELETE(
  _req: Request,
  context: { params: { conversationId: string } },
) {
  try {
    const projectDir = getProjectDir();
    await deleteAiConversation(projectDir, context.params.conversationId);
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
