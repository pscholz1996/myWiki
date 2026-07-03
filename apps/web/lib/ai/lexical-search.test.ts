import { describe, expect, test } from "vitest";
import {
  buildBm25Index,
  reciprocalRankFusion,
  scoreBm25,
  tokenize,
} from "./lexical-search";

describe("tokenize", () => {
  test("lowercases, strips punctuation, and drops stopwords/single letters", () => {
    expect(tokenize("The MBSE Approach, 2023!")).toEqual([
      "mbse",
      "approach",
      "2023",
    ]);
  });

  test("returns an empty array for stopword-only or empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("the a is of")).toEqual([]);
  });
});

describe("buildBm25Index / scoreBm25", () => {
  const documents = [
    { id: "doc1", text: "the cat sat on the mat" }, // tokens: cat, sat, mat
    { id: "doc2", text: "the dog sat on the log" }, // tokens: dog, sat, log
  ];

  test("scores a term that appears in only one document, matching hand-computed BM25", () => {
    const index = buildBm25Index(documents);
    const scores = scoreBm25(index, tokenize("cat"));

    // docFreq(cat)=1, N=2 -> idf = ln(1 + (2-1+0.5)/(1+0.5)) = ln(2)
    // termFreq=1, docLength=3=avgDocLength -> lengthNorm=1, termScore=(1*2.2)/(1+1.2)=1
    // score = idf * termScore = ln(2)
    expect(scores.size).toBe(1);
    expect(scores.get("doc1")).toBeCloseTo(Math.log(2), 5);
    expect(scores.has("doc2")).toBe(false);
  });

  test("a term shared by every document still contributes a small positive score", () => {
    const index = buildBm25Index(documents);
    const scores = scoreBm25(index, tokenize("sat"));

    expect(scores.get("doc1")).toBeGreaterThan(0);
    expect(scores.get("doc2")).toBeGreaterThan(0);
  });

  test("returns an empty map for an empty index or an empty query", () => {
    const index = buildBm25Index(documents);
    expect(scoreBm25(index, [])).toEqual(new Map());
    expect(scoreBm25(buildBm25Index([]), tokenize("cat"))).toEqual(new Map());
  });
});

describe("reciprocalRankFusion", () => {
  test("fuses two ranked lists by rank position, matching a hand-computed example", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "a", "d"],
    ]);

    // a: rank 0 in list1 (1/61) + rank 1 in list2 (1/62)
    // b: rank 1 in list1 (1/62) + rank 0 in list2 (1/61)  -> ties with a
    // c: rank 2 in list1 only (1/63)
    // d: rank 2 in list2 only (1/63) -> ties with c
    const expectedTop = 1 / 61 + 1 / 62;
    const expectedBottom = 1 / 63;

    expect(fused.get("a")).toBeCloseTo(expectedTop, 10);
    expect(fused.get("b")).toBeCloseTo(expectedTop, 10);
    expect(fused.get("c")).toBeCloseTo(expectedBottom, 10);
    expect(fused.get("d")).toBeCloseTo(expectedBottom, 10);
    expect(fused.get("a")).toBeGreaterThan(fused.get("c") ?? 0);
  });

  test("an id appearing in every list outranks one appearing in only one", () => {
    const fused = reciprocalRankFusion([
      ["x", "y"],
      ["y", "x"],
      ["y", "x"],
    ]);
    expect(fused.get("y")).toBeGreaterThan(fused.get("x") ?? 0);
  });
});
