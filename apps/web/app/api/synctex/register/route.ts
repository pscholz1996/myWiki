import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  BUILD_DIR_NAME,
  NoProjectSelectedError,
  getProjectDir,
} from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";

/**
 * POST /api/synctex/register
 *
 * Registers the persisted cached build (.openlatex/out.pdf + out.synctex.gz)
 * with the latex-api so forward/inverse sync works against the cached PDF that
 * was loaded at startup, without recompiling. Returns the new buildId.
 *
 * Returns 404 if the cached artifacts don't exist (caller falls back to compile).
 */
export async function POST() {
  try {
    const projectDir = getProjectDir();
    const buildDir = path.join(projectDir, BUILD_DIR_NAME);
    const pdfPath = path.join(buildDir, "out.pdf");
    const gzPath = path.join(buildDir, "out.synctex.gz");

    const have =
      (await fs
        .access(pdfPath)
        .then(() => true)
        .catch(() => false)) &&
      (await fs
        .access(gzPath)
        .then(() => true)
        .catch(() => false));
    if (!have) {
      return NextResponse.json({ error: "no-cached-synctex" }, { status: 404 });
    }

    const latexApiUrl = process.env.LATEX_API_URL || "http://localhost:3001";
    let upstream: Response;
    try {
      upstream = await fetch(`${latexApiUrl}/builds/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workDir: buildDir, mainFileName: "out" }),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "upstream-failed";
      return NextResponse.json({ error: message }, { status: 502 });
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: text || "register-failed" },
        { status: upstream.status },
      );
    }

    const data = (await upstream.json()) as { buildId: string };
    return NextResponse.json({ buildId: data.buildId });
  } catch (error) {
    if (error instanceof NoProjectSelectedError) {
      return NextResponse.json({ error: "no-project-selected" }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
