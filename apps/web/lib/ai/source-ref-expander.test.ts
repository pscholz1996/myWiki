import { describe, expect, test } from "vitest";
import { createSourceRefExpander } from "./source-ref-expander";

const resolve = (
  handle: string,
  page: number | null,
  pages: string | undefined,
) =>
  handle === "Q1"
    ? `[Annex B${page ? `, S. ${pages ?? page}` : ""}](/api/ai/sources/id-1/file${page ? `#page=${page}` : ""})`
    : undefined;

function run(deltas: string[]): string {
  const expander = createSourceRefExpander(resolve);
  return (
    deltas.map((delta) => expander.push(delta)).join("") + expander.flush()
  );
}

describe("createSourceRefExpander", () => {
  test("turns a short reference into the full link", () => {
    expect(run(["36 Monate [Q1, S. 30]."])).toBe(
      "36 Monate [Annex B, S. 30](/api/ai/sources/id-1/file#page=30).",
    );
  });

  test("accepts the spellings a model actually produces", () => {
    for (const ref of [
      "[Q1, S.30]",
      "[Q1 S. 30]",
      "[q1, p. 30]",
      "[Q1, Seite 30]",
    ]) {
      expect(run([ref])).toBe(
        "[Annex B, S. 30](/api/ai/sources/id-1/file#page=30)",
      );
    }
    expect(run(["[Q1]"])).toBe("[Annex B](/api/ai/sources/id-1/file)");
  });

  // Seen live: "[Q2, S. 13, 14]" was left as plain text.
  test("links several pages to the first and names them all", () => {
    expect(run(["[Q1, S. 13, 14]"])).toBe(
      "[Annex B, S. 13, 14](/api/ai/sources/id-1/file#page=13)",
    );
    expect(run(["[Q1, S. 30–31]"])).toBe(
      "[Annex B, S. 30–31](/api/ai/sources/id-1/file#page=30)",
    );
    expect(run(["[Q1, Seiten 3 und 7]"])).toBe(
      "[Annex B, S. 3 und 7](/api/ai/sources/id-1/file#page=3)",
    );
  });

  test("handles a reference split across deltas", () => {
    expect(run(["Laufzeit [", "Q1, S", ". 30", "] ok"])).toBe(
      "Laufzeit [Annex B, S. 30](/api/ai/sources/id-1/file#page=30) ok",
    );
  });

  test("leaves unknown handles, markdown links and other brackets alone", () => {
    expect(run(["[Q9, S. 1] und [Q1, S. 2](/x) und [Anmerkung]"])).toBe(
      "[Q9, S. 1] und [Q1, S. 2](/x) und [Anmerkung]",
    );
  });

  // The "(" that makes it a link may arrive in the next delta.
  test("waits for the next delta before deciding it isn't link text", () => {
    expect(run(["siehe [Q1, S. 2]", "(/x)"])).toBe("siehe [Q1, S. 2](/x)");
  });

  // A markdown link's text can be long; it must flow on, not stall.
  test("lets long bracketed text through", () => {
    const text = `[${"lang ".repeat(12)}`;
    expect(run([text, " weiter"])).toBe(`${text} weiter`);
  });
});
