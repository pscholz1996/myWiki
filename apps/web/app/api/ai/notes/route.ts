import { NextResponse } from "next/server";
import { saveResearchNote } from "@/lib/ai/knowledge-base";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Keep this answer": saves an assistant message verbatim as a research
 * note, which flows through the normal extract/chunk/embed path and
 * becomes searchable in future conversations. This is how the wiki learns
 * from being used — good answers stop being ephemeral chat scrollback.
 */
export async function POST(req: Request) {
  try {
    const projectDir = getProjectDir();
    const body = (await req.json()) as {
      title?: string;
      content?: string;
      drawsOnSourceIds?: string[];
    };
    const title = body.title?.trim();
    const content = body.content?.trim();
    if (!title || !content) {
      return NextResponse.json(
        { error: "title and content are required" },
        { status: 400 },
      );
    }

    const note = await saveResearchNote({
      projectDir,
      title: title.slice(0, 120),
      content,
      drawsOnSourceIds: body.drawsOnSourceIds,
    });
    return NextResponse.json({ note });
  } catch (error) {
    if (error instanceof NoProjectSelectedError) {
      return NextResponse.json({ error: "no-project-selected" }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
