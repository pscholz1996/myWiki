import { NextResponse } from "next/server";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import { deleteAiSources } from "@/lib/ai/knowledge-base";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { sourceIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "bad-request", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const sourceIds = Array.isArray(body.sourceIds)
    ? body.sourceIds.filter((id): id is string => typeof id === "string")
    : [];

  if (sourceIds.length === 0) {
    return NextResponse.json(
      { error: "empty-selection", message: "No source IDs provided." },
      { status: 400 },
    );
  }

  try {
    const projectDir = getProjectDir();
    const manifest = await deleteAiSources(projectDir, sourceIds);
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
