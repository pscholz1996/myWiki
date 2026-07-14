import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "@huggingface/transformers";
import type {
  AiManifest,
  AiSourceKind,
  AiSourceMetadata,
  AiSourceRecord,
  AiUploadProgressCallback,
  AiUploadProgressEvent,
} from "@/lib/ai/types";
import {
  buildBm25Index,
  reciprocalRankFusion,
  scoreBm25,
  tokenize,
  type Bm25Index,
} from "@/lib/ai/lexical-search";
import { lookupCrossrefMetadata, titleSimilarity } from "@/lib/ai/crossref";

export type {
  AiManifest,
  AiSourceKind,
  AiSourceMetadata,
  AiSourceRecord,
  AiUploadProgressCallback,
  AiUploadProgressEvent,
};

export interface AiChunkRecord {
  id: string;
  sourceId: string;
  sourceFile: string;
  page: number | null;
  charStart: number;
  charEnd: number;
  text: string;
}

export interface IndexedChunk extends AiChunkRecord {
  embedding: number[];
}

export interface AiSearchHit {
  score: number;
  chunk: AiChunkRecord;
}

const AI_DIR = [".mywiki", "ai"] as const;
const SOURCES_DIR = [".mywiki", "ai", "sources"] as const;
const INDEX_DIR = [".mywiki", "ai", "index"] as const;
const MANIFEST_FILE = "manifest.json";
const CHUNKS_FILE = "chunks.jsonl";
const EMBEDDINGS_FILE = "embeddings.bin";
const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

// Anything outside this set falls through extractSourceText's non-PDF
// branch, which reads the raw bytes as UTF-8 "text" — for a real binary
// file (.docx, .png, a zip) that produces garbage that still gets chunked,
// embedded, and surfaced in search results and citations. Reject it up
// front instead of silently indexing noise.
export const ALLOWED_SOURCE_EXTS = new Set([".pdf", ".md", ".txt"]);
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024; // 50MB — generous for a single paper

let embeddingPipelinePromise: Promise<
  (
    texts: string[],
    options: { pooling: "mean"; normalize: boolean },
  ) => Promise<{
    tolist: () => number[][];
  }>
> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function posixJoin(...parts: string[]): string {
  return path.posix.join(...parts).replace(/\\/g, "/");
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[^\w. -]/g, "_");
  return base.replace(/\s+/g, "_");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureAiWorkspace(projectDir: string): Promise<{
  aiDir: string;
  sourcesDir: string;
  indexDir: string;
}> {
  const aiDir = path.join(projectDir, ...AI_DIR);
  const sourcesDir = path.join(projectDir, ...SOURCES_DIR);
  const indexDir = path.join(projectDir, ...INDEX_DIR);

  await ensureDir(aiDir);
  await ensureDir(sourcesDir);
  await ensureDir(indexDir);

  return { aiDir, sourcesDir, indexDir };
}

async function readManifest(projectDir: string): Promise<AiManifest> {
  const { aiDir } = await ensureAiWorkspace(projectDir);
  const manifestPath = path.join(aiDir, MANIFEST_FILE);

  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as AiManifest;
    if (parsed.version !== 1) {
      throw new Error("Unsupported AI manifest version");
    }
    return parsed;
  } catch {
    return {
      version: 1,
      updatedAt: nowIso(),
      embeddingModel: EMBEDDING_MODEL,
      embeddingDimensions: null,
      sources: [],
      index: {
        chunkCount: 0,
        embeddingCount: 0,
        generatedAt: null,
      },
    };
  }
}

async function writeManifest(
  projectDir: string,
  manifest: AiManifest,
): Promise<void> {
  const { aiDir } = await ensureAiWorkspace(projectDir);
  const manifestPath = path.join(aiDir, MANIFEST_FILE);
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function writeJsonLines(
  filePath: string,
  records: AiChunkRecord[],
): Promise<void> {
  const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await fs.writeFile(filePath, content, "utf8");
}

async function writeEmbeddingMatrix(
  filePath: string,
  vectors: number[][],
): Promise<number> {
  if (vectors.length === 0) {
    await fs.writeFile(filePath, Buffer.alloc(0));
    return 0;
  }

  const dimensions = vectors[0]?.length ?? 0;
  const buffer = Buffer.alloc(vectors.length * dimensions * 4);
  const view = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    vectors.length * dimensions,
  );

  let offset = 0;
  for (const vector of vectors) {
    if (vector.length !== dimensions) {
      throw new Error("Embedding dimensions do not match");
    }
    view.set(vector, offset);
    offset += dimensions;
  }

  await fs.writeFile(filePath, buffer);
  return dimensions;
}

// embedTexts always calls the pipeline with normalize: true, so every
// stored vector and every query vector already has unit L2 norm — cosine
// similarity between two unit vectors is exactly their dot product, no
// need to (re-)compute and divide by magnitudes on every comparison.
function dotProduct(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return dot;
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

async function readEmbeddingMatrix(filePath: string): Promise<Float32Array> {
  try {
    const buffer = await fs.readFile(filePath);
    return new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength / 4,
    );
  } catch {
    return new Float32Array();
  }
}

async function getEmbeddingPipeline() {
  if (!embeddingPipelinePromise) {
    embeddingPipelinePromise = pipeline("feature-extraction", EMBEDDING_MODEL);
  }

  return embeddingPipelinePromise;
}

// searchAiKnowledgeBase used to re-read and re-parse the entire index
// (every chunk's JSON line, every embedding row) from disk on every single
// call. Fine at a handful of sources; a real cost at a large knowledge
// base. Cache the parsed data in memory, keyed by index directory, and
// only re-read when the underlying files have actually changed.
//
// mtime-checked rather than purely explicit-invalidation: this project
// already shipped and had to fix a cache that went stale independently per
// route because a dev-mode bundler could give different API routes
// different module instances, each with their own "cached" state (see
// lib/fs/project-dir.ts's getProjectDir doc comment). An mtime check costs
// two stat() calls and makes correctness not depend on every writer
// remembering to invalidate — cheap insurance against the same failure
// class recurring here.
interface KbCache {
  chunksMtimeMs: number;
  embeddingsMtimeMs: number;
  chunkRecords: AiChunkRecord[];
  embeddingMatrix: Float32Array;
  // Built once per cache load (tokenizing/indexing 30k+ chunks isn't free),
  // not per query — the same reasoning as caching the parsed chunks/vectors.
  bm25Index: Bm25Index;
}

const KB_CACHE_MAX_ENTRIES = 3;
const kbCacheByIndexDir = new Map<string, KbCache>();

function touchKbCache(indexDir: string, cache: KbCache): void {
  // Map preserves insertion order — delete+reinsert marks this entry as
  // most-recently-used; the least-recently-used entry is whatever is still
  // first once we're over the bound.
  kbCacheByIndexDir.delete(indexDir);
  kbCacheByIndexDir.set(indexDir, cache);
  if (kbCacheByIndexDir.size > KB_CACHE_MAX_ENTRIES) {
    const oldestKey = kbCacheByIndexDir.keys().next().value;
    if (oldestKey !== undefined) kbCacheByIndexDir.delete(oldestKey);
  }
}

