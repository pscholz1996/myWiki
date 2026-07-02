import { NextResponse } from "next/server";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import { listAiConversations } from "@/lib/ai/conversations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const projectDir = getProjectDir();
    const conversations = await listAiConversations(projectDir);
    return NextResponse.json({ conversations });
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
