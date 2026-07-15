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

// lookupCrossrefMetadata makes a real network call — mocked here so every
// other test in this file (which never cares about CrossRef) stays fast
// and deterministic. Defaults to "no match found," matching what actually
// happens for most titles; individual tests override this per-call to
// exercise the enrichment merge logic.
interface MockCrossrefMetadata {
  title: string;
  authors: string[];
  year?: string;
  doi?: string;
}
const lookupCrossrefMetadataMock = vi.fn<
  (title: string) => Promise<MockCrossrefMetadata | undefined>
>(async () => undefined);
// titleSimilarity is real (not mocked) — knowledge-base.ts also uses it for
// near-duplicate-title detection at upload time, and that logic is worth
// exercising against the actual scoring function, not a stand-in.
vi.mock("./crossref", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./crossref")>();
  return {
    ...actual,
    lookupCrossrefMetadata: (title: string) =>
      lookupCrossrefMetadataMock(title),
  };
});

import {
  chunkText,
  readAiSourcePage,
  verifyAiCitation,
  uploadAiSources,
  rebuildAiIndex,
  searchAiKnowledgeBase,
  listAiSources,
  isJunkPdfTitle,
  extractYearFromPdfDate,
  heuristicTitleFromText,
  saveResearchNote,
  updateAiSourceMetadata,
  deleteAiSource,
  deleteAiSources,
  type AiManifest,
  type AiSourceRecord,
} from "./knowledge-base";

let projectDir: string;

// Hand-builds a minimal, well-formed single-page PDF with a controllable
// /Info dictionary — lets metadata-extraction tests assert exact expected
// values (including a genuinely blank Title, which real sample PDFs make
// hard to guarantee) without a binary test fixture. Pass either `bodyText`
// (a single run at 12pt) or `textRuns` (multiple runs at distinct font
// sizes/positions, for testing the largest-font title heuristic). `x`
// defaults to 72 (the original single-column left margin); set it
// explicitly to simulate a multi-column layout (e.g. two authors side by
// side) for the column-gap-detection heuristic.
function buildPdfWithMetadata(params: {
  title: string;
  author: string;
  creationDate: string;
  bodyText?: string;
  textRuns?: Array<{ text: string; fontSize: number; y: number; x?: number }>;
}): Buffer {
  const runs = params.textRuns ?? [
    { text: params.bodyText ?? "", fontSize: 12, y: 700 },
  ];
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
    "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const content = runs
    .map(
      (run) =>
        `BT /F1 ${run.fontSize} Tf ${run.x ?? 72} ${run.y} Td (${run.text}) Tj ET`,
    )
    .join("\n");
  objects[5] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objects[6] = `<< /Title (${params.title}) /Author (${params.author}) /CreationDate (${params.creationDate}) >>`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i <= 6; i += 1) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += "xref\n0 7\n0000000000 65535 f \n";
  for (let i = 1; i <= 6; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Info 6 0 R /Size 7 >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

const SOURCE: AiSourceRecord = {
  id: "src-1",
  originalName: "paper.txt",
  storedName: "src-1.txt",
  relativePath: ".mywiki/ai/sources/src-1.txt",
  kind: "text",
  bytes: 0,
  ingestedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const PAGE_TEXT =
  "MBSE is the acronym for Model Based Systems Engineering. It is widely used in aerospace.";

beforeEach(() => {
  lookupCrossrefMetadataMock.mockReset();
  lookupCrossrefMetadataMock.mockResolvedValue(undefined);
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mywiki-kb-"));
  const sourcesDir = path.join(projectDir, ".mywiki", "ai", "sources");
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
    path.join(projectDir, ".mywiki", "ai", "manifest.json"),
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
      content:
        "Quantum entanglement links particles across distance regardless of separation.",
      drawsOnSourceIds: [SOURCE.id],
    });
    expect(note.kind).toBe("note");
    expect(note.originalName).toBe("Findings on quantum entanglement");
    expect(note.drawsOnSourceIds).toEqual([SOURCE.id]);

    const hits = await searchAiKnowledgeBase(
      projectDir,
      "quantum entanglement particles",
      5,
    );
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
      content:
        "Revised content about high-temperature superconductors specifically.",
      noteId: created.id,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.ingestedAt).toBe(created.ingestedAt);

    const manifest = await listAiSources(projectDir);
    const noteSources = manifest.sources.filter((s) => s.id === created.id);
    expect(noteSources).toHaveLength(1);

    const hits = await searchAiKnowledgeBase(
      projectDir,
      "high-temperature superconductors",
      5,
    );
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
      textFile(
        "quantum.txt",
        "Quantum entanglement links particles across distance.",
      ),
    ]);

    const firstHits = await searchAiKnowledgeBase(
      projectDir,
      "quantum entanglement",
      5,
    );
    expect(firstHits.length).toBeGreaterThan(0);
    for (let i = 1; i < firstHits.length; i += 1) {
      expect(firstHits[i].score).toBeLessThanOrEqual(firstHits[i - 1].score);
    }
    expect(firstHits.some((hit) => hit.chunk.text.includes("Sourdough"))).toBe(
      false,
    );

    // A second call, after a new upload, must reflect the new source — not
    // whatever getKbIndex happened to cache on the first call.
    await uploadAiSources(projectDir, [
      textFile(
        "bread.txt",
        "Sourdough baking relies on wild yeast fermentation.",
      ),
    ]);
    const secondHits = await searchAiKnowledgeBase(
      projectDir,
      "sourdough fermentation",
      5,
    );
    expect(secondHits.some((hit) => hit.chunk.text.includes("Sourdough"))).toBe(
      true,
    );
  });
});