async function getKbIndex(indexDir: string): Promise<{
  chunkRecords: AiChunkRecord[];
  embeddingMatrix: Float32Array;
  bm25Index: Bm25Index;
}> {
  const chunksPath = path.join(indexDir, CHUNKS_FILE);
  const embeddingsPath = path.join(indexDir, EMBEDDINGS_FILE);

  let chunksMtimeMs: number;
  let embeddingsMtimeMs: number;
  try {
    const [chunksStat, embeddingsStat] = await Promise.all([
      fs.stat(chunksPath),
      fs.stat(embeddingsPath),
    ]);
    chunksMtimeMs = chunksStat.mtimeMs;
    embeddingsMtimeMs = embeddingsStat.mtimeMs;
  } catch {
    // Index files don't exist yet — nothing to search.
    return {
      chunkRecords: [],
      embeddingMatrix: new Float32Array(),
      bm25Index: buildBm25Index([]),
    };
  }

  const cached = kbCacheByIndexDir.get(indexDir);
  if (
    cached &&
    cached.chunksMtimeMs === chunksMtimeMs &&
    cached.embeddingsMtimeMs === embeddingsMtimeMs
  ) {
    touchKbCache(indexDir, cached);
    return cached;
  }

  const [chunkRecords, embeddingMatrix] = await Promise.all([
    readJsonLines<AiChunkRecord>(chunksPath),
    readEmbeddingMatrix(embeddingsPath),
  ]);
  const bm25Index = buildBm25Index(
    chunkRecords.map((chunk) => ({ id: chunk.id, text: chunk.text })),
  );

  const next: KbCache = {
    chunksMtimeMs,
    embeddingsMtimeMs,
    chunkRecords,
    embeddingMatrix,
    bm25Index,
  };
  touchKbCache(indexDir, next);
  return next;
}

/** Fast-path invalidation after this process writes the index — the mtime
 * check above would eventually catch it anyway, but there's no reason to
 * let a stale entry linger even briefly. */
function invalidateKbCache(indexDir: string): void {
  kbCacheByIndexDir.delete(indexDir);
}

async function embedTexts(
  texts: string[],
  onBatchDone?: (done: number, total: number) => void,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const extractor = await getEmbeddingPipeline();
  const batchSize = 16;
  const vectors: number[][] = [];

  for (let index = 0; index < texts.length; index += batchSize) {
    const batch = texts.slice(index, index + batchSize);
    const output = await extractor(batch, { pooling: "mean", normalize: true });
    vectors.push(...(output.tolist() as number[][]));
    onBatchDone?.(vectors.length, texts.length);
  }

  return vectors;
}

export function chunkText(
  text: string,
  maxChars = 1200,
  overlap = 160,
): Array<{ charStart: number; charEnd: number; text: string }> {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const chunks: Array<{ charStart: number; charEnd: number; text: string }> =
    [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const breakAt = normalized.lastIndexOf(" ", end);
      if (breakAt > start + Math.floor(maxChars * 0.6)) {
        end = breakAt;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) {
      chunks.push({ charStart: start, charEnd: end, text: chunk });
    }

    if (end >= normalized.length) {
      break;
    }

    start = Math.max(0, end - overlap);
    while (start < normalized.length && normalized[start] === " ") {
      start += 1;
    }
  }

  return chunks;
}

// PDF-export placeholder titles — confirmed against a real sample of ~20
// academic PDFs, where "untitled" (unmodified word-processor/export
// default) showed up as a Title value verbatim.
const JUNK_TITLE_VALUES = new Set(["untitled", "untitled document", "untitled-1"]);

// A PDF's Title metadata field is frequently either blank, a literal
// "Untitled" left over from whatever tool exported it, or just the filename
// a word processor defaulted to — none of those are usable titles, so
// they're rejected rather than trusted. fileName is passed in so a title
// that's merely the original filename (a common "didn't bother setting a
// real title" case) is caught even when it doesn't look like a filename.
export function isJunkPdfTitle(title: string, fileName: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return true;
  if (JUNK_TITLE_VALUES.has(trimmed.toLowerCase())) return true;
  if (/\.(pdf|docx?|tex|rtf)$/i.test(trimmed)) return true;

  const bareFileName = path.basename(fileName, path.extname(fileName));
  return trimmed.toLowerCase() === bareFileName.toLowerCase();
}

// PDF metadata dates use the format "D:YYYYMMDDHHmmSS+HH'mm'" (ISO 32000
// §7.9.4) — only the four-digit year is needed here. Sanity-bounded so a
// malformed or placeholder date (e.g. "D:00000000") doesn't produce a
// nonsense year.
export function extractYearFromPdfDate(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const match = raw.match(/D:(\d{4})/);
  if (!match) return undefined;

  const year = Number(match[1]);
  const currentYear = new Date().getFullYear();
  if (year < 1900 || year > currentYear + 1) return undefined;
  return String(year);
}

// Rough last-resort title guess when no PDF metadata (or no PDF at all) is
// available — never used for authors, since misattributing authorship from
// unstructured text is a far more consequential mistake than a rough title
// guess. Tagged "heuristic" provenance so callers (ensure_bibtex_entry) know
// never to treat it as verified.
//
// Prefers the text's own first line over blindly truncating a flattened
// blob — a markdown "# Title" heading or a plain-text file's title-on-its-
// own-line is a much cleaner signal than a mid-sentence cutoff, and this is
// the raw (not whitespace-flattened) text specifically so that line break
// survives to be found. Falls back to the flattened blob when the caller
// has no line structure available (e.g. text already flattened upstream,
// as with the PDF fallback path in extractSourceText).
export function heuristicTitleFromText(text: string): string | undefined {
  const HEURISTIC_TITLE_MAX_CHARS = 150;

  const firstLine = text
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .find((line) => line.length > 0);

  const candidate = firstLine ?? normalizeWhitespace(text);
  if (!candidate) return undefined;

  return candidate.length > HEURISTIC_TITLE_MAX_CHARS
    ? `${candidate.slice(0, HEURISTIC_TITLE_MAX_CHARS).trimEnd()}…`
    : candidate;
}

interface PdfTextItem {
  str?: string;
  transform?: number[];
  width?: number;
}

interface PageLine {
  text: string;
  fontSize: number;
  y: number;
}

