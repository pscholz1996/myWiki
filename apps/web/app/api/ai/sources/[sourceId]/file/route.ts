import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import { getAiSourceFilePath, getAiSourceRecord } from "@/lib/ai/knowledge-base";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  markdown: "text/markdown",
  text: "text/plain",
};

export async function GET(
  _req: Request,
  context: { params: Promise<{ sourceId: string }> },
) {
  try {
    const { sourceId } = await context.params;
    const projectDir = getProjectDir();
    const source = await getAiSourceRecord(projectDir, sourceId);

    if (!source) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    const bytes = await fs.readFile(getAiSourceFilePath(projectDir, source));

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": CONTENT_TYPES[source.kind] ?? "application/octet-stream",
        "Content-Disposition": `inline; filename="${source.originalName}"`,
      },
    });
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
