import { describe, expect, test } from "vitest";
import { citeAs, sourceLabel } from "./tools";
import type { AiSourceRecord } from "./types";

function source(
  originalName: string,
  metadata?: Partial<NonNullable<AiSourceRecord["metadata"]>>,
): AiSourceRecord {
  return { id: "src-1", originalName, metadata } as AiSourceRecord;
}

describe("sourceLabel", () => {
  test("surname and year when both are known", () => {
    const paper = source("poulsen.pdf", {
      title: "Digital twins at sea",
      authors: ["Poulsen, Jens"],
      year: "2025",
    });
    expect(sourceLabel(paper, 5)).toBe("Poulsen 2025, S. 5");
    expect(
      sourceLabel(
        source("x.pdf", { authors: ["Jens Poulsen"], year: "2025" }),
        null,
      ),
    ).toBe("Poulsen 2025");
  });

  // Seen in a real library: guessed metadata gave a proposal annex the
  // author "Part A", and every reference read "A 2026".
  test("ignores guessed authors and prefers the file name over a guessed title", () => {
    const annex = source("Annex_1_-_Description_of_the_action__part_A_.pdf", {
      title: "Horizon Europe (HORIZON) Description of the action (DoA)",
      authors: ["Part A"],
      year: "2026",
      titleIsHeuristic: true,
      authorsAreHeuristic: true,
    });
    expect(sourceLabel(annex, 30)).toBe(
      "Annex 1 - Description of the action part A, S. 30",
    );
  });

  test("shortens a long title at a word boundary", () => {
    const book = source("b.pdf", {
      title:
        "Systems Engineering Handbook: A Guide for System Life Cycle Processes and Activities",
    });
    expect(sourceLabel(book, 1)).toBe(
      "Systems Engineering Handbook: A Guide for …, S. 1",
    );
  });
});

describe("citeAs", () => {
  test("links to the source file at the page", () => {
    const paper = source("p.pdf", { authors: ["Poulsen, J."], year: "2025" });
    expect(citeAs(paper, 5)).toBe(
      "[Poulsen 2025, S. 5](/api/ai/sources/src-1/file#page=5)",
    );
  });
});
