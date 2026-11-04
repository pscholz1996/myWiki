import { NextResponse } from "next/server";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import {
  resolveProjectDirForRequest,
  UnknownKbError,
} from "@/lib/project/kb-registry";
import {
  deleteAiSource,
  updateAiSourceMetadata,
} from "@/lib/ai/knowledge-base";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  req: Request,
  context: { params: Promise<{ sourceId: string }> },
) {
  try {
    const { sourceId } = await context.params;
    const projectRef = new URL(req.url).searchParams.get("project");
    const projectDir = resolveProjectDirForRequest(projectRef, getProjectDir);
    const manifest = await deleteAiSource(projectDir, sourceId);
    return NextResponse.json(manifest);
  } catch (error) {
    if (error instanceof UnknownKbError) {
      return NextResponse.json(
        { error: "unknown-project", project: error.ref },
        { status: 404 },
      );
    }
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

export async function PATCH(
  req: Request,
  context: { params: Promise<{ sourceId: string }> },
) {
  let body: {
    title?: unknown;
    authors?: unknown;
    year?: unknown;
    project?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "bad-request", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const title = typeof body.title === "string" ? body.title : undefined;
  const authors = Array.isArray(body.authors)
    ? body.authors.filter((a): a is string => typeof a === "string")
    : undefined;
  const year = typeof body.year === "string" ? body.year : undefined;

  try {
    const { sourceId } = await context.params;
    const projectDir = resolveProjectDirForRequest(
      typeof body.project === "string" ? body.project : null,
      getProjectDir,
    );
    const source = await updateAiSourceMetadata(projectDir, sourceId, {
      title,
      authors,
      year,
    });
    return NextResponse.json(source);
  } catch (error) {
    if (error instanceof UnknownKbError) {
      return NextResponse.json(
        { error: "unknown-project", project: error.ref },
        { status: 404 },
      );
    }
    if (error instanceof NoProjectSelectedError) {
      return NextResponse.json(
        { error: "no-project-selected" },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Source not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
