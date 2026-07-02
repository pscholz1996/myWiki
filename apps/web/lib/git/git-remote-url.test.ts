import { describe, expect, test } from "vitest";
import { remoteToHttpsUrl } from "./git-remote-url";

describe("remoteToHttpsUrl", () => {
  test("converts an SSH remote", () => {
    expect(remoteToHttpsUrl("git@github.com:owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
  });

  test("converts an SSH remote without .git suffix", () => {
    expect(remoteToHttpsUrl("git@github.com:owner/repo")).toBe(
      "https://github.com/owner/repo",
    );
  });

  test("normalizes an HTTPS remote with .git suffix", () => {
    expect(remoteToHttpsUrl("https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
  });

  test("passes through an HTTPS remote without .git suffix", () => {
    expect(remoteToHttpsUrl("https://github.com/owner/repo")).toBe(
      "https://github.com/owner/repo",
    );
  });

  test("returns null for a non-GitHub remote", () => {
    expect(remoteToHttpsUrl("git@gitlab.com:owner/repo.git")).toBeNull();
    expect(remoteToHttpsUrl("https://gitlab.com/owner/repo.git")).toBeNull();
  });

  test("returns null for a null remote", () => {
    expect(remoteToHttpsUrl(null)).toBeNull();
  });
});
