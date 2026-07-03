import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// embedTexts (and therefore uploadAiSources/rebuildAiIndex/searchAiKnowledgeBase)
// goes through @huggingface/transformers' pipeline(), which downloads and runs a
// real model — far too slow/network-dependent for a unit test. Replace it with a
// pure function of the input text: deterministic (same text -> same vector on
// every call, regardless of batching), so incremental-vs-batch calls are directly
// comparable, and normalized like the real pipeline always is.
vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => {
    return async (batch: string[]) => {
      const vectors = batch.map((text) => {
        let hash = 0;
        for (let index = 0; index < text.length; index += 1) {
          hash = (hash * 31 + text.charCodeAt(index)) | 0;
        }
        const raw = [
          Math.sin(hash),
          Math.cos(hash),
          Math.sin(hash * 2),
          Math.cos(hash * 2),
        ];
        const norm = Math.sqrt(raw.reduce((sum, x) => sum + x * x, 0)) || 1;
        return raw.map((x) => x / norm);
      });
      return { tolist: () => vectors };
    };
  }),
}));

import {
  chunkText,
  readAiSourcePage,
  verifyAiCitation,
  ensureAiWorkspace,
  uploadAiSources,
  rebuildAiIndex,
  searchAiKnowledgeBase,
  listAiSources,
  isJunkPdfTitle,
  extractYearFromPdfDate,
  heuristicTitleFromText,
  saveResearchNote,
  type AiManifest,
  type AiSourceRecord,
} from "./knowledge-base";

let projectDir: string;

const SOURCE: AiSourceRecord = {
  id: "src-1",
  originalName: "paper.txt",
  storedName: "src-1.txt",
  relativePath: ".openlatex/ai/sources/src-1.txt",
  kind: "text",
  bytes: 0,
  ingestedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const PAGE_TEXT =
  "MBSE is the acronym for Model Based Systems Engineering. It is widely used in aerospace.";

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "openlatex-kb-"));
  const sourcesDir = path.join(projectDir, ".openlatex", "ai", "sources");
  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, SOURCE.storedName), PAGE_TEXT);

  const manifest: AiManifest = {
    version: 1,
    updatedAt: SOURCE.updatedAt,
    embeddingModel: "test",
    embeddingDimensions: null,
    sources: [SOURCE],
    index: { chunkCount: 0, embeddingCount: 0, generatedAt: null },
  };
  fs.writeFileSync(
    path.join(projectDir, ".openlatex", "ai", "manifest.json"),
    JSON.stringify(manifest),
  );
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("readAiSourcePage", () => {
  test("returns the extracted text for a non-PDF source", async () => {
    const result = await readAiSourcePage(projectDir, SOURCE.id, 1);
    expect(result.text).toBe(PAGE_TEXT);
  });

  test("throws for an unknown source id", async () => {
    await expect(
      readAiSourcePage(projectDir, "does-not-exist", 1),
    ).rejects.toThrow("Source not found");
  });
});