describe("appendSourcesToIndex — incremental writes", () => {
  test("two incremental uploads search identically to a full rebuild", async () => {
    await uploadAiSources(projectDir, [
      textFile(
        "alpha.txt",
        "Alpha paper about quantum entanglement and nonlocal correlations.",
      ),
    ]);
    await uploadAiSources(projectDir, [
      textFile(
        "beta.txt",
        "Beta paper about neural network pruning techniques.",
      ),
    ]);

    const incrementalAlpha = await searchAiKnowledgeBase(
      projectDir,
      "quantum entanglement",
      3,
    );
    const incrementalBeta = await searchAiKnowledgeBase(
      projectDir,
      "neural network pruning",
      3,
    );

    // Rebuild from scratch using only the two sources actually appended above
    // (the shared fixture's SOURCE was registered in the manifest but never
    // indexed, so it must stay excluded here to keep the comparison apples-to-apples).
    const manifest = await listAiSources(projectDir);
    const uploaded = manifest.sources.filter(
      (source) => source.id !== SOURCE.id,
    );
    await rebuildAiIndex(projectDir, uploaded);

    const rebuiltAlpha = await searchAiKnowledgeBase(
      projectDir,
      "quantum entanglement",
      3,
    );
    const rebuiltBeta = await searchAiKnowledgeBase(
      projectDir,
      "neural network pruning",
      3,
    );

    expect(rebuiltAlpha.map((h) => h.chunk.id)).toEqual(
      incrementalAlpha.map((h) => h.chunk.id),
    );
    expect(rebuiltBeta.map((h) => h.chunk.id)).toEqual(
      incrementalBeta.map((h) => h.chunk.id),
    );
    expect(rebuiltAlpha[0]?.chunk.text).toContain("quantum entanglement");
  });

  test("deleting a source removes its chunks from search", async () => {
    await uploadAiSources(projectDir, [
      textFile("alpha.txt", "Alpha paper about quantum entanglement."),
      textFile("beta.txt", "Beta paper about neural network pruning."),
    ]);
    const manifest = await listAiSources(projectDir);
    const alpha = manifest.sources.find((s) => s.originalName === "alpha.txt");
    expect(alpha).toBeDefined();

    await deleteAiSource(projectDir, alpha!.id);

    const hits = await searchAiKnowledgeBase(
      projectDir,
      "quantum entanglement",
      5,
    );
    expect(hits.every((h) => h.chunk.sourceId !== alpha!.id)).toBe(true);
    const betaHits = await searchAiKnowledgeBase(
      projectDir,
      "neural network pruning",
      5,
    );
    expect(betaHits.length).toBeGreaterThan(0);
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
    expect(isJunkPdfTitle("untitled", "cameron2020_mbse_uptake.pdf")).toBe(
      true,
    );
    expect(isJunkPdfTitle("Untitled Document", "paper.pdf")).toBe(true);
  });

  test("rejects PowerPoint export placeholder titles (seen on real lecture slides)", () => {
    expect(isJunkPdfTitle("PowerPoint-Präsentation", "5_Systems_Engineering_SS2025.pdf")).toBe(true);
    expect(isJunkPdfTitle("PowerPoint Presentation", "slides.pdf")).toBe(true);
  });

  test("accepts a real title", () => {
    expect(
      isJunkPdfTitle("Model Based Systems Engineering: A Survey", "paper.pdf"),
    ).toBe(false);
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
    expect(
      extractYearFromPdfDate(`D:${new Date().getFullYear() + 50}0101000000`),
    ).toBeUndefined();
  });
});

