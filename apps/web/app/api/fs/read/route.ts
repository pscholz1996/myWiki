import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getProjectDir, TEXT_EXTS, ALLOWED_EXTS } from "@/lib/fs/project-dir";
import { resolveInProject } from "@/lib/fs/sandbox";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
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

    // Guard against symlink escapes at runtime.
    const real = await fs.realpath(absPath);
    const realNormalized = real.replace(/\\/g, "/");
    const rootWithSep = projectDir.endsWith("/")
      ? projectDir
      : `${projectDir}/`;
    if (
      realNormalized !== projectDir &&
      !realNormalized.startsWith(rootWithSep)
    ) {
      return NextResponse.json(
        { error: "Path escapes project" },
        { status: 400 },
      );
    }

    const ext = path.extname(absPath).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return NextResponse.json(
        { error: "File type not allowed" },
        { status: 400 },
      );
    }

    const stat = await fs.stat(absPath);

    if (TEXT_EXTS.has(ext)) {
      const content = await fs.readFile(absPath, "utf8");
      return NextResponse.json({
        path: userPath,
        type: "text",
        content,
        mtime: stat.mtimeMs,
      });
    }

    const buf = await fs.readFile(absPath);
    const base64 = buf.toString("base64");
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".pdf"
            ? "application/pdf"
            : "application/octet-stream";
    return NextResponse.json({
      path: userPath,
      type: "binary",
      dataUrl: `data:${mime};base64,${base64}`,
      mtime: stat.mtimeMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const code = /outside|absolute|empty|invalid/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status: code });
  }
}
