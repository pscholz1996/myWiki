import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import JSZip from "jszip";
import {
  getAiSourceFilePath,
  getAiSourceRecord,
} from "@/lib/ai/knowledge-base";
import type { AiSourceRecord } from "@/lib/ai/types";

/**
 * Source-image workspace: every image the assistant produces (rendered PDF
 * pages, slide media, crops, annotated variants) is registered here as
 * `<id>.png` + `<id>.json` under `.mywiki/ai/images/`, served by
 * /api/ai/images/<id>. The JSON record keeps full provenance — which
 * source, which page/slide, what was done to it — so attribution is always
 * reconstructable and annotated images are never mistaken for originals.
 */

export interface AiImageRecord {
  id: string;
  sourceId: string;
  /** PDF page or PPTX slide number the image ultimately comes from. */
  page: number | null;
  kind: "page-render" | "slide-media" | "crop" | "annotated";
  /** Image id this one was derived from (crop/annotated only). */
  parentId?: string;
  width: number;
  height: number;
  createdAt: string;
  /** Human-readable provenance, e.g. "INCOSE Handbook, p. 34 (annotated)". */
  attribution: string;
}

const IMAGE_ID_PATTERN = /^img-[a-f0-9-]+$/;

export const MAX_RENDER_DIMENSION = 1600;

function imagesDir(projectDir: string): string {
  return path.join(projectDir, ".mywiki", "ai", "images");
}

async function ensureImagesDir(projectDir: string): Promise<string> {
  const dir = imagesDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function newImageId(): string {
  return `img-${crypto.randomUUID()}`;
}

function attributionFor(
  source: AiSourceRecord,
  page: number | null,
  suffix?: string,
): string {
  const title = source.metadata?.title ?? source.originalName;
  const locator =
    page == null
      ? ""
      : source.kind === "pptx"
        ? `, slide ${page}`
        : `, p. ${page}`;
  return `${title}${locator}${suffix ? ` (${suffix})` : ""}`;
}

async function registerImage(
  projectDir: string,
  png: Buffer,
  record: Omit<AiImageRecord, "id" | "createdAt">,
): Promise<AiImageRecord> {
  const dir = await ensureImagesDir(projectDir);
  const full: AiImageRecord = {
    ...record,
    id: newImageId(),
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, `${full.id}.png`), png);
  await fs.writeFile(
    path.join(dir, `${full.id}.json`),
    JSON.stringify(full, null, 2),
    "utf8",
  );
  return full;
}

export async function getImageRecord(
  projectDir: string,
  imageId: string,
): Promise<AiImageRecord | null> {
  if (!IMAGE_ID_PATTERN.test(imageId)) return null;
  try {
    const raw = await fs.readFile(
      path.join(imagesDir(projectDir), `${imageId}.json`),
      "utf8",
    );
    return JSON.parse(raw) as AiImageRecord;
  } catch {
    return null;
  }
}

export async function readImagePng(
  projectDir: string,
  imageId: string,
): Promise<Buffer | null> {
  if (!IMAGE_ID_PATTERN.test(imageId)) return null;
  try {
    return await fs.readFile(
      path.join(imagesDir(projectDir), `${imageId}.png`),
    );
  } catch {
    return null;
  }
}

export function imageUrl(record: AiImageRecord): string {
  return `/api/ai/images/${record.id}`;
}

/**
 * Locates pdfjs-dist's on-disk asset directories (wasm decoders, standard
 * fonts) by walking up from cwd. Deliberately NOT require.resolve():
 * Turbopack rewrites module resolution inside bundled server code to
 * virtual "[externals]/..." paths that are unusable as file URLs — this
 * function needs the real filesystem location. pnpm hoists pdfjs-dist to
 * the workspace-root node_modules, one or two levels above apps/web.
 */
let pdfjsAssetRootPromise: Promise<string | null> | null = null;

