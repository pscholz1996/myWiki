import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setConfigPathForTesting, setCurrentProject } from "./config";
import {
  countKbSources,
  getKbInfo,
  listKnownKbs,
  readKbName,
  resolveKbRef,
  writeKbName,
} from "./kb-registry";

let tmpDir: string;

function makeKbDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(dir: string, sourceCount: number): void {
  const aiDir = path.join(dir, ".mywiki", "ai");
  fs.mkdirSync(aiDir, { recursive: true });
  const sources = Array.from({ length: sourceCount }, (_, i) => ({
    id: `s${i}`,
  }));
  fs.writeFileSync(
    path.join(aiDir, "manifest.json"),
    JSON.stringify({ version: 1, sources }),
    "utf8",
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mywiki-kb-registry-"));
  _setConfigPathForTesting(path.join(tmpDir, "config.json"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _setConfigPathForTesting(null);
});

describe("readKbName / writeKbName", () => {
  test("returns null when project.json is missing", () => {
    const dir = makeKbDir("plain");
    expect(readKbName(dir)).toBeNull();
  });

  test("round-trips a name", () => {
    const dir = makeKbDir("named");
    writeKbName(dir, "MBSE-Bibliothek");
    expect(readKbName(dir)).toBe("MBSE-Bibliothek");
  });

  test("trims and rejects empty names", () => {
    const dir = makeKbDir("empty-name");
    writeKbName(dir, "  Papers  ");
    expect(readKbName(dir)).toBe("Papers");
    expect(() => writeKbName(dir, "   ")).toThrow();
  });

  test("preserves unknown fields in project.json", () => {
    const dir = makeKbDir("extra-fields");
    const file = path.join(dir, ".mywiki", "project.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name: "Old", custom: 42 }), "utf8");
    writeKbName(dir, "New");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed).toEqual({ name: "New", custom: 42 });
  });
});

describe("countKbSources", () => {
  test("returns 0 without a manifest", () => {
    expect(countKbSources(makeKbDir("no-manifest"))).toBe(0);
  });

  test("counts manifest sources", () => {
    const dir = makeKbDir("with-sources");
    writeManifest(dir, 3);
    expect(countKbSources(dir)).toBe(3);
  });
});

describe("getKbInfo", () => {
  test("falls back to the folder basename", () => {
    const dir = makeKbDir("fallback-name");
    expect(getKbInfo(dir)).toEqual({
      path: dir,
      name: "fallback-name",
      sourceCount: 0,
    });
  });
});

describe("listKnownKbs", () => {
  test("lists recents with sourced KBs first", () => {
    const empty = makeKbDir("aaa-empty");
    const sourced = makeKbDir("zzz-sourced");
    writeManifest(sourced, 2);
    setCurrentProject(empty);
    setCurrentProject(sourced);
    setCurrentProject(empty);

    const names = listKnownKbs().map((kb) => kb.name);
    expect(names).toEqual(["zzz-sourced", "aaa-empty"]);
  });
});

describe("resolveKbRef", () => {
  test("resolves an absolute directory path", () => {
    const dir = makeKbDir("by-path");
    expect(resolveKbRef(dir)).toBe(path.resolve(dir));
  });

  test("rejects an absolute path that is not a directory", () => {
    expect(resolveKbRef(path.join(tmpDir, "does-not-exist"))).toBeNull();
  });

  test("resolves a registered name case-insensitively", () => {
    const dir = makeKbDir("named-kb");
    writeKbName(dir, "MBSE");
    setCurrentProject(dir);
    expect(resolveKbRef("mbse")).toBe(dir);
  });

  test("returns null for unknown names", () => {
    expect(resolveKbRef("nope")).toBeNull();
  });
});
