import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyExactReplace,
  bibtexHasKey,
  ensureBibtexEntry,
  findStaleCitedSourceIds,
  formatBibtexEntry,
} from "./agent";
import type { AiConversation, AiManifest, AiMessage, AiSourceRecord } from "./types";

function conversation(messages: AiMessage[]): AiConversation {
  return {
    id: "conv-1",
    title: "Test conversation",
    intent: "research",
    model: "claude-sonnet-5",
    messages,
    sourceIds: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function assistantMessage(citations: AiMessage["citations"]): AiMessage {
  return {
    id: "msg-1",
    role: "assistant",
    content: "answer",
    createdAt: "2026-01-01T00:00:00.000Z",
    citations,
  };
}

describe("findStaleCitedSourceIds — the deletion-safety gate", () => {
  test("returns nothing when no messages have citations", () => {
    const conv = conversation([assistantMessage(undefined)]);
    expect(findStaleCitedSourceIds(conv, new Set(["src-1"]))).toEqual([]);
  });

  test("returns nothing when every cited source still exists", () => {
    const conv = conversation([
      assistantMessage([{ sourceId: "src-1", page: 2, quote: "q" }]),
    ]);
    expect(findStaleCitedSourceIds(conv, new Set(["src-1", "src-2"]))).toEqual([]);
  });

  test("flags a source that was cited but no longer exists", () => {
    const conv = conversation([
      assistantMessage([{ sourceId: "src-1", page: 2, quote: "q" }]),
    ]);
    expect(findStaleCitedSourceIds(conv, new Set())).toEqual(["src-1"]);
  });

  test("dedupes a source cited multiple times across turns", () => {
    const conv = conversation([
      assistantMessage([{ sourceId: "src-1", page: 2, quote: "a" }]),
      assistantMessage([{ sourceId: "src-1", page: 5, quote: "b" }]),
    ]);
    expect(findStaleCitedSourceIds(conv, new Set())).toEqual(["src-1"]);
  });

  test("only flags the deleted source, not ones still present", () => {
    const conv = conversation([
      assistantMessage([
        { sourceId: "src-1", page: 1, quote: "a" },
        { sourceId: "src-2", page: 1, quote: "b" },
      ]),
    ]);
    expect(findStaleCitedSourceIds(conv, new Set(["src-2"]))).toEqual(["src-1"]);
  });
});

describe("applyExactReplace — the targeted-edit matching gate", () => {
  test("replaces a unique match", () => {
    const result = applyExactReplace("intro\nbody\noutro", "body", "middle");
    expect(result).toEqual({ content: "intro\nmiddle\noutro" });
  });

  test("errors when old_text is absent", () => {
    const result = applyExactReplace("intro\nbody\noutro", "missing", "x");
    expect("error" in result).toBe(true);
  });

  test("errors when old_text matches more than once, without editing", () => {
    const result = applyExactReplace("dup\nfiller\ndup", "dup", "x");
    expect("error" in result).toBe(true);
  });

  test("deletes the snippet when new_text is empty", () => {
    const result = applyExactReplace("keep this\nand this", "this\nand ", "");
    expect(result).toEqual({ content: "keep this" });
  });

  test("does not treat literal $ in new_text as a replacement pattern", () => {
    // LaTeX math mode ("$x^2$") looks like String.replace's special "$&"
    // substitution syntax to a naive content.replace(old, new) call — this
    // is exactly the bug applyExactReplace's function-form replace avoids.
    const result = applyExactReplace("Let x be a value.", "a value", "$x^2$");
    expect(result).toEqual({ content: "Let x be $x^2$." });
  });
});

describe("formatBibtexEntry — the .bib entry writer", () => {
  test("formats fields in insertion order, dropping empty ones", () => {
    const entry = formatBibtexEntry("article", "brown2025mbse", {
      author: "Brown, J.",
      title: "A Survey of MBSE",
      year: "2025",
      note: "",
    });
    expect(entry).toBe(
      "@article{brown2025mbse,\n" +
        "  author = {Brown, J.},\n" +
        "  title = {A Survey of MBSE},\n" +
        "  year = {2025},\n" +
        "}\n",
    );
  });
});

describe("bibtexHasKey — the duplicate-key guard", () => {
  test("finds an existing key regardless of entry type or spacing", () => {
    const bib = "@inproceedings{smith2020,\n  title = {X},\n}\n";
    expect(bibtexHasKey(bib, "smith2020")).toBe(true);
  });

  test("does not false-match a key that is only a prefix of another", () => {
    const bib = "@article{smith2020b,\n  title = {X},\n}\n";
    expect(bibtexHasKey(bib, "smith2020")).toBe(false);
  });

  test("returns false for an empty or unrelated file", () => {
    expect(bibtexHasKey("", "smith2020")).toBe(false);
    expect(bibtexHasKey("@article{jones2019,\n}\n", "smith2020")).toBe(false);
  });
});

function setupProjectWithSource(source: AiSourceRecord, sourceText: string): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "openlatex-agent-"));
  const sourcesDir = path.join(projectDir, ".openlatex", "ai", "sources");
  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".openlatex", "ai", "index"), { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, source.storedName), sourceText);

  const manifest: AiManifest = {
    version: 1,
    updatedAt: source.updatedAt,
    embeddingModel: "test",
    embeddingDimensions: null,
    sources: [source],
    index: { chunkCount: 0, embeddingCount: 0, generatedAt: null },
  };
  fs.writeFileSync(
    path.join(projectDir, ".openlatex", "ai", "manifest.json"),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(path.join(projectDir, "references.bib"), "");
  return projectDir;
}