describe("verifyAiCitation — the anti-hallucination gate", () => {
  test("verifies an exact quote present on the page", async () => {
    const result = await verifyAiCitation({
      projectDir,
      sourceId: SOURCE.id,
      page: 1,
      quote: "MBSE is the acronym for Model Based Systems Engineering.",
    });
    expect(result.verified).toBe(true);
  });

  test("verifies a quote with different internal whitespace (OCR-style noise)", async () => {
    const result = await verifyAiCitation({
      projectDir,
      sourceId: SOURCE.id,
      page: 1,
      quote: "MBSE   is the  acronym for\nModel Based Systems Engineering.",
    });
    expect(result.verified).toBe(true);
  });

  test("rejects a quote that does not appear on the page", async () => {
    await expect(
      verifyAiCitation({
        projectDir,
        sourceId: SOURCE.id,
        page: 1,
        quote: "MBSE stands for Massively Big Software Engineering.",
      }),
    ).rejects.toThrow(/not found on page/);
  });

  test("rejects a real quote attributed to the wrong page", async () => {
    await expect(
      verifyAiCitation({
        projectDir,
        sourceId: SOURCE.id,
        page: 2,
        quote: "MBSE is the acronym for Model Based Systems Engineering.",
      }),
    ).rejects.toThrow(/Page 2 not found/);
  });

  test("rejects an empty quote", async () => {
    await expect(
      verifyAiCitation({
        projectDir,
        sourceId: SOURCE.id,
        page: 1,
        quote: "   ",
      }),
    ).rejects.toThrow(/not found on page/);
  });

  // The single most important test in this file: a research note must never
  // satisfy cite(), even when the quote text is an exact, verbatim match —
  // otherwise the AI could "verify" a citation against its own prior guess
  // instead of a real primary source, defeating the entire point of cite().
  test("rejects a citation against a research note even when the quote matches exactly", async () => {
    const note = await saveResearchNote({
      projectDir,
      title: "My synthesis of MBSE terminology",
      content:
        "MBSE is the acronym for Model Based Systems Engineering, according to several sources.",
    });

    await expect(
      verifyAiCitation({
        projectDir,
        sourceId: note.id,
        page: 1,
        quote:
          "MBSE is the acronym for Model Based Systems Engineering, according to several sources.",
      }),
    ).rejects.toThrow(/research note, not a primary source/);
  });
});

describe("saveResearchNote", () => {
  test("creates a note source that is searchable but requires non-empty title/content", async () => {
    await expect(
      saveResearchNote({ projectDir, title: "", content: "x" }),
    ).rejects.toThrow(/title is required/);
    await expect(
      saveResearchNote({ projectDir, title: "x", content: "   " }),
    ).rejects.toThrow(/content is required/);

    const note = await saveResearchNote({
      projectDir,
      title: "Findings on quantum entanglement",
      content: "Quantum entanglement links particles across distance regardless of separation.",
      drawsOnSourceIds: [SOURCE.id],
    });
    expect(note.kind).toBe("note");
    expect(note.originalName).toBe("Findings on quantum entanglement");
    expect(note.drawsOnSourceIds).toEqual([SOURCE.id]);

    const hits = await searchAiKnowledgeBase(projectDir, "quantum entanglement particles", 5);
    expect(hits.some((h) => h.chunk.sourceId === note.id)).toBe(true);
  });

  test("updating a note (same noteId) replaces its content instead of duplicating it", async () => {
    const created = await saveResearchNote({
      projectDir,
      title: "Draft note",
      content: "Original content about superconductors.",
    });

    const updated = await saveResearchNote({
      projectDir,
      title: "Draft note",
      content: "Revised content about high-temperature superconductors specifically.",
      noteId: created.id,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.ingestedAt).toBe(created.ingestedAt);

    const manifest = await listAiSources(projectDir);
    const noteSources = manifest.sources.filter((s) => s.id === created.id);
    expect(noteSources).toHaveLength(1);

    const hits = await searchAiKnowledgeBase(projectDir, "high-temperature superconductors", 5);
    const noteHit = hits.find((h) => h.chunk.sourceId === created.id);
    expect(noteHit?.chunk.text).toContain("Revised content");
  });

  test("rejects noteId that refers to a non-note source", async () => {
    await expect(
      saveResearchNote({
        projectDir,
        title: "x",
        content: "y",
        noteId: SOURCE.id,
      }),
    ).rejects.toThrow(/not a research note/);
  });
});

describe("chunkText", () => {
  test("returns no chunks for empty or whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  test("returns a single chunk for short text", () => {
    const chunks = chunkText("A short sentence.", 1200, 160);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("A short sentence.");
    expect(chunks[0].charStart).toBe(0);
  });

  test("splits long text into overlapping chunks on word boundaries", () => {
    const word = "lorem ";
    const longText = word.repeat(500).trim(); // ~3000 chars
    const chunks = chunkText(longText, 1200, 160);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1200);
      // Every chunk boundary should land on a word, not mid-word.
      expect(chunk.text.startsWith(" ")).toBe(false);
      expect(chunk.text.endsWith(" ")).toBe(false);
    }

    // Consecutive chunks should overlap (share trailing/leading content),
    // not skip text — that would silently drop retrievable content.
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].charStart).toBeLessThan(chunks[i - 1].charEnd);
    }
  });
});