// Groups page-1 text items into visual lines (by Y-proximity) and
// reconstructs each line's text left-to-right. Inserts a comma when
// consecutive items on the same line have an implausibly large horizontal
// gap between them — the signature of a multi-column layout (e.g. two
// authors' name/affiliation blocks side by side, confirmed live) rather
// than ordinary word spacing.
function buildPageLines(items: PdfTextItem[]): PageLine[] {
  const Y_TOLERANCE = 2;
  const COLUMN_GAP_THRESHOLD = 20;

  const positioned = items
    .map((item) => ({
      text: (item.str ?? "").trim(),
      fontSize: item.transform?.[0] ?? 0,
      x: item.transform?.[4] ?? 0,
      y: item.transform?.[5] ?? 0,
      width: item.width ?? 0,
    }))
    .filter((item) => item.text && item.fontSize > 0);

  const clusters: Array<{ y: number; items: typeof positioned }> = [];
  for (const item of positioned) {
    const cluster = clusters.find((c) => Math.abs(c.y - item.y) < Y_TOLERANCE);
    if (cluster) cluster.items.push(item);
    else clusters.push({ y: item.y, items: [item] });
  }

  const lines: PageLine[] = [];
  for (const cluster of clusters) {
    const sorted = [...cluster.items].sort((a, b) => a.x - b.x);
    let text = "";
    let prevEndX: number | null = null;
    let sizeWeightSum = 0;
    let charWeightSum = 0;
    for (const item of sorted) {
      if (prevEndX !== null) {
        text += item.x - prevEndX > COLUMN_GAP_THRESHOLD ? ", " : " ";
      }
      text += item.text;
      prevEndX = item.x + item.width;
      sizeWeightSum += item.fontSize * item.text.length;
      charWeightSum += item.text.length;
    }
    const normalized = normalizeWhitespace(text);
    if (!normalized) continue;
    lines.push({
      text: normalized,
      fontSize: charWeightSum > 0 ? sizeWeightSum / charWeightSum : 0,
      y: cluster.y,
    });
  }
  return lines;
}

const MIN_TITLE_CHARS = 4;
const MAX_TITLE_CHARS = 200;

// A PDF's title is almost always set in a visibly larger font than the
// author names/affiliations/running headers around it — confirmed against
// both a book's title page (title at 74pt, author at 28pt) and an academic
// paper's title block (title at ~24pt wrapping two lines, authors at
// ~11pt). Collecting every line at a given size naturally reconstructs a
// wrapped multi-line title without pulling in the smaller-font text below.
//
// The largest font size on the page isn't always the title, though — a
// decorative drop cap (a single oversized capital letter starting the body
// text, common in academic/magazine layouts) is frequently set even bigger
// than the title itself (confirmed live: a real paper's drop-cap "T" at
// 29.9pt outsized its actual 23.9pt title). A real title is essentially
// never just one or two characters, so implausibly short size groups are
// skipped in favor of the next-largest one instead of trusting size alone.
function selectTitleLines(
  lines: PageLine[],
): { text: string; fontSize: number; ys: number[] } | undefined {
  const bySize = new Map<number, PageLine[]>();
  for (const line of lines) {
    // Round to the nearest half-point so floating-point noise between
    // glyphs of what's visually the same size still groups together.
    const bucket = Math.round(line.fontSize * 2) / 2;
    const group = bySize.get(bucket);
    if (group) group.push(line);
    else bySize.set(bucket, [line]);
  }

  const sizesLargestFirst = [...bySize.keys()].sort((a, b) => b - a);
  for (const size of sizesLargestFirst) {
    const group = bySize.get(size)!;
    const text = normalizeWhitespace(group.map((l) => l.text).join(" "));
    if (text.length < MIN_TITLE_CHARS) continue;
    return { text, fontSize: size, ys: group.map((l) => l.y) };
  }
  return undefined;
}

// Bibliographic front matter (affiliations, abstracts, running heads) that
// can plausibly sit near a title/byline in a similar font size — excluded
// so the byline search doesn't mistake one of these for an author list.
const NON_AUTHOR_MARKERS =
  /\b(abstract|keywords|introduction|university|institute|department|school of|technical report|working paper|proceedings|conference|journal|volume|editor|editors|edited by|doi|www\.|https?:)\b/i;

// A conservative "does this look like a list of person names" check: split
// on common name-list separators, and require most segments to match a
// simple capitalized-word-sequence pattern (optionally with initials).
// Deliberately permissive on WHICH characters count as a name (so it
// doesn't reject real names) but strict on overall shape, since the goal is
// avoiding a false-positive (misattributing a subtitle/affiliation as
// authors) more than catching every real byline.
const NAME_SEGMENT_PATTERN =
  /^[\p{Lu}][\p{L}'-]*\.?(?:\s+[\p{Lu}][\p{L}'.-]*){0,3}$/u;

function looksLikeByline(text: string): boolean {
  if (!text || text.length > 200) return false;
  if (NON_AUTHOR_MARKERS.test(text)) return false;

  const segments = text
    .split(/,|\band\b|&/i)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;

  const nameLikeCount = segments.filter((segment) =>
    NAME_SEGMENT_PATTERN.test(segment),
  ).length;
  return nameLikeCount / segments.length >= 0.6;
}

// A byline isn't always directly below the title — a book cover can put
// the author's name in a banner above it (confirmed live) while an
// academic paper puts it directly below — so this searches outward from
// the title by Y-distance in either direction, taking the nearest line
// that actually looks like a name list rather than assuming a fixed
// direction or trusting proximity alone (a caption, running head, or the
// stray superscript-affiliation-number line pdf.js sometimes reports as
// its own cluster can be nearer than the real byline; looksLikeByline
// rejects those and the search continues outward).
function selectByline(
  lines: PageLine[],
  title: { fontSize: number; ys: number[] },
): string[] | undefined {
  const titleYs = new Set(title.ys);
  const candidates = lines
    .filter((line) => !titleYs.has(line.y) && line.fontSize < title.fontSize - 0.5)
    .map((line) => ({
      line,
      distance: Math.min(...title.ys.map((y) => Math.abs(y - line.y))),
    }))
    .sort((a, b) => a.distance - b.distance);

  for (const { line } of candidates) {
    if (looksLikeByline(line.text)) {
      const authors = line.text
        .split(/,|\band\b|&/i)
        .map((author) => author.trim())
        .filter(Boolean);
      return authors.length > 0 ? authors : undefined;
    }
  }
  return undefined;
}

function analyzePageOneLayout(
  items: PdfTextItem[],
): { title: string | undefined; authors: string[] | undefined } {
  const lines = buildPageLines(items);
  const titleLines = selectTitleLines(lines);
  if (!titleLines) return { title: undefined, authors: undefined };

  const title =
    titleLines.text.length > MAX_TITLE_CHARS
      ? `${titleLines.text.slice(0, MAX_TITLE_CHARS).trimEnd()}…`
      : titleLines.text;

  return { title, authors: selectByline(lines, titleLines) };
}

