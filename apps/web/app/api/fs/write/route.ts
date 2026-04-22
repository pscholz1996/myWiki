import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getProjectDir, TEXT_EXTS } from "@/lib/fs/project-dir";
import { resolveInProject } from "@/lib/fs/sandbox";
import { echo } from "@/lib/fs/watcher";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  try {
    const url = new URL(req.url);
    const userPath = url.searchParams.get("path");
    if (!userPath) {
      return NextResponse.json(
        { error: "Missing 'path' query parameter" },
        { status: 400 },
      );
    }

    const projectDir = getProjectDir();
    const absPath = resolveInProject(projectDir, userPath);

    const ext = path.extname(absPath).toLowerCase();
    if (!TEXT_EXTS.has(ext)) {
      return NextResponse.json(
        { error: "Only text files can be written" },
        { status: 400 },
      );
    }

    const body = await req.text();

    // Ensure parent exists.
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    // Record the write before it lands so the watcher can suppress the echo.
    echo.recordWrite(absPath);

    await fs.writeFile(absPath, body, "utf8");

    const stat = await fs.stat(absPath);
    return NextResponse.json({ path: userPath, mtime: stat.mtimeMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const code = /outside|absolute|empty|invalid|only text/i.test(message)
      ? 400
      : 500;
    return NextResponse.json({ error: message }, { status: code });
  }
}
