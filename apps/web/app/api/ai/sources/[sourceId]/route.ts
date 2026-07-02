import { NextResponse } from "next/server";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import { deleteAiSource } from "@/lib/ai/knowledge-base";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  context: { params: { sourceId: string } },
) {
  try {
    const { sourceId } = context.params;
    const projectDir = getProjectDir();
    const manifest = await deleteAiSource(projectDir, sourceId);
    return NextResponse.json(manifest);
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