async function extractPdfMetadata(
  document: { getMetadata(): Promise<{ info?: Record<string, unknown> }> },
  fileName: string,
): Promise<AiSourceMetadata | undefined> {
  try {
    const { info } = await document.getMetadata();

    const rawTitle = typeof info?.Title === "string" ? info.Title : "";
    const title = isJunkPdfTitle(rawTitle, fileName) ? undefined : rawTitle.trim();

    const rawAuthor = typeof info?.Author === "string" ? info.Author.trim() : "";
    const authors = rawAuthor
      ? rawAuthor
          .split(/;|\band\b/i)
          .map((author) => author.trim())
          .filter(Boolean)
      : undefined;

    const year = extractYearFromPdfDate(info?.CreationDate);

    if (!title && !authors?.length && !year) return undefined;
    return { title, authors, year, provenance: "pdf-metadata" };
  } catch {
    // Malformed/absent metadata dictionary — fall back to the heuristic path.
    return undefined;
  }
}

async function extractPdfPages(
  data: Uint8Array,
  fileName: string,
): Promise<{
  pages: Array<{ page: number; text: string }>;
  metadata: AiSourceMetadata | undefined;
  layoutTitle: string | undefined;
  layoutAuthors: string[] | undefined;
}> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data }).promise;
  const pages: Array<{ page: number; text: string }> = [];
  let layoutTitle: string | undefined;
  let layoutAuthors: string[] | undefined;

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    if (pageNumber === 1) {
      const layout = analyzePageOneLayout(content.items);
      layoutTitle = layout.title;
      layoutAuthors = layout.authors;
    }
    const text = content.items
      .map((item: any) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push({ page: pageNumber, text: normalizeWhitespace(text) });
  }

  const metadata = await extractPdfMetadata(document, fileName);
  return { pages, metadata, layoutTitle, layoutAuthors };
}

async function extractSourceText(
  fileName: string,
  data: Uint8Array,
): Promise<{
  pageCount: number | null;
  pages: Array<{ page: number | null; text: string }>;
  metadata: AiSourceMetadata;
}> {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") {
    const { pages, metadata, layoutTitle, layoutAuthors } = await extractPdfPages(
      data,
      fileName,
    );
    const fallbackTitle = () =>
      layoutTitle ?? heuristicTitleFromText(pages[0]?.text ?? "");

    if (!metadata) {
      return {
        pageCount: pages.length,
        pages,
        metadata: {
          title: fallbackTitle(),
          titleIsHeuristic: true,
          authors: layoutAuthors,
          authorsAreHeuristic: layoutAuthors ? true : undefined,
          provenance: "heuristic",
        },
      };
    }

    // The PDF's own metadata dictionary can have a real CreationDate but a
    // genuinely blank Title/Author (common for LaTeX output that never set
    // \hypersetup{pdftitle=..., pdfauthor=...}) — backfill just the missing
    // fields from the page-1 layout analysis rather than discarding
    // whatever real data the dictionary did have. titleIsHeuristic/
    // authorsAreHeuristic keep any backfilled field out of anything
    // citation-safety-sensitive (see ensureBibtexEntry).
    const needsTitleBackfill = !metadata.title;
    const needsAuthorsBackfill = !metadata.authors?.length;
    if (!needsTitleBackfill && !needsAuthorsBackfill) {
      return { pageCount: pages.length, pages, metadata };
    }

    return {
      pageCount: pages.length,
      pages,
      metadata: {
        ...metadata,
        title: needsTitleBackfill ? fallbackTitle() : metadata.title,
        titleIsHeuristic: needsTitleBackfill ? true : metadata.titleIsHeuristic,
        authors: needsAuthorsBackfill ? layoutAuthors : metadata.authors,
        authorsAreHeuristic: needsAuthorsBackfill
          ? layoutAuthors
            ? true
            : undefined
          : metadata.authorsAreHeuristic,
      },
    };
  }

  const rawText = Buffer.from(data).toString("utf8");
  return {
    pageCount: null,
    pages: [{ page: 1, text: normalizeWhitespace(rawText) }],
    // Raw (pre-flatten) text specifically — heuristicTitleFromText wants
    // the original line breaks to find a title-on-its-own-line, which
    // normalizeWhitespace would already have collapsed away.
    metadata: {
      title: heuristicTitleFromText(rawText),
      titleIsHeuristic: true,
      provenance: "heuristic",
    },
  };
}

// Upgrades whatever extractSourceText already produced (pdf-metadata and/or
// layout-heuristic guesses) to a CrossRef-verified record when a confident
// match exists. Deliberately called only once, at upload time, from
// appendSourcesToIndex's per-source loop — NOT from inside
// extractSourceText itself, since that function is also called on every
// citation-verification/full-text read (readAiSourcePage, readAiSourceFull)
// and a chat turn shouldn't pay a ~10-25s network round trip just to
// re-check a quote against a page that was already ingested.
async function enrichMetadataWithCrossref(
  metadata: AiSourceMetadata,
): Promise<AiSourceMetadata> {
  if (!metadata.title) return metadata;

  const crossref = await lookupCrossrefMetadata(metadata.title);
  if (!crossref) return metadata;

  const hasCrossrefAuthors = crossref.authors.length > 0;
  return {
    title: crossref.title,
    titleIsHeuristic: false,
    authors: hasCrossrefAuthors ? crossref.authors : metadata.authors,
    authorsAreHeuristic: hasCrossrefAuthors
      ? false
      : metadata.authorsAreHeuristic,
    year: crossref.year ?? metadata.year,
    doi: crossref.doi,
    provenance: "crossref",
  };
}

async function saveSourceFile(
  sourcesDir: string,
  id: string,
  originalName: string,
  data: Uint8Array,
): Promise<{ storedName: string; relativePath: string }> {
  const ext = path.extname(originalName).toLowerCase();
  const storedName = `${id}${ext || ""}`;
  const absPath = path.join(sourcesDir, storedName);
  await fs.writeFile(absPath, Buffer.from(data));
  return {
    storedName,
    relativePath: posixJoin(".mywiki", "ai", "sources", storedName),
  };
}

export async function listAiSources(projectDir: string): Promise<AiManifest> {
  return readManifest(projectDir);
}

async function extractAndChunkSource(
  projectDir: string,
  source: AiSourceRecord,
): Promise<{
  records: AiChunkRecord[];
  texts: string[];
  pageCount: number | null;
  metadata: AiSourceMetadata;
}> {
  const sourcePath = path.join(
    projectDir,
    ".mywiki",
    "ai",
    "sources",
    source.storedName,
  );
  const bytes = await fs.readFile(sourcePath);
  const extracted = await extractSourceText(
    source.originalName,
    new Uint8Array(bytes),
  );

  const records: AiChunkRecord[] = [];
  const texts: string[] = [];

  for (const page of extracted.pages) {
    const pageChunks = chunkText(page.text);
    for (const [index, chunk] of pageChunks.entries()) {
      records.push({
        id: `${source.id}:${page.page ?? 0}:${index}`,
        sourceId: source.id,
        sourceFile: source.relativePath,
        page: page.page,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        text: chunk.text,
      });
      texts.push(chunk.text);
    }
  }

  return {
    records,
    texts,
    pageCount: extracted.pageCount,
    metadata: extracted.metadata,
  };
}