function findPdfjsAssetRoot(): Promise<string | null> {
  if (!pdfjsAssetRootPromise) {
    pdfjsAssetRootPromise = (async () => {
      let dir = process.cwd();
      for (let depth = 0; depth < 6; depth += 1) {
        const candidate = path.join(dir, "node_modules", "pdfjs-dist");
        try {
          await fs.access(path.join(candidate, "wasm", "jbig2.wasm"));
          return candidate;
        } catch {
          // keep walking up
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      console.warn(
        "pdfjs-dist asset directory not found — page renders will skip JBIG2/JPX-encoded figures",
      );
      return null;
    })();
  }
  return pdfjsAssetRootPromise;
}

/**
 * Renders a PDF page to PNG. Scale is chosen so the longer edge lands near
 * MAX_RENDER_DIMENSION — enough for the model to read figure labels, small
 * enough to keep vision-token cost and payload size sane.
 */
export async function renderPdfPage(
  projectDir: string,
  sourceId: string,
  page: number,
): Promise<AiImageRecord> {
  const source = await getAiSourceRecord(projectDir, sourceId);
  if (!source) throw new Error("Source not found");
  if (source.kind !== "pdf") {
    throw new Error(
      `view_page_image renders PDF pages; "${source.originalName}" is kind "${source.kind}". For pptx sources use list_slide_images/view_image instead.`,
    );
  }

  const data = new Uint8Array(
    await fs.readFile(getAiSourceFilePath(projectDir, source)),
  );
  const pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs") = await import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  );
  // Without these asset URLs, pages render but JBIG2/JPEG2000-encoded
  // images (common in scanned or older publisher PDFs) are silently
  // dropped — exactly the figures this renderer exists to capture.
  const pdfjsRoot = await findPdfjsAssetRoot();
  const assetUrls = pdfjsRoot
    ? {
        wasmUrl: `${pathToFileURL(path.join(pdfjsRoot, "wasm")).href}/`,
        standardFontDataUrl: `${pathToFileURL(path.join(pdfjsRoot, "standard_fonts")).href}/`,
        iccUrl: `${pathToFileURL(path.join(pdfjsRoot, "iccs")).href}/`,
      }
    : {};
  const document = await pdfjs.getDocument({ data, ...assetUrls }).promise;
  if (page < 1 || page > document.numPages) {
    throw new Error(`Page ${page} out of range (1-${document.numPages})`);
  }
  const pdfPage = await document.getPage(page);
  const base = pdfPage.getViewport({ scale: 1 });
  const scale = Math.min(
    3,
    MAX_RENDER_DIMENSION / Math.max(base.width, base.height),
  );
  const viewport = pdfPage.getViewport({ scale });
  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // @napi-rs/canvas is API-compatible with the DOM canvas pdfjs expects.
  await pdfPage.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;

  return registerImage(projectDir, canvas.toBuffer("image/png"), {
    sourceId,
    page,
    kind: "page-render",
    width: canvas.width,
    height: canvas.height,
    attribution: attributionFor(source, page, "full page"),
  });
}

/** Media images (rasters embedded in slides) of a PPTX source, per slide. */
export async function listPptxMedia(
  projectDir: string,
  sourceId: string,
): Promise<Array<{ slide: number; mediaName: string }>> {
  const source = await getAiSourceRecord(projectDir, sourceId);
  if (!source) throw new Error("Source not found");
  if (source.kind !== "pptx") {
    throw new Error(
      `"${source.originalName}" is kind "${source.kind}", not pptx. For PDF sources use view_page_image instead.`,
    );
  }

  const zip = await JSZip.loadAsync(
    await fs.readFile(getAiSourceFilePath(projectDir, source)),
  );
  const results: Array<{ slide: number; mediaName: string }> = [];

  const relFiles = Object.keys(zip.files).filter((name) =>
    /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name),
  );
  for (const relFile of relFiles) {
    const slide = Number(relFile.match(/slide(\d+)\.xml\.rels$/)?.[1]);
    const xml = await zip.files[relFile].async("string");
    for (const match of xml.matchAll(
      /Target="\.\.\/media\/([^"]+\.(?:png|jpg|jpeg|gif|bmp|tiff?))"/gi,
    )) {
      results.push({ slide, mediaName: match[1] });
    }
  }
  return results.sort(
    (a, b) => a.slide - b.slide || a.mediaName.localeCompare(b.mediaName),
  );
}

/** Extracts one PPTX media image and registers it as a PNG. */
export async function extractPptxMediaImage(
  projectDir: string,
  sourceId: string,
  slide: number,
  mediaName: string,
): Promise<AiImageRecord> {
  const source = await getAiSourceRecord(projectDir, sourceId);
  if (!source) throw new Error("Source not found");
  if (!/^[\w.-]+$/.test(mediaName)) throw new Error("Invalid media name");

  const zip = await JSZip.loadAsync(
    await fs.readFile(getAiSourceFilePath(projectDir, source)),
  );
  const entry = zip.files[`ppt/media/${mediaName}`];
  if (!entry)
    throw new Error(`Media "${mediaName}" not found in ${source.originalName}`);

  const bytes = await entry.async("nodebuffer");
  // Normalize every format to PNG via canvas so downstream crop/annotate and
  // the serving route only ever deal with one format.
  const img = await loadImage(bytes);
  const scale = Math.min(
    1,
    MAX_RENDER_DIMENSION / Math.max(img.width, img.height),
  );
  const canvas = createCanvas(
    Math.max(1, Math.round(img.width * scale)),
    Math.max(1, Math.round(img.height * scale)),
  );
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return registerImage(projectDir, canvas.toBuffer("image/png"), {
    sourceId,
    page: slide,
    kind: "slide-media",
    width: canvas.width,
    height: canvas.height,
    attribution: attributionFor(source, slide),
  });
}

