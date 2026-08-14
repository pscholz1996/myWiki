import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { AiChunkRecord } from "@/lib/ai/knowledge-base";
import { reciprocalRankFusion } from "@/lib/ai/lexical-search";

/**
 * The knowledge-base index: one SQLite file (`.mywiki/ai/index/index.db`)
 * holding chunk rows, an FTS5 full-text index, and a sqlite-vec vector
 * table, all keyed by the same rowid. This replaces the original
 * chunks.jsonl + embeddings.bin + in-memory BM25 combination, which loaded
 * the entire corpus into RAM per process — fine at 10 sources, hopeless at
 * the 500–5,000 this system is meant to hold. SQLite gives incremental
 * writes, crash safety (WAL), and millisecond lookups without any
 * in-process cache to invalidate.
 *
 * The vec0 table is created lazily on first insert because the embedding
 * dimension comes from whatever model produced the vectors (384 for the
 * real model; unit tests use tiny mock vectors).
 */

const DB_FILE = "index.db";

export interface IndexedChunkInsert {
  record: AiChunkRecord;
  embedding: number[];
}

export interface HybridHit {
  chunk: AiChunkRecord;
  score: number;
}

const openDbs = new Map<string, Database.Database>();

export function openIndexDb(indexDir: string): Database.Database {
  const dbPath = path.join(indexDir, DB_FILE);
  const existing = openDbs.get(dbPath);
  if (existing?.open) return existing;

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      rowid INTEGER PRIMARY KEY,
      chunk_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL,
      source_file TEXT NOT NULL,
      page INTEGER,
      char_start INTEGER NOT NULL,
      char_end INTEGER NOT NULL,
      heading TEXT,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
      USING fts5(text, heading, tokenize='unicode61 remove_diacritics 2');
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  openDbs.set(dbPath, db);
  return db;
}

function getMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getIndexDimensions(db: Database.Database): number | null {
  const raw = getMeta(db, "dimensions");
  return raw ? Number(raw) : null;
}

export function getIndexChunkCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {
    n: number;
  };
  return row.n;
}

function ensureVecTable(db: Database.Database, dimensions: number): void {
  const existing = getIndexDimensions(db);
  if (existing) {
    if (existing !== dimensions) {
      throw new Error(
        `Embedding dimensions changed (index has ${existing}, new vectors have ${dimensions}) — rebuild the index`,
      );
    }
    return;
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${dimensions}])`,
  );
  setMeta(db, "dimensions", String(dimensions));
}

function embeddingBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

export function insertChunks(
  db: Database.Database,
  inserts: IndexedChunkInsert[],
): void {
  if (inserts.length === 0) return;
  const dimensions = inserts[0].embedding.length;
  ensureVecTable(db, dimensions);

  const insertChunk = db.prepare(
    `INSERT INTO chunks (chunk_id, source_id, source_file, page, char_start, char_end, heading, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    "INSERT INTO chunks_fts(rowid, text, heading) VALUES (?, ?, ?)",
  );
  const insertVec = db.prepare(
    "INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)",
  );

  const run = db.transaction((batch: IndexedChunkInsert[]) => {
    for (const { record, embedding } of batch) {
      const info = insertChunk.run(
        record.id,
        record.sourceId,
        record.sourceFile,
        record.page,
        record.charStart,
        record.charEnd,
        record.heading ?? null,
        record.text,
      );
      const rowid = info.lastInsertRowid as number | bigint;
      insertFts.run(rowid, record.text, record.heading ?? "");
      insertVec.run(BigInt(rowid), embeddingBuffer(embedding));
    }
  });
  run(inserts);
}

export function deleteChunksBySource(
  db: Database.Database,
  sourceIds: string[],
): void {
  if (sourceIds.length === 0) return;
  const run = db.transaction((ids: string[]) => {
    const selectRows = db.prepare(
      "SELECT rowid FROM chunks WHERE source_id = ?",
    );
    const delFts = db.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
    const delChunk = db.prepare("DELETE FROM chunks WHERE rowid = ?");
    const hasVec = getIndexDimensions(db) !== null;
    const delVec = hasVec
      ? db.prepare("DELETE FROM chunks_vec WHERE rowid = ?")
      : null;
    for (const sourceId of ids) {
      const rows = selectRows.all(sourceId) as Array<{
        rowid: number | bigint;
      }>;
      for (const { rowid } of rows) {
        delFts.run(rowid);
        delVec?.run(BigInt(rowid));
        delChunk.run(rowid);
      }
    }
  });
  run(sourceIds);
}