describe("heuristicTitleFromText", () => {
  test("returns undefined for empty or whitespace-only text", () => {
    expect(heuristicTitleFromText("")).toBeUndefined();
    expect(heuristicTitleFromText("   \n  ")).toBeUndefined();
  });

  test("returns short text as-is", () => {
    expect(heuristicTitleFromText("A Short Paper Title")).toBe(
      "A Short Paper Title",
    );
  });

  test("truncates long text to ~150 characters with an ellipsis", () => {
    const longText = "word ".repeat(60).trim(); // 299 chars
    const title = heuristicTitleFromText(longText);
    expect(title?.endsWith("…")).toBe(true);
    expect(title?.length).toBeLessThanOrEqual(151);
  });

  test("prefers the text's own first line over the full flattened blob", () => {
    const text =
      "My Great Thesis Title\n\nThis is a long introductory paragraph that " +
      "goes on for quite a while and would otherwise get truncated mid-sentence.";
    expect(heuristicTitleFromText(text)).toBe("My Great Thesis Title");
  });

  test("falls back to the flattened blob when the text has no line breaks", () => {
    expect(heuristicTitleFromText("A Short Paper Title")).toBe(
      "A Short Paper Title",
    );
  });
});

describe("upload metadata provenance", () => {
  test("a plain-text source gets heuristic title-only metadata, never authors", async () => {
    const { manifest } = await uploadAiSources(projectDir, [
      textFile(
        "notes.txt",
        "Notes on quantum entanglement and nonlocal correlations between particles.",
      ),
    ]);
    const uploaded = manifest.sources.find(
      (s) => s.originalName === "notes.txt",
    );
    expect(uploaded?.metadata?.provenance).toBe("heuristic");
    expect(uploaded?.metadata?.title).toBeTruthy();
    expect(uploaded?.metadata?.authors).toBeUndefined();
  });

  // A real-world case that surfaced live: a LaTeX-produced PDF frequently has
  // a genuinely blank Title field (its source never set
  // \hypersetup{pdftitle=...}) while still having a real CreationDate/Author
  // — the title should backfill from the heuristic guess instead of the
  // whole source silently showing no title at all, but that backfilled
  // title must be tagged so it never leaks into a citation (see the
  // ensureBibtexEntry test in agent.test.ts).
  test("backfills a heuristic title when PDF metadata has a real year but a blank title", async () => {
    const pdfBytes = buildPdfWithMetadata({
      title: "",
      author: "Ada Lovelace",
      creationDate: "D:20230615120000+00'00'",
      bodyText: "Findings on quantum entanglement and nonlocal correlations.",
    });
    const file = new File([new Uint8Array(pdfBytes)], "blank-title.pdf", {
      type: "application/pdf",
    });

    const { manifest } = await uploadAiSources(projectDir, [file]);
    const uploaded = manifest.sources.find(
      (s) => s.originalName === "blank-title.pdf",
    );
    expect(uploaded?.metadata?.provenance).toBe("pdf-metadata");
    expect(uploaded?.metadata?.year).toBe("2023");
    expect(uploaded?.metadata?.authors).toEqual(["Ada Lovelace"]);
    expect(uploaded?.metadata?.titleIsHeuristic).toBe(true);
    expect(uploaded?.metadata?.title).toContain(
      "Findings on quantum entanglement",
    );
  });

  // Real papers/books put the title in a visibly larger font than the
  // author names below it — confirmed against real sample PDFs where the
  // old "first 150 raw characters" heuristic ran the title and author
  // names together into one garbled, hard-to-read string.
  test("isolates the title from smaller-font author text using page-1 font size", async () => {
    const pdfBytes = buildPdfWithMetadata({
      title: "",
      author: "",
      creationDate: "D:20240101120000+00'00'",
      textRuns: [
        { text: "A Great Paper Title", fontSize: 24, y: 700 },
        { text: "Jane Doe, John Smith", fontSize: 10, y: 670 },
      ],
    });
    const file = new File([new Uint8Array(pdfBytes)], "multi-font.pdf", {
      type: "application/pdf",
    });

    const { manifest } = await uploadAiSources(projectDir, [file]);
    const uploaded = manifest.sources.find(
      (s) => s.originalName === "multi-font.pdf",
    );
    expect(uploaded?.metadata?.title).toBe("A Great Paper Title");
    expect(uploaded?.metadata?.title).not.toContain("Jane Doe");
  });

  test("reconstructs a title that wraps across two lines at the same font size", async () => {
    const pdfBytes = buildPdfWithMetadata({
      title: "",
      author: "",
      creationDate: "D:20240101120000+00'00'",
      textRuns: [
        { text: "A Very Long Paper Title That", fontSize: 24, y: 720 },
        { text: "Wraps Across Two Lines", fontSize: 24, y: 690 },
        { text: "Jane Doe", fontSize: 10, y: 660 },
      ],
    });
    const file = new File([new Uint8Array(pdfBytes)], "wrapped-title.pdf", {
      type: "application/pdf",
    });

    const { manifest } = await uploadAiSources(projectDir, [file]);
    const uploaded = manifest.sources.find(
      (s) => s.originalName === "wrapped-title.pdf",
    );
    expect(uploaded?.metadata?.title).toBe(
      "A Very Long Paper Title That Wraps Across Two Lines",
    );
  });

  // A real-world case that surfaced live: a decorative drop-cap (a single
  // oversized capital letter starting the body text) can be set even bigger
  // than the actual title — confirmed against a real paper where a 29.9pt
  // drop-cap "T" outsized its own 23.9pt title, producing a single-letter
  // "title" before this test existed.
  test("skips a decorative drop-cap bigger than the title itself", async () => {
    const pdfBytes = buildPdfWithMetadata({
      title: "",
      author: "",
      creationDate: "D:20240101120000+00'00'",
      textRuns: [
        { text: "T", fontSize: 30, y: 720 },
        { text: "A Real Paper Title", fontSize: 24, y: 690 },
        { text: "Jane Doe", fontSize: 10, y: 660 },
        {
          text: "HE rest of the drop-capped word continues here.",
          fontSize: 10,
          y: 630,
        },
      ],
    });
    const file = new File([new Uint8Array(pdfBytes)], "drop-cap.pdf", {
      type: "application/pdf",
    });

    const { manifest } = await uploadAiSources(projectDir, [file]);
    const uploaded = manifest.sources.find(
      (s) => s.originalName === "drop-cap.pdf",
    );
    expect(uploaded?.metadata?.title).toBe("A Real Paper Title");
  });
});

