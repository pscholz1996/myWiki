import { afterEach, describe, expect, test, vi } from "vitest";
import { extractDoi, lookupCrossrefMetadata, titleSimilarity } from "./crossref";

describe("extractDoi", () => {
  test("extracts from an Elsevier-style doi: title", () => {
    expect(extractDoi("doi:10.1016/j.trb.2003.07.001")).toBe(
      "10.1016/j.trb.2003.07.001",
    );
  });

  test("extracts from a doi.org URL", () => {
    expect(extractDoi("https://doi.org/10.1109/TSE.2019.2921345")).toBe(
      "10.1109/TSE.2019.2921345",
    );
  });

  test("strips trailing punctuation", () => {
    expect(extractDoi("See 10.1000/xyz123.")).toBe("10.1000/xyz123");
  });

  test("returns undefined for a normal title", () => {
    expect(
      extractDoi("A new regret insertion heuristic for dial-a-ride problems"),
    ).toBeUndefined();
  });
});

describe("titleSimilarity", () => {
  test("is 1 for identical titles", () => {
    expect(titleSimilarity("Model-Based Systems Engineering", "Model-Based Systems Engineering")).toBe(1);
  });

  test("is insensitive to case and punctuation", () => {
    expect(titleSimilarity("Model-Based Systems Engineering", "model based systems engineering!")).toBe(1);
  });

  test("is 0 for completely unrelated titles", () => {
    expect(titleSimilarity("Quantum Entanglement in Cold Atoms", "A Recipe for Sourdough Bread")).toBe(0);
  });

  test("is partial for titles that share some but not all words", () => {
    const score = titleSimilarity(
      "The Use of Models in Systems Engineering",
      "The Use of Models in Software Engineering",
    );
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  test("is 0 when either title is empty", () => {
    expect(titleSimilarity("", "Something")).toBe(0);
    expect(titleSimilarity("Something", "")).toBe(0);
  });
});

function mockCrossrefResponse(items: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ message: { items } }),
    })),
  );
}

describe("lookupCrossrefMetadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("returns undefined without calling fetch for a blank title", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await lookupCrossrefMetadata("   ");
    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns real bibliographic data for a confident match", async () => {
    mockCrossrefResponse([
      {
        title: ["Model-Based Systems Engineering Uptake"],
        author: [
          { given: "James", family: "Cameron" },
          { given: "Jane", family: "Doe" },
        ],
        published: { "date-parts": [[2020, 3]] },
        DOI: "10.1109/example.2020",
      },
    ]);

    const result = await lookupCrossrefMetadata("Model-Based Systems Engineering Uptake");
    expect(result).toEqual({
      title: "Model-Based Systems Engineering Uptake",
      authors: ["James Cameron", "Jane Doe"],
      year: "2020",
      doi: "10.1109/example.2020",
    });
  });

  test("rejects a low-similarity best candidate rather than guessing", async () => {
    mockCrossrefResponse([
      {
        title: ["A Completely Different Paper About Sourdough Bread"],
        author: [{ given: "Someone", family: "Else" }],
        published: { "date-parts": [[2019]] },
        DOI: "10.1234/unrelated",
      },
    ]);

    const result = await lookupCrossrefMetadata("Model-Based Systems Engineering Uptake");
    expect(result).toBeUndefined();
  });

  test("scores every returned candidate, not just the first", async () => {
    mockCrossrefResponse([
      { title: ["Totally Unrelated Result"], author: [] },
      {
        title: ["Model-Based Systems Engineering Uptake"],
        author: [{ given: "James", family: "Cameron" }],
        issued: { "date-parts": [[2020]] },
        DOI: "10.1109/example.2020",
      },
    ]);

    const result = await lookupCrossrefMetadata("Model-Based Systems Engineering Uptake");
    expect(result?.title).toBe("Model-Based Systems Engineering Uptake");
  });

  test("returns undefined on a network failure instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const result = await lookupCrossrefMetadata("Some Real Paper Title");
    expect(result).toBeUndefined();
  });

  test("returns undefined on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    const result = await lookupCrossrefMetadata("Some Real Paper Title");
    expect(result).toBeUndefined();
  });

  test("returns undefined when the response has no items", async () => {
    mockCrossrefResponse([]);
    const result = await lookupCrossrefMetadata("Some Real Paper Title");
    expect(result).toBeUndefined();
  });
});
