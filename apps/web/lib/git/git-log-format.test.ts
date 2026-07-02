import { describe, expect, test } from "vitest";
import { parseGitLog } from "./git-log-format";

const SEP = "\x1f";

function line(
  hash: string,
  message: string,
  author = "Jane Doe",
  email = "jane@example.com",
  date = "2026-01-01T00:00:00+00:00",
): string {
  return [hash, hash.slice(0, 8), message, author, email, date].join(SEP);
}

describe("parseGitLog", () => {
  test("returns an empty array for empty input", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog("   \n  ")).toEqual([]);
  });

  test("parses a single commit", () => {
    const raw = line("abc123def456", "Fix the thing");
    expect(parseGitLog(raw)).toEqual([
      {
        hash: "abc123def456",
        shortHash: "abc123de",
        message: "Fix the thing",
        author: "Jane Doe",
        authorEmail: "jane@example.com",
        date: "2026-01-01T00:00:00+00:00",
      },
    ]);
  });

  test("parses multiple commits in order", () => {
    const raw = [
      line("hash1", "First commit"),
      line("hash2", "Second commit"),
    ].join("\n");
    const result = parseGitLog(raw);
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe("First commit");
    expect(result[1].message).toBe("Second commit");
  });

  test("handles a subject containing a literal pipe", () => {
    const raw = line("hash1", "Fix a||b handling");
    expect(parseGitLog(raw)[0].message).toBe("Fix a||b handling");
  });

  test("skips a blank line between records", () => {
    const raw = [line("hash1", "First"), "", line("hash2", "Second")].join(
      "\n",
    );
    const result = parseGitLog(raw);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.message)).toEqual(["First", "Second"]);
  });
});