function textFile(name: string, content: string): File {
  return new File([Buffer.from(content)], name, { type: "text/plain" });
}

describe("searchAiKnowledgeBase — scoring and cache freshness", () => {
  test("ranks hits by descending score and doesn't return stale results after a new upload", async () => {
    await uploadAiSources(projectDir, [
      textFile("quantum.txt", "Quantum entanglement links particles across distance."),
    ]);

    const firstHits = await searchAiKnowledgeBase(projectDir, "quantum entanglement", 5);
    expect(firstHits.length).toBeGreaterThan(0);
    for (let i = 1; i < firstHits.length; i += 1) {
      expect(firstHits[i].score).toBeLessThanOrEqual(firstHits[i - 1].score);
    }
    expect(firstHits.some((hit) => hit.chunk.text.includes("Sourdough"))).toBe(false);

    // A second call, after a new upload, must reflect the new source — not
    // whatever getKbIndex happened to cache on the first call.
    await uploadAiSources(projectDir, [
      textFile("bread.txt", "Sourdough baking relies on wild yeast fermentation."),
    ]);
    const secondHits = await searchAiKnowledgeBase(projectDir, "sourdough fermentation", 5);
    expect(secondHits.some((hit) => hit.chunk.text.includes("Sourdough"))).toBe(true);
  });
});

describe("appendSourcesToIndex — incremental writes", () => {
  test("two incremental uploads produce index files identical to a full rebuild", async () => {
    await uploadAiSources(projectDir, [
      textFile("alpha.txt", "Alpha paper about quantum entanglement and nonlocal correlations."),
    ]);
    await uploadAiSources(projectDir, [
      textFile("beta.txt", "Beta paper about neural network pruning techniques."),
    ]);

    const { indexDir } = await ensureAiWorkspace(projectDir);
    const chunksPath = path.join(indexDir, "chunks.jsonl");
    const embeddingsPath = path.join(indexDir, "embeddings.bin");

    const appendedChunks = fs.readFileSync(chunksPath, "utf8");
    const appendedEmbeddings = fs.readFileSync(embeddingsPath);

    // Rebuild from scratch using only the two sources actually appended above
    // (the shared fixture's SOURCE was registered in the manifest but never
    // indexed, so it must stay excluded here to keep the comparison apples-to-apples).
    const manifest = await listAiSources(projectDir);
    const uploaded = manifest.sources.filter((source) => source.id !== SOURCE.id);
    await rebuildAiIndex(projectDir, uploaded);

    expect(fs.readFileSync(chunksPath, "utf8")).toBe(appendedChunks);
    expect(fs.readFileSync(embeddingsPath).equals(appendedEmbeddings)).toBe(true);
  });
});

describe("appendSourcesToIndex — corruption guard", () => {
  test("refuses to append onto a truncated embeddings.bin", async () => {
    await uploadAiSources(projectDir, [
      textFile("alpha.txt", "Alpha paper about quantum entanglement."),
    ]);

    const { indexDir } = await ensureAiWorkspace(projectDir);
    const embeddingsPath = path.join(indexDir, "embeddings.bin");
    const original = fs.readFileSync(embeddingsPath);
    fs.writeFileSync(embeddingsPath, original.subarray(0, original.length - 1));

    await expect(
      uploadAiSources(projectDir, [textFile("beta.txt", "Beta paper about neural networks.")]),
    ).rejects.toThrow(/corrupted/);
  });

  test("refuses to append onto a chunks.jsonl missing its trailing newline", async () => {
    await uploadAiSources(projectDir, [
      textFile("alpha.txt", "Alpha paper about quantum entanglement."),
    ]);

    const { indexDir } = await ensureAiWorkspace(projectDir);
    const chunksPath = path.join(indexDir, "chunks.jsonl");
    fs.writeFileSync(chunksPath, fs.readFileSync(chunksPath, "utf8").trimEnd());

    await expect(
      uploadAiSources(projectDir, [textFile("beta.txt", "Beta paper about neural networks.")]),
    ).rejects.toThrow(/corrupted/);
  });
});

