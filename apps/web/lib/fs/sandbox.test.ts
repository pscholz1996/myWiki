import { describe, expect, test } from "vitest";
import { resolveInProject } from "./sandbox";

const ROOT = "/home/user/project";

describe("resolveInProject", () => {
  test("accepts a simple relative filename", () => {
    expect(resolveInProject(ROOT, "main.tex")).toBe(
      "/home/user/project/main.tex",
    );
  });

  test("accepts a nested relative path", () => {
    expect(resolveInProject(ROOT, "chapters/intro.tex")).toBe(
      "/home/user/project/chapters/intro.tex",
    );
  });

  test("normalizes backslashes to forward slashes", () => {
    expect(resolveInProject(ROOT, "chapters\\intro.tex")).toBe(
      "/home/user/project/chapters/intro.tex",
    );
  });

  test("accepts explicit ./ prefix", () => {
    expect(resolveInProject(ROOT, "./main.tex")).toBe(
      "/home/user/project/main.tex",
    );
  });

  test("collapses legitimate internal traversal that stays in root", () => {
    expect(resolveInProject(ROOT, "chapters/../main.tex")).toBe(
      "/home/user/project/main.tex",
    );
  });

  test("rejects traversal escaping root", () => {
    expect(() => resolveInProject(ROOT, "../etc/passwd")).toThrow(
      /outside project/i,
    );
  });

  test("rejects absolute POSIX path", () => {
    expect(() => resolveInProject(ROOT, "/etc/passwd")).toThrow(/absolute/i);
  });

  test("rejects absolute Windows-style path", () => {
    expect(() => resolveInProject(ROOT, "C:/Windows/System32")).toThrow(
      /absolute/i,
    );
  });

  test("rejects empty path", () => {
    expect(() => resolveInProject(ROOT, "")).toThrow(/empty/i);
  });

  test("rejects whitespace-only path", () => {
    expect(() => resolveInProject(ROOT, "   ")).toThrow(/empty/i);
  });

  test("rejects a path containing null byte", () => {
    expect(() => resolveInProject(ROOT, "main.tex\u0000")).toThrow(/invalid/i);
  });

  test("returns root itself for empty-after-trim relative resolution of '.'", () => {
    expect(resolveInProject(ROOT, ".")).toBe("/home/user/project");
  });
});