describe("page-1 layout — author extraction", () => {
  test("finds a byline directly below the title (the common academic-paper layout)", async () => {
    const pdfBytes = buildPdfWithMetadata({
      title: "",
      author: "",
      creationDate: "D:20240101120000+00'00'",
      textRuns: [
        { text: "A Great Paper Title", fontSize: 24, y: 700 },
        { text: "Jane Doe, John Smith", fontSize: 10, y: 670 },
      ],
    });
    const file = new File([new Uint8Array(pdfBytes)], "below-title.pdf", {
      type: "application/pdf",
    });

    const { manifest } = await uploadAiSources(projectDir, [file]);
    const uploaded = manifest.sources.find(
      (s) => s.originalName === "below-title.pdf",
    );
    expect(uploaded?.metadata?.authors).toEqual(["Jane Doe", "John Smith"]);
    expect(uploaded?.metadata?.authorsAreHeuristic).toBe(true);
  });

  // A real-world case that surfaced live: a book cover puts the author's
  // name in a banner ABOVE the title, not below it — the byline search has
  // to look both directions from the title rather than assuming one fixed
  // direction.
  test("finds a byline above the title (the book-cover layout)", async () => {
    const pdfBytes = buildPdfWithMetadata({
      title: "",
      author: "",
      creationDate: "D:20240101120000+00'00'",
      textRuns: [
        { text: "Martina Keller", fontSize: 16, y: 500 },
        { text: "System Lifecycle Management", fontSize: 40, y: 400 },
      ],
    });
    const file = new File([new Uint8Array(pdfBytes)], "above-title.pdf", {
      type: "application/pdf",
    });

    const { manifest } = await uploadAiSources(projectDir, [file]);
    const uploaded = manifest.sources.find(
      (s) => s.originalName === "above-title.pdf",
    );
    expect(uploaded?.metadata?.title).toBe("System Lifecycle Management");
    expect(uploaded?.metadata?.authors).toEqual(["Martina Keller"]);
  });

  // A real-world case that surfaced live: two authors' name/affiliation
  // blocks can sit side by side at the exact same Y position (a two-column
  // layout) rather than one below the other — a large horizontal gap
  // between consecutive items on the same line is the signature of a
  // column break, not ordinary word spacing.
  test("splits two authors in a side-by-side column layout", async () => {
    const pdfBytes = buildPdfWithMetadata({
      title: "",
      author: "",
      creationDate: "D:20240101120000+00'00'",
      textRuns: [
        { text: "A Two Column Paper", fontSize: 24, y: 700, x: 72 },
        { text: "Anna Cederbladh", fontSize: 10, y: 660, x: 72 },
        { text: "Erik Larsson", fontSize: 10, y: 660, x: 320 },
      ],
    });
    const file = new File([new Uint8Array(pdfBytes)], "two-column.pdf", {
      type: "application/pdf",
    });

    const { manifest } = await uploadAiSources(projectDir, [file]);
    const uploaded = manifest.sources.find(
      (s) => s.originalName === "two-column.pdf",
    );
    expect(uploaded?.metadata?.authors).toEqual([
      "Anna Cederbladh",
      "Erik Larsson",
    ]);
  });

  test("leaves authors undefined when nothing near the title looks like a name list", async () => {
    const pdfBytes = buildPdfWithMetadata({
      title: "",
      author: "",
      creationDate: "D:20240101120000+00'00'",
      textRuns: [
        { text: "A Paper With No Detectable Byline", fontSize: 24, y: 700 },
        {
          text: "Abstract: this paper studies systems engineering.",
          fontSize: 10,
          y: 670,
        },
      ],
    });
    const file = new File([new Uint8Array(pdfBytes)], "no-byline.pdf", {
      type: "application/pdf",
    });

    const { manifest } = await uploadAiSources(projectDir, [file]);
    const uploaded = manifest.sources.find(
      (s) => s.originalName === "no-byline.pdf",
    );
    expect(uploaded?.metadata?.authors).toBeUndefined();
  });
});

