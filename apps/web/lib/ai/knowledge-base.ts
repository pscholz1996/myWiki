import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "@huggingface/transformers";
import type { AiManifest, AiSourceKind, AiSourceRecord } from "@/lib/ai/types";

export type { AiManifest, AiSourceKind, AiSourceRecord };

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

const AI_DIR = [".openlatex", "ai"] as const;
const SOURCES_DIR = [".openlatex", "ai", "sources"] as const;
const INDEX_DIR = [".openlatex", "ai", "index"] as const;
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

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
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

async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const extractor = await getEmbeddingPipeline();
  const batchSize = 16;
  const vectors: number[][] = [];

  for (let index = 0; index < texts.length; index += batchSize) {
    const batch = texts.slice(index, index + batchSize);
    const output = await extractor(batch, { pooling: "mean", normalize: true });
    vectors.push(...(output.tolist() as number[][]));
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

async function extractPdfPages(
  data: Uint8Array,
): Promise<Array<{ page: number; text: string }>> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data }).promise;
  const pages: Array<{ page: number; text: string }> = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item: any) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push({ page: pageNumber, text: normalizeWhitespace(text) });
  }

  return pages;
}

async function extractSourceText(
  fileName: string,
  data: Uint8Array,
): Promise<{
  pageCount: number | null;
  pages: Array<{ page: number | null; text: string }>;
}> {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") {
    const pages = await extractPdfPages(data);
    return { pageCount: pages.length, pages };
  }

  const text = normalizeWhitespace(Buffer.from(data).toString("utf8"));
  return {
    pageCount: null,
    pages: [{ page: 1, text }],
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
    relativePath: posixJoin(".openlatex", "ai", "sources", storedName),
  };
}

export async function listAiSources(projectDir: string): Promise<AiManifest> {
  return readManifest(projectDir);
}

async function extractAndChunkSource(
  projectDir: string,
  source: AiSourceRecord,
): Promise<{ records: AiChunkRecord[]; texts: string[]; pageCount: number | null }> {
  const sourcePath = path.join(
    projectDir,
    ".openlatex",
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

  return { records, texts, pageCount: extracted.pageCount };
}

/**
 * Appends chunks/embeddings for newly-added sources to the existing index
 * instead of re-extracting and re-embedding the whole corpus. Embedding is
 * CPU-bound and runs on the main thread, so cost must scale with what
 * changed, not with total corpus size — otherwise every upload/delete on a
 * large knowledge base blocks the server for minutes.
 */
async function appendSourcesToIndex(
  projectDir: string,
  newSources: AiSourceRecord[],
): Promise<void> {
  const { indexDir } = await ensureAiWorkspace(projectDir);
  const chunksPath = path.join(indexDir, CHUNKS_FILE);
  const embeddingsPath = path.join(indexDir, EMBEDDINGS_FILE);

  const existingChunks = await readJsonLines<AiChunkRecord>(chunksPath);
  const existingEmbeddings = await readEmbeddingMatrix(embeddingsPath);
  const manifest = await readManifest(projectDir);
  const dimensions = manifest.embeddingDimensions ?? 0;

  const newRecords: AiChunkRecord[] = [];
  const newTexts: string[] = [];
  const pageCounts = new Map<string, number | null>();

  for (const source of newSources) {
    const { records, texts, pageCount } = await extractAndChunkSource(
      projectDir,
      source,
    );
    newRecords.push(...records);
    newTexts.push(...texts);
    pageCounts.set(source.id, pageCount);
  }

  const newVectors = await embedTexts(newTexts);
  const newDimensions = newVectors[0]?.length ?? dimensions;

  const combinedChunks = [...existingChunks, ...newRecords];
  await writeJsonLines(chunksPath, combinedChunks);

  const combinedVectorCount =
    existingChunks.length + newVectors.length;
  const buffer = Buffer.alloc(combinedVectorCount * newDimensions * 4);
  const view = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    combinedVectorCount * newDimensions,
  );
  view.set(existingEmbeddings.subarray(0, existingChunks.length * newDimensions));
  let offset = existingChunks.length * newDimensions;
  for (const vector of newVectors) {
    view.set(vector, offset);
    offset += newDimensions;
  }
  await fs.writeFile(embeddingsPath, buffer);

  await writeManifest(projectDir, {
    version: 1,
    updatedAt: nowIso(),
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimensions: newDimensions || dimensions || null,
    sources: [
      ...manifest.sources,
      ...newSources.map((source) => ({
        ...source,
        pageCount: pageCounts.get(source.id) ?? source.pageCount,
      })),
    ],
    index: {
      chunkCount: combinedChunks.length,
      embeddingCount: combinedVectorCount,
      generatedAt: nowIso(),
    },
  });
}

