import { NextResponse } from "next/server";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import { resolveKbRef } from "@/lib/project/kb-registry";
import { listAiSources } from "@/lib/ai/knowledge-base";
import {
  cropRegisteredImage,
  readImagePng,
  renderPdfPage,
} from "@/lib/ai/images";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isBbox(value: unknown): value is Bbox {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every(
    (k) => typeof v[k] === "number" && Number.isFinite(v[k]),
  );
}

/**
 * Renders a figure region from a PDF source for external callers (e.g.
 * Claude querying from another workspace). Without bbox the full page comes
 * back as working material for locating the figure; with bbox only the crop.
 * Both are registered in the image workspace, so provenance stays intact and
 * the attribution travels in the X-Image-Attribution header. This does not
 * create embeddable page URLs — the images GET route still refuses to serve
 * full page renders.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      project?: string;
      source?: string;
      page?: number;
      bbox?: unknown;
    };

    const sourceRef = body.source?.trim();
    const page = body.page;
    if (!sourceRef || typeof page !== "number" || !Number.isInteger(page)) {
      return NextResponse.json(
        { error: "source and page (integer) are required" },
        { status: 400 },
      );
    }
    if (body.bbox !== undefined && !isBbox(body.bbox)) {
      return NextResponse.json(
        {
          error:
            "bbox must be {x, y, width, height} with normalized 0-1 numbers",
        },
        { status: 400 },
      );
    }

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

    const manifest = await listAiSources(projectDir);
    const source =
      manifest.sources.find((s) => s.id === sourceRef) ??
      manifest.sources.find(
        (s) => s.originalName.toLowerCase() === sourceRef.toLowerCase(),
      );
    if (!source) {
      return NextResponse.json(
        { error: "unknown-source", source: sourceRef },
        { status: 404 },
      );
    }

    let record = await renderPdfPage(projectDir, source.id, page);
    if (body.bbox !== undefined && isBbox(body.bbox)) {
      record = await cropRegisteredImage(projectDir, record.id, body.bbox);
    }

    const png = await readImagePng(projectDir, record.id);
    if (!png) {
      return NextResponse.json({ error: "render-failed" }, { status: 500 });
    }

    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "X-Image-Id": record.id,
        "X-Image-Kind": record.kind,
        "X-Image-Width": String(record.width),
        "X-Image-Height": String(record.height),
        "X-Image-Attribution": encodeURIComponent(record.attribution),
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
    const status = /out of range|not found|renders PDF pages/i.test(message)
      ? 400
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
