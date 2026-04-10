import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ALLOWED_EXTS,
  BUILD_DIR_NAME,
  EXCLUDED_DIRS,
  TEXT_EXTS,
  getProjectDir,
} from "@/lib/fs/project-dir";
import { echo } from "@/lib/fs/watcher";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

interface CompileResource {
  path: string;
  content?: string;
  file?: string;
  main?: boolean;
}

/** Walk PROJECT_DIR and return every .tex/.bib/.cls/.sty/image as a resource. */
async function gatherResources(projectDir: string): Promise<CompileResource[]> {
  const out: CompileResource[] = [];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const absPath = path.join(dir, entry.name);
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTS.has(ext)) continue;
        const relPath = path.relative(projectDir, absPath).replace(/\\/g, "/");

        if (TEXT_EXTS.has(ext)) {
          const content = await fs.readFile(absPath, "utf8");
          out.push({
            path: relPath,
            content,
            main: relPath === "main.tex",
          });
        } else {
          const buf = await fs.readFile(absPath);
          out.push({ path: relPath, file: buf.toString("base64") });
        }
      }
    }
  }

  await walk(projectDir);

  // If no file is named main.tex, mark the first .tex as main.
  if (!out.some((r) => r.main)) {
    const firstTex = out.find((r) => r.path.endsWith(".tex"));
    if (firstTex) firstTex.main = true;
  }

  return out;
}

export async function POST() {
  try {
    const projectDir = getProjectDir();
    const resources = await gatherResources(projectDir);

    if (resources.length === 0) {
      return NextResponse.json(
        { error: "No LaTeX sources found under PROJECT_DIR" },
        { status: 400 },
      );
    }

    const latexApiUrl = process.env.LATEX_API_URL || "http://localhost:3001";
    const response = await fetch(`${latexApiUrl}/builds/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ compiler: "pdflatex", resources }),
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || contentType.includes("application/json")) {
      const errorData = await response.json().catch(() => ({}));
      const logContent = errorData.log_files?.["__main_document__.log"] ?? "";
      const errorLines = logContent
        .split("\n")
        .filter(
          (line: string) =>
            line.includes("Error") ||
            line.includes("!") ||
            line.includes("Missing"),
        )
        .slice(0, 10)
        .join("\n");
      return NextResponse.json(
        {
          error: `Compilation failed: ${errorData.error || response.statusText}`,
          details: errorLines || logContent.slice(-1000),
        },
        { status: 500 },
      );
    }

    const pdfBuffer = Buffer.from(await response.arrayBuffer());

    // Persist to .openprism/out.pdf so next startup can show it instantly.
    // Use path.posix.join so the path matches the POSIX-normalized keys the echo tracker uses.
    const outPath = path.posix.join(projectDir, BUILD_DIR_NAME, "out.pdf");
    echo.recordWrite(outPath); // prevent the watcher from forwarding our own write
    await fs.writeFile(outPath, pdfBuffer);

    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=document.pdf",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown compilation error";
    console.error("Compile error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
