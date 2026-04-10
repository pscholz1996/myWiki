import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ALLOWED_EXTS,
  BUILD_DIR_NAME,
  EXCLUDED_DIRS,
  getProjectDir,
} from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";

async function maxSourceMtime(projectDir: string): Promise<number> {
  let max = 0;
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTS.has(ext)) continue;
        const stat = await fs.stat(path.join(dir, entry.name));
        if (stat.mtimeMs > max) max = stat.mtimeMs;
      }
    }
  }
  await walk(projectDir);
  return max;
}

/**
 * GET /api/pdf/cached
 * Returns the cached PDF if its mtime is >= every source file's mtime.
 * Returns 404 if no cache exists or the cache is stale.
 */
export async function GET() {
  try {
    const projectDir = getProjectDir();
    const pdfPath = path.posix.join(projectDir, BUILD_DIR_NAME, "out.pdf");

    let pdfStat;
    try {
      pdfStat = await fs.stat(pdfPath);
    } catch {
      return NextResponse.json({ error: "No cached PDF" }, { status: 404 });
    }

    const newestSource = await maxSourceMtime(projectDir);
    if (pdfStat.mtimeMs < newestSource) {
      return NextResponse.json({ error: "Cached PDF is stale" }, { status: 404 });
    }

    const buf = await fs.readFile(pdfPath);
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=document.pdf",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