/**
 * Sanity check before appending onto an existing index. A full rewrite
 * (the old strategy) is naturally self-healing — every write recreates
 * the file from scratch. Append-only trades that away for O(new content)
 * write cost, so verify the existing files are in the shape a clean
 * sequence of appends would actually produce before adding more onto
 * them — a torn write from a crash mid-append should surface as a clear,
 * actionable error, not silently misaligned rows. rebuildAiIndex() is the
 * repair path referenced in these errors: a full re-extract/re-embed from
 * the raw source files, which sidesteps whatever is wrong with the index
 * files themselves.
 */
async function assertIndexIntegrity(
  chunksPath: string,
  embeddingsPath: string,
  dimensions: number,
  expectedChunkCount: number,
): Promise<void> {
  const REPAIR_HINT = "Rebuild the knowledge base index to fix this.";

  const [chunksStat, embeddingsStat] = await Promise.all([
    fs.stat(chunksPath).catch(() => null),
    fs.stat(embeddingsPath).catch(() => null),
  ]);

  if (!chunksStat || !embeddingsStat) {
    throw new Error(
      `Knowledge base index is missing chunks.jsonl or embeddings.bin, ` +
        `but the manifest expects existing content. ${REPAIR_HINT}`,
    );
  }

  if (dimensions > 0 && embeddingsStat.size % (dimensions * 4) !== 0) {
    throw new Error(
      `Knowledge base index is corrupted: embeddings.bin's size ` +
        `(${embeddingsStat.size} bytes) isn't a whole multiple of the ` +
        `embedding row size (${dimensions * 4} bytes). ${REPAIR_HINT}`,
    );
  }

  const actualRowCount = dimensions > 0 ? embeddingsStat.size / (dimensions * 4) : 0;
  if (actualRowCount !== expectedChunkCount) {
    throw new Error(
      `Knowledge base index is corrupted: embeddings.bin has ` +
        `${actualRowCount} rows but the manifest expects ` +
        `${expectedChunkCount}. ${REPAIR_HINT}`,
    );
  }

  if (chunksStat.size > 0) {
    const lastByte = Buffer.alloc(1);
    const handle = await fs.open(chunksPath, "r");
    try {
      await handle.read(lastByte, 0, 1, chunksStat.size - 1);
    } finally {
      await handle.close();
    }
    if (lastByte[0] !== 0x0a /* "\n" */) {
      throw new Error(
        `Knowledge base index is corrupted: chunks.jsonl does not end ` +
          `with a newline. ${REPAIR_HINT}`,
      );
    }
  }
}

/**
 * Appends chunks/embeddings for newly-added sources to the existing index
 * instead of re-extracting and re-embedding the whole corpus. Embedding is
 * CPU-bound and runs on the main thread, so cost must scale with what
 * changed, not with total corpus size — otherwise every upload/delete on a
 * large knowledge base blocks the server for minutes. This now holds at
 * the disk-I/O level too: both index files are appended to directly
 * rather than fully read and rewritten, since chunks.jsonl always ends in
 * a newline and embedding rows are fixed-width — no read of existing
 * content is needed to safely add more.
 */
// Below this, a "similar" title is more likely two genuinely different
// papers on the same topic than the same paper uploaded twice — kept
// conservative to avoid nagging about legitimate uploads, matching the
// same reasoning as CrossRef's own confidence threshold.
const NEAR_DUPLICATE_TITLE_SIMILARITY = 0.82;