/**
 * Closes every cached connection. Windows refuses to delete or rename a
 * directory holding an open SQLite file, so anything that discards an index
 * directory (tests, switching knowledge folders) must release the handles.
 */
export function closeIndexDbs(): void {
  for (const db of openDbs.values()) {
    if (db.open) db.close();
  }
  openDbs.clear();
}

/** Drops all index content (rebuild path) while keeping the file/handle. */
export function clearIndexDb(db: Database.Database): void {
  db.exec("DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM meta;");
  db.exec("DROP TABLE IF EXISTS chunks_vec;");
}

interface ChunkRow {
  rowid: number;
  chunk_id: string;
  source_id: string;
  source_file: string;
  page: number | null;
  char_start: number;
  char_end: number;
  heading: string | null;
  text: string;
}

function rowToRecord(row: ChunkRow): AiChunkRecord {
  return {
    id: row.chunk_id,
    sourceId: row.source_id,
    sourceFile: row.source_file,
    page: row.page,
    charStart: row.char_start,
    charEnd: row.char_end,
    heading: row.heading ?? undefined,
    text: row.text,
  };
}

/**
 * Turns a natural-language question into an FTS5 MATCH expression. FTS5
 * has its own query syntax where bare punctuation is a syntax error, so
 * every token is quoted and OR-ed: recall over precision, since the vector
 * leg of the hybrid search and RRF handle precision.
 */
function toFtsQuery(query: string): string | null {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu);
  if (!tokens || tokens.length === 0) return null;
  return [...new Set(tokens)]
    .slice(0, 24)
    .map((token) => `"${token}"`)
    .join(" OR ");
}

export function searchHybrid(
  db: Database.Database,
  params: {
    queryText: string;
    queryEmbedding: number[] | null;
    topK: number;
    allowedSourceIds?: Set<string> | null;
  },
): HybridHit[] {
  const { queryText, queryEmbedding, topK, allowedSourceIds } = params;
  // Over-fetch each leg so RRF has real overlap to work with, and so
  // source-scoped searches survive post-filtering.
  const legLimit = Math.min(400, Math.max(64, topK * 12));

  const allowed = (row: ChunkRow) =>
    !allowedSourceIds || allowedSourceIds.has(row.source_id);

  const byRowid = new Map<number, ChunkRow>();

  const lexicalIds: string[] = [];
  const ftsQuery = toFtsQuery(queryText);
  if (ftsQuery) {
    const rows = db
      .prepare(
        `SELECT c.*, c.rowid AS rowid, bm25(chunks_fts) AS s
         FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
         WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?`,
      )
      .all(ftsQuery, legLimit) as Array<ChunkRow & { s: number }>;
    for (const row of rows) {
      if (!allowed(row)) continue;
      byRowid.set(Number(row.rowid), row);
      lexicalIds.push(row.chunk_id);
    }
  }

  const semanticIds: string[] = [];
  if (queryEmbedding && getIndexDimensions(db)) {
    const rows = db
      .prepare(
        `SELECT c.*, c.rowid AS rowid, v.distance AS d
         FROM (SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ?) v
         JOIN chunks c ON c.rowid = v.rowid
         ORDER BY v.distance`,
      )
      .all(embeddingBuffer(queryEmbedding), legLimit) as Array<
      ChunkRow & { d: number }
    >;
    for (const row of rows) {
      if (!allowed(row)) continue;
      byRowid.set(Number(row.rowid), row);
      semanticIds.push(row.chunk_id);
    }
  }

  const fused = reciprocalRankFusion([semanticIds, lexicalIds]);
  const byChunkId = new Map<string, ChunkRow>();
  for (const row of byRowid.values()) byChunkId.set(row.chunk_id, row);

  return [...fused.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, topK)
    .flatMap(([chunkId, score]) => {
      const row = byChunkId.get(chunkId);
      return row ? [{ chunk: rowToRecord(row), score }] : [];
    });
}
