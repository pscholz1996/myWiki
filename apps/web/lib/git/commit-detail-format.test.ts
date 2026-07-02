import { describe, expect, test } from "vitest";
import { parseNameStatus } from "./commit-detail-format";

describe("parseNameStatus", () => {
  test("returns an empty array for empty input", () => {
    expect(parseNameStatus("")).toEqual([]);
    expect(parseNameStatus("\n\n")).toEqual([]);
  });

  test("parses added, modified, and deleted files", () => {
    const raw = ["A\tnew.tex", "M\tchanged.tex", "D\tremoved.tex"].join("\n");
    expect(parseNameStatus(raw)).toEqual([
      { path: "new.tex", status: "staged" },
      { path: "changed.tex", status: "modified" },
      { path: "removed.tex", status: "deleted" },
    ]);
  });

  test("parses a rename with a similarity score", () => {
    const raw = "R100\told.tex\tnew.tex";
    expect(parseNameStatus(raw)).toEqual([
      { path: "new.tex", oldPath: "old.tex", status: "renamed" },
    ]);
  });

  test("parses a copy the same way as a rename", () => {
    const raw = "C75\tsource.tex\tcopy.tex";
    expect(parseNameStatus(raw)).toEqual([
      { path: "copy.tex", oldPath: "source.tex", status: "renamed" },
    ]);
  });

  test("skips blank lines", () => {
    const raw = "A\tnew.tex\n\nM\tchanged.tex";
    expect(parseNameStatus(raw)).toHaveLength(2);
  });
});