/**
 * Removes a source's chunks/embeddings from the index by filtering the
 * existing arrays — no re-embedding required, since nothing about the
 * remaining sources changed.
 */
async function removeSourceFromIndex(
  projectDir: string,
  sourceId: string,
): Promise<void> {
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
    if (chunk.sourceId === sourceId) return;
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
    sources: manifest.sources.filter((source) => source.id !== sourceId),
    index: {
      chunkCount: keptChunks.length,
      embeddingCount: keptVectors.length,
      generatedAt: nowIso(),
    },
  });
}

export interface RejectedSourceFile {
  name: string;
  reason: string;
}

export interface UploadAiSourcesResult {
  manifest: AiManifest;
  rejected: RejectedSourceFile[];
}

export async function uploadAiSources(
  projectDir: string,
  files: File[],
): Promise<UploadAiSourcesResult> {
  const { sourcesDir, indexDir } = await ensureAiWorkspace(projectDir);
  await fs.mkdir(indexDir, { recursive: true });

  const newSources: AiSourceRecord[] = [];
  const rejected: RejectedSourceFile[] = [];

  for (const file of files) {
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

    const id = crypto.randomUUID();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const saved = await saveSourceFile(sourcesDir, id, originalName, bytes);

    newSources.push({
      id,
      originalName,
      storedName: saved.storedName,
      relativePath: saved.relativePath,
      kind: ext === ".pdf" ? "pdf" : ext === ".md" ? "markdown" : "text",
      bytes: file.size,
      ingestedAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  if (newSources.length > 0) {
    await appendSourcesToIndex(projectDir, newSources);
  }

  return { manifest: await readManifest(projectDir), rejected };
}

export async function deleteAiSource(
  projectDir: string,
  sourceId: string,
): Promise<AiManifest> {
  const { sourcesDir } = await ensureAiWorkspace(projectDir);
  const manifest = await readManifest(projectDir);
  const removed = manifest.sources.find((source) => source.id === sourceId);

  if (!removed) {
    throw new Error("Source not found");
  }

  await fs.rm(path.join(sourcesDir, removed.storedName), { force: true });
  await removeSourceFromIndex(projectDir, sourceId);
  return readManifest(projectDir);
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

  for (const source of sources) {
    const sourcePath = path.join(
      projectDir,
      ".openlatex",
      "ai",
      "sources",
      source.storedName,
    );
    const bytes = await fs.readFile(sourcePath);
    const extracted = await extractSourceText(
      source.originalName,
      new Uint8Array(bytes),
    );

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
    })),
    index: {
      chunkCount: chunkRecords.length,
      embeddingCount: vectors.length,
      generatedAt: nowIso(),
    },
  };
}

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
  const chunkRecords = await readJsonLines<AiChunkRecord>(
    path.join(indexDir, CHUNKS_FILE),
  );
  const embeddingMatrix = await readEmbeddingMatrix(
    path.join(indexDir, EMBEDDINGS_FILE),
  );

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

  const dimensions = manifest.embeddingDimensions;
  const queryVector = (await embedTexts([query]))[0];
  if (!queryVector) return [];

  const queryEmbedding = new Float32Array(queryVector);
  const scored: AiSearchHit[] = [];

  for (let index = 0; index < chunkRecords.length; index += 1) {
    const chunk = chunkRecords[index];
    if (allowedSourceIds && !allowedSourceIds.has(chunk.sourceId)) continue;

    const start = index * dimensions;
    const end = start + dimensions;
    const chunkEmbedding = embeddingMatrix.slice(start, end);
    scored.push({
      score: cosineSimilarity(queryEmbedding, chunkEmbedding),
      chunk,
    });
  }

  return scored.sort((left, right) => right.score - left.score).slice(0, topK);
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

export function getAiSourceFilePath(
  projectDir: string,
  source: AiSourceRecord,
): string {
  return path.join(projectDir, ".openlatex", "ai", "sources", source.storedName);
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
    ".openlatex",
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
    ".openlatex",
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