describe("CrossRef enrichment at upload time", () => {
  test("upgrades a source to crossref provenance on a confident match", async () => {
    lookupCrossrefMetadataMock.mockResolvedValueOnce({
      title: "A Great Paper Title",
      authors: ["Jane Doe", "John Smith"],
      year: "2020",
      doi: "10.1109/example.2020",
    });

    const pdfBytes = buildPdfWithMetadata({
      title: "",
      author: "",
      creationDate: "D:20240101120000+00'00'",
      textRuns: [{ text: "A Great Paper Title", fontSize: 24, y: 700 }],
    });
    const file = new File([new Uint8Array(pdfBytes)], "verifiable.pdf", {
      type: "application/pdf",
    });

    const { manifest } = await uploadAiSources(projectDir, [file]);
    const uploaded = manifest.sources.find(
      (s) => s.originalName === "verifiable.pdf",
    );
    expect(uploaded?.metadata?.provenance).toBe("crossref");
    expect(uploaded?.metadata?.title).toBe("A Great Paper Title");
    expect(uploaded?.metadata?.authors).toEqual(["Jane Doe", "John Smith"]);
    expect(uploaded?.metadata?.year).toBe("2020");
    expect(uploaded?.metadata?.doi).toBe("10.1109/example.2020");
    expect(uploaded?.metadata?.titleIsHeuristic).toBeFalsy();
    expect(uploaded?.metadata?.authorsAreHeuristic).toBeFalsy();
  });

  test("keeps the local guess when CrossRef finds no confident match", async () => {
    lookupCrossrefMetadataMock.mockResolvedValueOnce(undefined);

    const pdfBytes = buildPdfWithMetadata({
      title: "",
      author: "",
      creationDate: "",
      textRuns: [{ text: "An Unindexed Preprint Title", fontSize: 24, y: 700 }],
    });
    const file = new File([new Uint8Array(pdfBytes)], "unindexed.pdf", {
      type: "application/pdf",
    });

    const { manifest } = await uploadAiSources(projectDir, [file]);
    const uploaded = manifest.sources.find(
      (s) => s.originalName === "unindexed.pdf",
    );
    expect(uploaded?.metadata?.provenance).toBe("heuristic");
    expect(uploaded?.metadata?.title).toBe("An Unindexed Preprint Title");
  });

  test("never calls CrossRef for a non-PDF upload", async () => {
    await uploadAiSources(projectDir, [
      textFile(
        "notes.txt",
        "Notes on quantum entanglement and nonlocal correlations.",
      ),
    ]);
    expect(lookupCrossrefMetadataMock).not.toHaveBeenCalled();
  });

  test("never calls CrossRef when saving an AI-authored research note", async () => {
    await saveResearchNote({
      projectDir,
      title: "My synthesis of the literature",
      content:
        "This is my own synthesized understanding, not a primary source.",
    });
    expect(lookupCrossrefMetadataMock).not.toHaveBeenCalled();
  });
});

