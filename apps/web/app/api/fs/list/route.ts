import { NextResponse } from "next/server";
import { listProjectTree } from "@/lib/fs/list";
import { NoProjectSelectedError, getProjectDir } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const projectDir = getProjectDir();
    const tree = await listProjectTree(projectDir);
    return NextResponse.json({ root: projectDir, tree });
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