describe("ensureBibtexEntry — PDF-metadata pre-fill", () => {
  test("fills in omitted fields from pdf-metadata provenance, never overriding what the model passed", async () => {
    const source: AiSourceRecord = {
      id: "src-1",
      originalName: "clean.txt",
      storedName: "src-1.txt",
      relativePath: ".openlatex/ai/sources/src-1.txt",
      kind: "text",
      bytes: 0,
      ingestedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      metadata: {
        title: "A Clean Test Paper Title",
        authors: ["Ada Lovelace", "Alan Turing"],
        year: "2023",
        provenance: "pdf-metadata",
      },
    };
    const projectDir = setupProjectWithSource(source, "A Clean Test Paper Title, by the authors.");

    const result = await ensureBibtexEntry(projectDir, {
      sourceId: source.id,
      bibFile: "references.bib",
      entryType: "article",
      key: "lovelace2023clean",
      // Model supplies its own year but omits title/author — the omitted
      // ones should be pre-filled, the explicit one must survive untouched.
      fields: { year: "1815" },
    });
    expect(result.isError).toBeFalsy();

    const bibContent = fs.readFileSync(path.join(projectDir, "references.bib"), "utf8");
    expect(bibContent).toContain("title = {A Clean Test Paper Title}");
    expect(bibContent).toContain("author = {Ada Lovelace and Alan Turing}");
    expect(bibContent).toContain("year = {1815}");

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test("never pre-fills from heuristic provenance", async () => {
    const source: AiSourceRecord = {
      id: "src-2",
      originalName: "notes.txt",
      storedName: "src-2.txt",
      relativePath: ".openlatex/ai/sources/src-2.txt",
      kind: "text",
      bytes: 0,
      ingestedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      metadata: {
        title: "Some rough first-150-chars guess",
        provenance: "heuristic",
      },
    };
    const projectDir = setupProjectWithSource(source, "Some rough first-150-chars guess and more text.");

    const result = await ensureBibtexEntry(projectDir, {
      sourceId: source.id,
      bibFile: "references.bib",
      entryType: "misc",
      key: "notes2026",
      fields: {},
    });
    expect(result.isError).toBeFalsy();

    const bibContent = fs.readFileSync(path.join(projectDir, "references.bib"), "utf8");
    expect(bibContent).not.toContain("title =");
    expect(bibContent).not.toContain("author =");

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test("refuses to turn a research note into a BibTeX entry", async () => {
    const note: AiSourceRecord = {
      id: "note-1",
      originalName: "My synthesis of the literature",
      storedName: "note-1.md",
      relativePath: ".openlatex/ai/sources/note-1.md",
      kind: "note",
      bytes: 0,
      ingestedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const projectDir = setupProjectWithSource(note, "Synthesized understanding, not a primary source.");

    const result = await ensureBibtexEntry(projectDir, {
      sourceId: note.id,
      bibFile: "references.bib",
      entryType: "misc",
      key: "synth2026",
      fields: { title: "My synthesis of the literature" },
    });
    expect(result.isError).toBe(true);

    const bibContent = fs.readFileSync(path.join(projectDir, "references.bib"), "utf8");
    expect(bibContent).toBe("");

    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});
