import { describe, expect, test } from "vitest";
import { parseUnifiedDiff } from "./diff-format";

describe("parseUnifiedDiff", () => {
  test("returns empty, non-binary for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual({ binary: false, lines: [] });
    expect(parseUnifiedDiff("   \n  ")).toEqual({ binary: false, lines: [] });
  });

  test("detects a binary file marker", () => {
    const raw = "Binary files a/image.png and b/image.png differ";
    expect(parseUnifiedDiff(raw)).toEqual({ binary: true, lines: [] });
  });

  test("tags meta, hunk, add, remove, and context lines", () => {
    const raw = [
      "diff --git a/x.tex b/x.tex",
      "index abc123..def456 100644",
      "--- a/x.tex",
      "+++ b/x.tex",
      "@@ -1,3 +1,3 @@",
      " unchanged line",
      "-old line",
      "+new line",
    ].join("\n");

    const { binary, lines } = parseUnifiedDiff(raw);
    expect(binary).toBe(false);
    expect(lines.map((l) => l.kind)).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "context",
      "remove",
      "add",
    ]);
    expect(lines.find((l) => l.kind === "add")?.text).toBe("+new line");
    expect(lines.find((l) => l.kind === "remove")?.text).toBe("-old line");
  });

  test("drops a trailing blank line without misreading it as content", () => {
    const raw = "@@ -1 +1 @@\n+added\n";
    const { lines } = parseUnifiedDiff(raw);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({ kind: "add", text: "+added" });
  });
});
