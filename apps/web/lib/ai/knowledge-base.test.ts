import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chunkText,
  readAiSourcePage,
  verifyAiCitation,
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