describe("updateAiSourceMetadata — the manual-edit gate", () => {
  test("overwrites title/authors/year and marks the source as manually verified", async () => {
    const updated = await updateAiSourceMetadata(projectDir, SOURCE.id, {
      title: "The Real Title",
      authors: ["Ada Lovelace", "Alan Turing"],
      year: "1950",
    });

    expect(updated.metadata).toEqual({
      title: "The Real Title",
      authors: ["Ada Lovelace", "Alan Turing"],
      year: "1950",
      provenance: "manual",
      titleIsHeuristic: false,
      authorsAreHeuristic: false,
    });

    const manifest = await listAiSources(projectDir);
    expect(
      manifest.sources.find((s) => s.id === SOURCE.id)?.metadata?.title,
    ).toBe("The Real Title");
  });

  // A human correcting the title shouldn't need to leave the year field
  // in the edit form empty just because the source never had one — an
  // empty submitted value means "clear this field," not "leave existing
  // data alone" (the edit form always shows/submits all three fields).
  test("clears a field when the submitted value is empty", async () => {
    await updateAiSourceMetadata(projectDir, SOURCE.id, {
      title: "Has A Year",
      authors: [],
      year: "2020",
    });
    const updated = await updateAiSourceMetadata(projectDir, SOURCE.id, {
      title: "Has A Year",
      authors: [],
      year: "",
    });
    expect(updated.metadata?.year).toBeUndefined();
  });

  test("trims whitespace and drops empty entries from the authors list", async () => {
    const updated = await updateAiSourceMetadata(projectDir, SOURCE.id, {
      title: "Title",
      authors: ["  Jane Doe  ", "", "  ", "John Smith"],
      year: "2020",
    });
    expect(updated.metadata?.authors).toEqual(["Jane Doe", "John Smith"]);
  });

  // Overwrites whatever heuristic guess existed before — a manual edit is
  // strictly more trustworthy, so it should clear the stale flags rather
  // than leaving a corrected value still marked "not verified."
  test("clears stale heuristic flags left over from automatic extraction", async () => {
    const pdfBytes = buildPdfWithMetadata({
      title: "",
      author: "",
      creationDate: "",
      textRuns: [{ text: "T", fontSize: 30, y: 700 }],
    });
    const file = new File([new Uint8Array(pdfBytes)], "guessed.pdf", {
      type: "application/pdf",
    });
    const { manifest: uploaded } = await uploadAiSources(projectDir, [file]);
    const source = uploaded.sources.find(
      (s) => s.originalName === "guessed.pdf",
    )!;
    expect(source.metadata?.titleIsHeuristic).toBe(true);

    const corrected = await updateAiSourceMetadata(projectDir, source.id, {
      title: "The Actual Paper Title",
      authors: ["Real Author"],
      year: "2024",
    });
    expect(corrected.metadata?.titleIsHeuristic).toBe(false);
    expect(corrected.metadata?.authorsAreHeuristic).toBe(false);
    expect(corrected.metadata?.provenance).toBe("manual");
  });

  test("throws for an unknown source id", async () => {
    await expect(
      updateAiSourceMetadata(projectDir, "does-not-exist", {
        title: "x",
        authors: [],
        year: "",
      }),
    ).rejects.toThrow("Source not found");
  });
});