/** Crops a registered image; bbox is normalized 0-1 relative to the parent. */
export async function cropRegisteredImage(
  projectDir: string,
  imageId: string,
  bbox: { x: number; y: number; width: number; height: number },
): Promise<AiImageRecord> {
  const parent = await getImageRecord(projectDir, imageId);
  const png = await readImagePng(projectDir, imageId);
  if (!parent || !png) throw new Error("Image not found");

  for (const value of [bbox.x, bbox.y, bbox.width, bbox.height]) {
    if (!Number.isFinite(value)) throw new Error("bbox values must be numbers");
  }
  const x = Math.max(0, Math.min(1, bbox.x));
  const y = Math.max(0, Math.min(1, bbox.y));
  const w = Math.max(0.01, Math.min(1 - x, bbox.width));
  const h = Math.max(0.01, Math.min(1 - y, bbox.height));

  const img = await loadImage(png);
  const sx = Math.round(x * img.width);
  const sy = Math.round(y * img.height);
  const sw = Math.max(1, Math.round(w * img.width));
  const sh = Math.max(1, Math.round(h * img.height));

  const canvas = createCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  const source = await getAiSourceRecord(projectDir, parent.sourceId);
  return registerImage(projectDir, canvas.toBuffer("image/png"), {
    sourceId: parent.sourceId,
    page: parent.page,
    kind: "crop",
    parentId: parent.id,
    width: sw,
    height: sh,
    attribution: source
      ? attributionFor(source, parent.page)
      : parent.attribution,
  });
}

export type AiAnnotation =
  | { type: "circle"; x: number; y: number; radius: number; color?: string }
  | {
      type: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      color?: string;
    }
  | {
      type: "highlight";
      x: number;
      y: number;
      width: number;
      height: number;
      color?: string;
    }
  | {
      type: "arrow";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      color?: string;
    }
  | { type: "label"; x: number; y: number; text: string; color?: string };

const ANNOTATION_COLORS: Record<string, string> = {
  red: "#e02424",
  blue: "#1d4ed8",
  green: "#15803d",
  orange: "#ea580c",
};

const MAX_LABEL_LENGTH = 40;

/**
 * Draws explanation marks ON TOP of a registered image — strictly additive
 * (shapes and short pointers), never redactions or content edits. The result
 * is a new derived image whose attribution carries an "annotated" suffix so
 * it can never pass as the untouched original.
 */
export async function annotateRegisteredImage(
  projectDir: string,
  imageId: string,
  annotations: AiAnnotation[],
): Promise<AiImageRecord> {
  const parent = await getImageRecord(projectDir, imageId);
  const png = await readImagePng(projectDir, imageId);
  if (!parent || !png) throw new Error("Image not found");
  if (annotations.length === 0) throw new Error("No annotations given");
  if (annotations.length > 12) {
    throw new Error("Too many annotations (max 12) — keep marks purposeful");
  }

  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const W = img.width;
  const H = img.height;
  const stroke = Math.max(2, Math.round(Math.max(W, H) * 0.004));
  const colorOf = (c?: string) =>
    ANNOTATION_COLORS[c ?? "red"] ?? ANNOTATION_COLORS.red;

  for (const a of annotations) {
    ctx.lineWidth = stroke;
    ctx.strokeStyle = colorOf("color" in a ? a.color : undefined);

    switch (a.type) {
      case "circle": {
        ctx.beginPath();
        ctx.ellipse(
          a.x * W,
          a.y * H,
          a.radius * W,
          a.radius * W,
          0,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
        break;
      }
      case "rect": {
        ctx.strokeRect(a.x * W, a.y * H, a.width * W, a.height * H);
        break;
      }
      case "highlight": {
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = a.color === "blue" ? "#60a5fa" : "#fde047";
        ctx.fillRect(a.x * W, a.y * H, a.width * W, a.height * H);
        ctx.restore();
        break;
      }
      case "arrow": {
        const fx = a.fromX * W;
        const fy = a.fromY * H;
        const tx = a.toX * W;
        const ty = a.toY * H;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        const angle = Math.atan2(ty - fy, tx - fx);
        const head = stroke * 4;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(
          tx - head * Math.cos(angle - 0.5),
          ty - head * Math.sin(angle - 0.5),
        );
        ctx.moveTo(tx, ty);
        ctx.lineTo(
          tx - head * Math.cos(angle + 0.5),
          ty - head * Math.sin(angle + 0.5),
        );
        ctx.stroke();
        break;
      }
      case "label": {
        // Short pointers only ("here", "Step 2") — never enough room to
        // rewrite the figure's own terminology.
        const text = a.text.slice(0, MAX_LABEL_LENGTH);
        const fontSize = Math.max(14, Math.round(Math.max(W, H) * 0.02));
        ctx.font = `${fontSize}px sans-serif`;
        const metrics = ctx.measureText(text);
        const pad = fontSize * 0.35;
        const bx = a.x * W;
        const by = a.y * H;
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(
          bx - pad,
          by - fontSize - pad,
          metrics.width + pad * 2,
          fontSize + pad * 2,
        );
        ctx.restore();
        ctx.fillStyle = colorOf(a.color);
        ctx.fillText(text, bx, by);
        break;
      }
    }
  }

  const source = await getAiSourceRecord(projectDir, parent.sourceId);
  return registerImage(projectDir, canvas.toBuffer("image/png"), {
    sourceId: parent.sourceId,
    page: parent.page,
    kind: "annotated",
    parentId: parent.id,
    width: img.width,
    height: img.height,
    attribution: source
      ? attributionFor(source, parent.page, "annotated")
      : `${parent.attribution} (annotated)`,
  });
}
