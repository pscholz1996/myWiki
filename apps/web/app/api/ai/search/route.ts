import { NextResponse } from "next/server";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import { resolveKbRef } from "@/lib/project/kb-registry";
import { searchAiKnowledgeBase } from "@/lib/ai/knowledge-base";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      query?: string;
      topK?: number;
      project?: string;
    };
    const query = body.query?.trim();

    if (!query) {
      return NextResponse.json({ error: "Missing query" }, { status: 400 });
    }

    // External callers (e.g. Claude Code querying from another workspace)
    // may address a KB by registered name or absolute path — resolved
    // without touching the globally-selected project, so a UI session in
    // another KB is never flipped underneath the user.
    let projectDir: string;
    const projectRef = body.project?.trim();
    if (projectRef) {
      const resolved = resolveKbRef(projectRef);
      if (!resolved) {
        return NextResponse.json(
          { error: "unknown-project", project: projectRef },
          { status: 404 },
        );
      }
      projectDir = resolved;
    } else {
      projectDir = getProjectDir();
    }

    const hits = await searchAiKnowledgeBase(projectDir, query, body.topK ?? 5);

    return NextResponse.json({ query, hits });
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