describe("deleteAiSources — bulk delete", () => {
  test("removes multiple sources' chunks, embeddings, and manifest entries in one call", async () => {
    await uploadAiSources(projectDir, [
      textFile("alpha.txt", "Alpha paper about quantum entanglement."),
      textFile("beta.txt", "Beta paper about neural network pruning."),
    ]);

    const before = await listAiSources(projectDir);
    const uploaded = before.sources.filter((s) => s.id !== SOURCE.id);
    expect(uploaded).toHaveLength(2);

    const result = await deleteAiSources(
      projectDir,
      uploaded.map((s) => s.id),
    );
    expect(result.sources.map((s) => s.id)).toEqual([SOURCE.id]);
    expect(result.index.chunkCount).toBe(0);
    expect(result.index.embeddingCount).toBe(0);

    const hits = await searchAiKnowledgeBase(
      projectDir,
      "quantum entanglement",
      5,
    );
    expect(hits.every((hit) => hit.chunk.sourceId !== uploaded[0].id)).toBe(
      true,
    );
  });

  test("throws when none of the given ids exist", async () => {
    await expect(deleteAiSources(projectDir, ["nope"])).rejects.toThrow(
      "Source not found",
    );
  });
});

describe("uploadAiSources — duplicate detection", () => {
  test("rejects a byte-identical re-upload of an existing source", async () => {
    const content = "The exact same text, byte for byte.";
    await uploadAiSources(projectDir, [textFile("first.txt", content)]);

    const { manifest, rejected } = await uploadAiSources(projectDir, [
      textFile("first-copy.txt", content),
    ]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain(
      "Identical to an already-uploaded source",
    );
    expect(
      manifest.sources.some((s) => s.originalName === "first-copy.txt"),
    ).toBe(false);
  });

  test("rejects two byte-identical files uploaded in the same batch", async () => {
    const content = "Same bytes, uploaded together.";
    const { rejected, manifest } = await uploadAiSources(projectDir, [
      textFile("a.txt", content),
      textFile("b.txt", content),
    ]);
    expect(rejected).toHaveLength(1);
    expect(
      manifest.sources.filter(
        (s) => s.originalName === "a.txt" || s.originalName === "b.txt",
      ),
    ).toHaveLength(1);
  });

  test("warns but still uploads when a new PDF's title closely matches an existing source", async () => {
    const existingPdf = buildPdfWithMetadata({
      title: "A Study of Model-Based Systems Engineering Adoption",
      author: "Jane Doe",
      creationDate: "D:20200101120000+00'00'",
    });
    await uploadAiSources(projectDir, [
      new File([new Uint8Array(existingPdf)], "existing.pdf", {
        type: "application/pdf",
      }),
    ]);

    // Same words, just the hyphen swapped for a space — a real re-submission
    // of the same paper would very plausibly differ this little.
    const nearDuplicatePdf = buildPdfWithMetadata({
      title: "A Study of Model Based Systems Engineering Adoption",
      author: "Jane Doe",
      creationDate: "D:20200101120000+00'00'",
    });
    const { warnings, manifest } = await uploadAiSources(projectDir, [
      new File([new Uint8Array(nearDuplicatePdf)], "resubmission.pdf", {
        type: "application/pdf",
      }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toContain(
      "A Study of Model-Based Systems Engineering Adoption",
    );
    // A warning is informational, not a rejection — the file is still indexed.
    expect(
      manifest.sources.some((s) => s.originalName === "resubmission.pdf"),
    ).toBe(true);
  });

  test("does not warn when titles are genuinely different", async () => {
    const pdfA = buildPdfWithMetadata({
      title: "Quantum Entanglement in Cold Atom Systems",
      author: "A",
      creationDate: "D:20200101120000+00'00'",
    });
    await uploadAiSources(projectDir, [
      new File([new Uint8Array(pdfA)], "a.pdf", { type: "application/pdf" }),
    ]);

    const pdfB = buildPdfWithMetadata({
      title: "A Recipe for Sourdough Bread",
      author: "B",
      creationDate: "D:20200101120000+00'00'",
    });
    const { warnings } = await uploadAiSources(projectDir, [
      new File([new Uint8Array(pdfB)], "b.pdf", { type: "application/pdf" }),
    ]);
    expect(warnings).toHaveLength(0);
  });
});