// Only checked against sources already in the knowledge base before this
// upload started — a second near-duplicate within the same multi-file
// upload batch isn't caught, a reasonable scope limit rather than tracking
// in-flight metadata across the batch for a rare case.
function findNearDuplicateTitle(
  title: string,
  existingSources: AiSourceRecord[],
): AiSourceRecord | undefined {
  let best: AiSourceRecord | undefined;
  let bestScore = 0;
  for (const candidate of existingSources) {
    if (!candidate.metadata?.title) continue;
    const score = titleSimilarity(title, candidate.metadata.title);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= NEAR_DUPLICATE_TITLE_SIMILARITY ? best : undefined;
}

async function appendSourcesToIndex(
  projectDir: string,
  newSources: AiSourceRecord[],
  onProgress?: AiUploadProgressCallback,
): Promise<UploadWarning[]> {
  const { indexDir } = await ensureAiWorkspace(projectDir);
  const chunksPath = path.join(indexDir, CHUNKS_FILE);
  const embeddingsPath = path.join(indexDir, EMBEDDINGS_FILE);

  const manifest = await readManifest(projectDir);
  const existingDimensions = manifest.embeddingDimensions ?? 0;
  const existingChunkCount = manifest.index.chunkCount;

  if (existingChunkCount > 0) {
    await assertIndexIntegrity(
      chunksPath,
      embeddingsPath,
      existingDimensions,
      existingChunkCount,
    );
  }

  const newRecords: AiChunkRecord[] = [];
  const newTexts: string[] = [];
  const pageCounts = new Map<string, number | null>();
  const metadataById = new Map<string, AiSourceMetadata>();
  const warnings: UploadWarning[] = [];

  for (const [index, source] of newSources.entries()) {
    onProgress?.({
      stage: "extracting",
      fileName: source.originalName,
      fileIndex: index,
      fileCount: newSources.length,
    });
    const { records, texts, pageCount, metadata } = await extractAndChunkSource(
      projectDir,
      source,
    );
    newRecords.push(...records);
    newTexts.push(...texts);
    pageCounts.set(source.id, pageCount);

    // CrossRef lookup only for actual papers — never for markdown/text
    // uploads (out of scope, CrossRef doesn't index arbitrary notes) and
    // critically never for kind "note" (the AI's own saved research notes),
    // where searching CrossRef for a note's own title risks attaching a
    // real, unrelated paper's data to it.
    if (source.kind === "pdf") {
      onProgress?.({
        stage: "verifying",
        fileName: source.originalName,
        fileIndex: index,
        fileCount: newSources.length,
      });
      const enriched = await enrichMetadataWithCrossref(metadata);
      metadataById.set(source.id, enriched);

      if (enriched.title) {
        const similar = findNearDuplicateTitle(enriched.title, manifest.sources);
        if (similar) {
          warnings.push({
            name: source.originalName,
            reason: `Looks similar to an existing source, "${similar.metadata?.title ?? similar.originalName}" — check it isn't a duplicate.`,
          });
        }
      }
    } else {
      metadataById.set(source.id, metadata);
    }
  }

  const newVectors = await embedTexts(newTexts, (done, total) => {
    onProgress?.({ stage: "embedding", chunksDone: done, chunksTotal: total });
  });
  const dimensions = newVectors[0]?.length ?? existingDimensions;
  onProgress?.({ stage: "indexing" });

  if (newRecords.length > 0) {
    const chunkLines = `${newRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await fs.appendFile(chunksPath, chunkLines, "utf8");
  }

  if (newVectors.length > 0) {
    const buffer = Buffer.alloc(newVectors.length * dimensions * 4);
    const view = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      newVectors.length * dimensions,
    );
    let offset = 0;
    for (const vector of newVectors) {
      view.set(vector, offset);
      offset += dimensions;
    }
    await fs.appendFile(embeddingsPath, buffer);
  }

  await writeManifest(projectDir, {
    version: 1,
    updatedAt: nowIso(),
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimensions: dimensions || existingDimensions || null,
    sources: [
      ...manifest.sources,
      ...newSources.map((source) => ({
        ...source,
        pageCount: pageCounts.get(source.id) ?? source.pageCount,
        metadata: metadataById.get(source.id) ?? source.metadata,
      })),
    ],
    index: {
      chunkCount: existingChunkCount + newRecords.length,
      embeddingCount: manifest.index.embeddingCount + newVectors.length,
      generatedAt: nowIso(),
    },
  });

  invalidateKbCache(indexDir);
  return warnings;
}

/**
 * Removes a source's chunks/embeddings from the index by filtering the
 * existing arrays — no re-embedding required, since nothing about the
 * remaining sources changed.
 */
// Accepts multiple ids so a bulk delete does one read-modify-write of the
// index instead of N — deletes are still a full rewrite either way (see
// appendSourcesToIndex's comment on why appends are incremental but
// deletes aren't), but N full rewrites for one bulk action is exactly the
// wasted-I/O case that was worth avoiding.
async function removeSourcesFromIndex(
  projectDir: string,
  sourceIds: string[],
): Promise<void> {
  const idsToRemove = new Set(sourceIds);
  const { indexDir } = await ensureAiWorkspace(projectDir);
  const chunksPath = path.join(indexDir, CHUNKS_FILE);
  const embeddingsPath = path.join(indexDir, EMBEDDINGS_FILE);

  const existingChunks = await readJsonLines<AiChunkRecord>(chunksPath);
  const existingEmbeddings = await readEmbeddingMatrix(embeddingsPath);
  const manifest = await readManifest(projectDir);
  const dimensions = manifest.embeddingDimensions ?? 0;

  const keptChunks: AiChunkRecord[] = [];
  const keptVectors: Float32Array[] = [];

  existingChunks.forEach((chunk, index) => {
    if (idsToRemove.has(chunk.sourceId)) return;
    keptChunks.push(chunk);
    if (dimensions > 0) {
      const start = index * dimensions;
      keptVectors.push(existingEmbeddings.slice(start, start + dimensions));
    }
  });

  await writeJsonLines(chunksPath, keptChunks);

  const buffer = Buffer.alloc(keptVectors.length * dimensions * 4);
  const view = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    keptVectors.length * dimensions,
  );
  let offset = 0;
  for (const vector of keptVectors) {
    view.set(vector, offset);
    offset += dimensions;
  }
  await fs.writeFile(embeddingsPath, buffer);

  await writeManifest(projectDir, {
    version: 1,
    updatedAt: nowIso(),
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimensions: dimensions || null,
    sources: manifest.sources.filter((source) => !idsToRemove.has(source.id)),
    index: {
      chunkCount: keptChunks.length,
      embeddingCount: keptVectors.length,
      generatedAt: nowIso(),
    },
  });

  invalidateKbCache(indexDir);
}

export interface RejectedSourceFile {
  name: string;
  reason: string;
}

export interface UploadWarning {
  name: string;
  reason: string;
}

export interface UploadAiSourcesResult {
  manifest: AiManifest;
  rejected: RejectedSourceFile[];
  warnings: UploadWarning[];
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Buffer.from(digest).toString("hex");
}

export async function uploadAiSources(
  projectDir: string,
  files: File[],
  onProgress?: AiUploadProgressCallback,
): Promise<UploadAiSourcesResult> {
  const { sourcesDir, indexDir } = await ensureAiWorkspace(projectDir);
  await fs.mkdir(indexDir, { recursive: true });

  // hash -> name of the source it matches, seeded from what's already in
  // the knowledge base and grown as this batch is processed so two copies
  // of the same file in one upload are caught too, not just re-uploads of
  // an existing source.
  const existingManifest = await readManifest(projectDir);
  const knownHashes = new Map<string, string>();
  for (const source of existingManifest.sources) {
    if (source.contentHash) knownHashes.set(source.contentHash, source.originalName);
  }

  const newSources: AiSourceRecord[] = [];
  const rejected: RejectedSourceFile[] = [];

  for (const [index, file] of files.entries()) {
    const originalName = sanitizeFileName(file.name);
    const ext = path.extname(originalName).toLowerCase();

    if (!ALLOWED_SOURCE_EXTS.has(ext)) {
      rejected.push({
        name: originalName,
        reason: `Unsupported file type "${ext || "(none)"}" — only PDF, Markdown, and plain text are accepted`,
      });
      continue;
    }

    if (file.size > MAX_SOURCE_BYTES) {
      rejected.push({
        name: originalName,
        reason: `File is ${Math.round(file.size / 1024 / 1024)}MB, over the ${MAX_SOURCE_BYTES / 1024 / 1024}MB limit`,
      });
      continue;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentHash = await hashBytes(bytes);
    const duplicateOf = knownHashes.get(contentHash);
    if (duplicateOf) {
      rejected.push({
        name: originalName,
        reason: `Identical to an already-uploaded source ("${duplicateOf}") — skipped`,
      });
      continue;
    }
    knownHashes.set(contentHash, originalName);

    onProgress?.({
      stage: "saving",
      fileName: originalName,
      fileIndex: index,
      fileCount: files.length,
    });
    const id = crypto.randomUUID();
    const saved = await saveSourceFile(sourcesDir, id, originalName, bytes);

    newSources.push({
      id,
      originalName,
      storedName: saved.storedName,
      relativePath: saved.relativePath,
      kind: ext === ".pdf" ? "pdf" : ext === ".md" ? "markdown" : "text",
      bytes: file.size,
      contentHash,
      ingestedAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  let warnings: UploadWarning[] = [];
  if (newSources.length > 0) {
    warnings = await appendSourcesToIndex(projectDir, newSources, onProgress);
  }

  return { manifest: await readManifest(projectDir), rejected, warnings };
}

export async function deleteAiSource(
  projectDir: string,
  sourceId: string,
): Promise<AiManifest> {
  return deleteAiSources(projectDir, [sourceId]);
}

export async function deleteAiSources(
  projectDir: string,
  sourceIds: string[],
): Promise<AiManifest> {
  const { sourcesDir } = await ensureAiWorkspace(projectDir);
  const manifest = await readManifest(projectDir);
  const idSet = new Set(sourceIds);
  const removed = manifest.sources.filter((source) => idSet.has(source.id));

  if (removed.length === 0) {
    throw new Error("Source not found");
  }

  await Promise.all(
    removed.map((source) =>
      fs.rm(path.join(sourcesDir, source.storedName), { force: true }),
    ),
  );
  await removeSourcesFromIndex(
    projectDir,
    removed.map((source) => source.id),
  );
  return readManifest(projectDir);
}

/**
 * Saves the AI's own synthesized understanding as a "note" source — kind
 * "note", flowing through the exact same extract/chunk/embed/search path as
 * any uploaded source, so it's findable via search_knowledge_base and
 * listable via browse_knowledge_base like anything else. What makes it
 * fundamentally different from a real upload is enforced elsewhere, not
 * here: verifyAiCitation refuses to resolve a citation against kind ===
 * "note", so a note can never become a cite() target no matter what this
 * function writes into it.
 *
 * originalName is set to the raw title text, not run through the upload
 * path's sanitizeFileName — there's no untrusted filename here to sanitize
 * (the model supplies a title, not a file), and sanitizing would mangle
 * natural-language titles with underscores for no benefit.
 */
export async function saveResearchNote(params: {
  projectDir: string;
  title: string;
  content: string;
  drawsOnSourceIds?: string[];
  noteId?: string;
}): Promise<AiSourceRecord> {
  const title = params.title.trim();
  const content = params.content.trim();
  if (!title) throw new Error("Note title is required");
  if (!content) throw new Error("Note content is required");

  const { sourcesDir } = await ensureAiWorkspace(params.projectDir);

  let existing: AiSourceRecord | null = null;
  if (params.noteId) {
    existing = await getAiSourceRecord(params.projectDir, params.noteId);
    if (!existing) {
      throw new Error("Note not found");
    }
    if (existing.kind !== "note") {
      throw new Error(
        `"${existing.originalName}" is not a research note — noteId must refer to a note you saved earlier.`,
      );
    }
  }

  const id = existing?.id ?? crypto.randomUUID();
  const storedName = `${id}.md`;
  const relativePath = posixJoin(".mywiki", "ai", "sources", storedName);
  const bytes = Buffer.from(content, "utf8");
  await fs.writeFile(path.join(sourcesDir, storedName), bytes);

  const record: AiSourceRecord = {
    id,
    originalName: title,
    storedName,
    relativePath,
    kind: "note",
    bytes: bytes.byteLength,
    ingestedAt: existing?.ingestedAt ?? nowIso(),
    updatedAt: nowIso(),
    drawsOnSourceIds:
      params.drawsOnSourceIds && params.drawsOnSourceIds.length > 0
        ? params.drawsOnSourceIds
        : undefined,
  };

  if (existing) {
    await removeSourcesFromIndex(params.projectDir, [id]);
  }
  await appendSourcesToIndex(params.projectDir, [record]);

  return record;
}

export async function rebuildAiIndex(
  projectDir: string,
  sourceRecords?: AiSourceRecord[],
): Promise<AiManifest> {
  const { indexDir } = await ensureAiWorkspace(projectDir);
  const manifest = sourceRecords
    ? await readManifest(projectDir)
    : await readManifest(projectDir);
  const sources = sourceRecords ?? manifest.sources;

  const chunkRecords: AiChunkRecord[] = [];
  const chunkTexts: string[] = [];
  const metadataById = new Map<string, AiSourceMetadata>();

  for (const source of sources) {
    const sourcePath = path.join(
      projectDir,
      ".mywiki",
      "ai",
      "sources",
      source.storedName,
    );
    const bytes = await fs.readFile(sourcePath);
    const extracted = await extractSourceText(
      source.originalName,
      new Uint8Array(bytes),
    );
    metadataById.set(source.id, extracted.metadata);

    for (const page of extracted.pages) {
      const pageChunks = chunkText(page.text);
      for (const [index, chunk] of pageChunks.entries()) {
        const record: AiChunkRecord = {
          id: `${source.id}:${page.page ?? 0}:${index}`,
          sourceId: source.id,
          sourceFile: source.relativePath,
          page: page.page,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          text: chunk.text,
        };
        chunkRecords.push(record);
        chunkTexts.push(chunk.text);
      }
    }
  }

  const vectors = await embedTexts(chunkTexts);
  const dimensions = await writeEmbeddingMatrix(
    path.join(indexDir, EMBEDDINGS_FILE),
    vectors,
  );

  await writeJsonLines(path.join(indexDir, CHUNKS_FILE), chunkRecords);

  return {
    version: 1,
    updatedAt: nowIso(),
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimensions: dimensions || null,
    sources: sources.map((source) => ({
      ...source,
      updatedAt: nowIso(),
      metadata: metadataById.get(source.id) ?? source.metadata,
    })),
    index: {
      chunkCount: chunkRecords.length,
      embeddingCount: vectors.length,
      generatedAt: nowIso(),
    },
  };
}

/**
 * Hybrid search: ranks chunks two ways — semantically (embedding cosine/dot
 * similarity, via the same query embedded once) and lexically (BM25 keyword
 * match) — then fuses the two rankings with Reciprocal Rank Fusion. Semantic
 * search is strong on "what is this about" but weak on exact tokens it was
 * never trained to weight specially (acronyms, author names, model names);
 * BM25 is the opposite. Fusing catches what either would miss alone — see
 * lib/ai/lexical-search.ts for the full reasoning.
 */
export async function searchAiKnowledgeBase(
  projectDir: string,
  query: string,
  topK = 5,
  sourceIds?: string[],
): Promise<AiSearchHit[]> {
  const manifest = await readManifest(projectDir);
  if (!manifest.embeddingDimensions || manifest.index.chunkCount === 0) {
    return [];
  }

  const { indexDir } = await ensureAiWorkspace(projectDir);
  const { chunkRecords, embeddingMatrix, bm25Index } = await getKbIndex(indexDir);

  if (chunkRecords.length === 0 || embeddingMatrix.length === 0) {
    return [];
  }

  // An empty/undefined allowlist means "search everything" — a non-empty
  // one restricts scoring to those sources' chunks only, so a conversation
  // scoped to specific sources can't retrieve (and therefore can't cite)
  // anything outside that scope. Previously this was advisory-only: the
  // system prompt told the model which sources were "selected", but
  // search_knowledge_base searched the whole corpus regardless.
  const allowedSourceIds = sourceIds && sourceIds.length > 0 ? new Set(sourceIds) : null;

  const chunkById = new Map<string, AiChunkRecord>();
  for (const chunk of chunkRecords) chunkById.set(chunk.id, chunk);

  const dimensions = manifest.embeddingDimensions;
  const queryVector = (await embedTexts([query]))[0];
  if (!queryVector) return [];
  const queryEmbedding = new Float32Array(queryVector);

  const semanticScored: Array<{ id: string; score: number }> = [];
  for (let index = 0; index < chunkRecords.length; index += 1) {
    const chunk = chunkRecords[index];
    if (allowedSourceIds && !allowedSourceIds.has(chunk.sourceId)) continue;

    const start = index * dimensions;
    const end = start + dimensions;
    // subarray, not slice — a zero-copy view is all dotProduct needs (it only
    // reads), and slice's per-chunk allocation+copy was the dominant cost of
    // this loop at scale (40k chunks meant 40k allocations on every search).
    const chunkEmbedding = embeddingMatrix.subarray(start, end);
    semanticScored.push({ id: chunk.id, score: dotProduct(queryEmbedding, chunkEmbedding) });
  }
  semanticScored.sort((left, right) => right.score - left.score);

  const lexicalScores = scoreBm25(bm25Index, tokenize(query));
  const lexicalScored: Array<{ id: string; score: number }> = [];
  for (const [id, score] of lexicalScores) {
    const chunk = chunkById.get(id);
    if (!chunk) continue;
    if (allowedSourceIds && !allowedSourceIds.has(chunk.sourceId)) continue;
    lexicalScored.push({ id, score });
  }
  lexicalScored.sort((left, right) => right.score - left.score);

  const fused = reciprocalRankFusion([
    semanticScored.map((s) => s.id),
    lexicalScored.map((s) => s.id),
  ]);

  const fusedIds = [...fused.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, topK)
    .map(([id]) => id);

  // Report the fused RRF score, not raw cosine similarity — it's what
  // actually determined this ordering, and a lexical-only hit (found by
  // BM25 but never scored semantically) has no meaningful cosine score to
  // fall back to.
  return fusedIds.map((id) => ({
    score: fused.get(id) ?? 0,
    chunk: chunkById.get(id) as AiChunkRecord,
  }));
}

export async function getAiSourceRecord(
  projectDir: string,
  sourceId: string,
): Promise<AiSourceRecord | null> {
  const manifest = await readManifest(projectDir);
  return manifest.sources.find((source) => source.id === sourceId) ?? null;
}

export async function setAiSourceBibKey(
  projectDir: string,
  sourceId: string,
  bibKey: string,
): Promise<AiSourceRecord> {
  const manifest = await readManifest(projectDir);
  const source = manifest.sources.find((entry) => entry.id === sourceId);
  if (!source) {
    throw new Error("Source not found");
  }

  source.bibKey = bibKey;
  source.updatedAt = nowIso();
  await writeManifest(projectDir, { ...manifest, updatedAt: nowIso() });
  return source;
}

// A human confirming (or correcting) a source's bibliographic details is
// the single most trustworthy signal this system ever gets — more so than
// CrossRef, since a person is looking at the actual document. Saving here
// always sets provenance "manual" and clears both heuristic flags: the edit
// form shows title/authors/year together, so submitting it means the user
// has reviewed all three, not just the one field they happened to change.
export async function updateAiSourceMetadata(
  projectDir: string,
  sourceId: string,
  updates: { title?: string; authors?: string[]; year?: string },
): Promise<AiSourceRecord> {
  const manifest = await readManifest(projectDir);
  const source = manifest.sources.find((entry) => entry.id === sourceId);
  if (!source) {
    throw new Error("Source not found");
  }

  const title = updates.title?.trim();
  const authors = updates.authors
    ?.map((author) => author.trim())
    .filter(Boolean);
  const year = updates.year?.trim();

  source.metadata = {
    ...source.metadata,
    title: title || undefined,
    authors: authors?.length ? authors : undefined,
    year: year || undefined,
    provenance: "manual",
    titleIsHeuristic: false,
    authorsAreHeuristic: false,
  };
  source.updatedAt = nowIso();
  await writeManifest(projectDir, { ...manifest, updatedAt: nowIso() });
  return source;
}

export function getAiSourceFilePath(
  projectDir: string,
  source: AiSourceRecord,
): string {
  return path.join(projectDir, ".mywiki", "ai", "sources", source.storedName);
}

export async function readAiSourcePage(
  projectDir: string,
  sourceId: string,
  page: number,
): Promise<{ source: AiSourceRecord; page: number; text: string }> {
  const source = await getAiSourceRecord(projectDir, sourceId);
  if (!source) {
    throw new Error("Source not found");
  }

  const sourcePath = path.join(
    projectDir,
    ".mywiki",
    "ai",
    "sources",
    source.storedName,
  );
  const bytes = new Uint8Array(await fs.readFile(sourcePath));
  const extracted = await extractSourceText(source.originalName, bytes);
  const currentPage = extracted.pages.find((entry) => entry.page === page);

  if (!currentPage) {
    throw new Error(`Page ${page} not found`);
  }

  return {
    source,
    page,
    text: currentPage.text,
  };
}

export async function readAiSourceFull(
  projectDir: string,
  sourceId: string,
): Promise<{ source: AiSourceRecord; text: string; pageCount: number | null }> {
  const source = await getAiSourceRecord(projectDir, sourceId);
  if (!source) {
    throw new Error("Source not found");
  }

  const sourcePath = path.join(
    projectDir,
    ".mywiki",
    "ai",
    "sources",
    source.storedName,
  );
  const bytes = new Uint8Array(await fs.readFile(sourcePath));
  const extracted = await extractSourceText(source.originalName, bytes);
  return {
    source,
    text: extracted.pages
      .map((entry) => (entry.page ? `[page ${entry.page}] ${entry.text}` : entry.text))
      .join("\n\n"),
    pageCount: extracted.pageCount,
  };
}

export async function verifyAiCitation(params: {
  projectDir: string;
  sourceId: string;
  page: number;
  quote: string;
}): Promise<{
  source: AiSourceRecord;
  page: number;
  verified: boolean;
  excerpt: string;
}> {
  const { source, text } = await readAiSourcePage(
    params.projectDir,
    params.sourceId,
    params.page,
  );

  // The whole point of cite() is verifying a quote against a real, primary
  // source — a research note is the AI's own prior synthesis, not primary
  // evidence, so it must never satisfy this gate even if the quote text
  // technically matches. Keyed off source.kind (authoritative, via the
  // manifest) rather than some future denormalized per-chunk field — a
  // convenience shortcut like that could trust stale data from chunks
  // written before this guard existed and silently reopen the hole.
  if (source.kind === "note") {
    throw new Error(
      `"${source.originalName}" is an AI-authored research note, not a primary source — cite() only verifies quotes against uploaded primary sources. Cite the primary source(s) this note draws on instead.`,
    );
  }

  const normalizedQuote = normalizeWhitespace(params.quote);
  const normalizedText = normalizeWhitespace(text);

  const verified =
    normalizedQuote.length > 0 && normalizedText.includes(normalizedQuote);

  if (!verified) {
    throw new Error(
      `Quote not found on page ${params.page} for source ${source.originalName}`,
    );
  }

  return {
    source,
    page: params.page,
    verified,
    excerpt: text,
  };
}
