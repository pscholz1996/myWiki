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

function errorResponse(error: unknown) {
  if (error instanceof NoProjectSelectedError) {
    return NextResponse.json({ error: "no-project-selected" }, { status: 409 });
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return NextResponse.json({ error: message }, { status: 500 });
}

// One conversation by id; no id falls back to the legacy single
// conversation so pre-multi-conversation clients keep working.
export async function GET(req: Request) {
  try {
    const projectDir = getProjectDir();
    const id = new URL(req.url).searchParams.get("id") ?? MAIN_CONVERSATION_ID;
    const conversation = await readAiConversation(projectDir, id);
    return NextResponse.json({ conversation });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const projectDir = getProjectDir();
    const id = new URL(req.url).searchParams.get("id") ?? MAIN_CONVERSATION_ID;
    // Must close the live SDK session together with deleting the
    // conversation file — otherwise a next message under the same id would
    // reuse an in-process session tied to the just-deleted sdkSessionId.
    closeLiveSession(projectDir, id);
    await deleteAiConversation(projectDir, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