describe("isJunkPdfTitle", () => {
  test("rejects empty or whitespace-only titles", () => {
    expect(isJunkPdfTitle("", "paper.pdf")).toBe(true);
    expect(isJunkPdfTitle("   ", "paper.pdf")).toBe(true);
  });

  test("rejects a title that is itself a filename", () => {
    expect(isJunkPdfTitle("draft-final-v2.pdf", "anything.pdf")).toBe(true);
    expect(isJunkPdfTitle("Report.docx", "anything.pdf")).toBe(true);
  });

  test("rejects a title equal to the source's own filename (bare, case-insensitive)", () => {
    expect(isJunkPdfTitle("Paper", "Paper.pdf")).toBe(true);
    expect(isJunkPdfTitle("paper", "PAPER.PDF")).toBe(true);
  });

  test("rejects common PDF-export placeholder titles", () => {
    expect(isJunkPdfTitle("untitled", "cameron2020_mbse_uptake.pdf")).toBe(true);
    expect(isJunkPdfTitle("Untitled Document", "paper.pdf")).toBe(true);
  });

  test("accepts a real title", () => {
    expect(isJunkPdfTitle("Model Based Systems Engineering: A Survey", "paper.pdf")).toBe(
      false,
    );
  });
});

describe("extractYearFromPdfDate", () => {
  test("extracts the year from a well-formed PDF date string", () => {
    expect(extractYearFromPdfDate("D:20230615120000+02'00'")).toBe("2023");
  });

  test("returns undefined for a non-string, missing, or malformed value", () => {
    expect(extractYearFromPdfDate(undefined)).toBeUndefined();
    expect(extractYearFromPdfDate(12345)).toBeUndefined();
    expect(extractYearFromPdfDate("not a date")).toBeUndefined();
  });

  test("rejects an out-of-range year (placeholder/malformed dates)", () => {
    expect(extractYearFromPdfDate("D:00000000000000")).toBeUndefined();
    expect(extractYearFromPdfDate(`D:${new Date().getFullYear() + 50}0101000000`)).toBeUndefined();
  });
});

describe("heuristicTitleFromText", () => {
  test("returns undefined for empty or whitespace-only text", () => {
    expect(heuristicTitleFromText("")).toBeUndefined();
    expect(heuristicTitleFromText("   \n  ")).toBeUndefined();
  });

  test("returns short text as-is", () => {
    expect(heuristicTitleFromText("A Short Paper Title")).toBe("A Short Paper Title");
  });

  test("truncates long text to ~150 characters with an ellipsis", () => {
    const longText = "word ".repeat(60).trim(); // 299 chars
    const title = heuristicTitleFromText(longText);
    expect(title?.endsWith("…")).toBe(true);
    expect(title?.length).toBeLessThanOrEqual(151);
  });
});

describe("upload metadata provenance", () => {
  test("a plain-text source gets heuristic title-only metadata, never authors", async () => {
    const { manifest } = await uploadAiSources(projectDir, [
      textFile("notes.txt", "Notes on quantum entanglement and nonlocal correlations between particles."),
    ]);
    const uploaded = manifest.sources.find((s) => s.originalName === "notes.txt");
    expect(uploaded?.metadata?.provenance).toBe("heuristic");
    expect(uploaded?.metadata?.title).toBeTruthy();
    expect(uploaded?.metadata?.authors).toBeUndefined();
  });
});
