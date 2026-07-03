import { NextResponse } from "next/server";
import {
  deleteAiConversation,
  readAiConversation,
} from "@/lib/ai/conversations";
import { closeLiveSession } from "@/lib/ai/agent";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import { MAIN_CONVERSATION_ID } from "@/lib/ai/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// There's exactly one conversation per project (see MAIN_CONVERSATION_ID),
// so this route is singular and unparameterized — no id to pick between.

export async function GET() {
  try {
    const projectDir = getProjectDir();
    const conversation = await readAiConversation(
      projectDir,
      MAIN_CONVERSATION_ID,
    );
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

// Clears the conversation so the next message starts a fresh Claude Agent
// SDK session — the whole point of a single continuing conversation is
// that it always resumes, so "start over" has to be an explicit action
// rather than something that happens by switching to a new one.
export async function DELETE() {
  try {
    const projectDir = getProjectDir();
    // Must close the live SDK session together with deleting the conversation
    // file — otherwise the next message would reuse an in-process session
    // still tied to the just-deleted sdkSessionId instead of genuinely
    // starting over.
    closeLiveSession(projectDir);
    await deleteAiConversation(projectDir, MAIN_CONVERSATION_ID);
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
