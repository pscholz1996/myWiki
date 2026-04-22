import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _setConfigPathForTesting,
  getConfig,
  getRecentProjects,
  readCurrentProject,
  setCurrentProject,
} from "./config";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openlatex-config-"));
  configPath = path.join(tmpDir, "config.json");
  _setConfigPathForTesting(configPath);
  delete process.env.PROJECT_DIR;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _setConfigPathForTesting(null);
});

describe("getConfig", () => {
  test("returns defaults when file is missing", () => {
    expect(getConfig()).toEqual({ currentProject: null, recentProjects: [] });
  });

  test("returns defaults when file is malformed JSON", () => {
    fs.writeFileSync(configPath, "not json");
    expect(getConfig()).toEqual({ currentProject: null, recentProjects: [] });
  });

  test("returns parsed config when file is valid", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        currentProject: "/some/path",
        recentProjects: ["/some/path"],
      }),
    );
    expect(getConfig()).toEqual({
      currentProject: "/some/path",
      recentProjects: ["/some/path"],
    });
  });
});

describe("readCurrentProject", () => {
  test("returns null when no config and no env var", () => {
    expect(readCurrentProject()).toBeNull();
  });

  test("returns currentProject when set and directory exists", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ currentProject: tmpDir, recentProjects: [tmpDir] }),
    );
    expect(readCurrentProject()).toBe(tmpDir);
  });

  test("returns null when currentProject directory does not exist", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        currentProject: path.join(tmpDir, "does-not-exist"),
        recentProjects: [],
      }),
    );
    expect(readCurrentProject()).toBeNull();
  });

  test("bootstraps from PROJECT_DIR env var on first run", () => {
    process.env.PROJECT_DIR = tmpDir;
    expect(readCurrentProject()).toBe(tmpDir);
    const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(saved.currentProject).toBe(tmpDir);
    expect(saved.recentProjects).toEqual([tmpDir]);
  });

  test("ignores PROJECT_DIR env var when config already has a currentProject", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ currentProject: tmpDir, recentProjects: [tmpDir] }),
    );
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "openlatex-other-"));
    try {
      process.env.PROJECT_DIR = other;
      expect(readCurrentProject()).toBe(tmpDir);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test("ignores PROJECT_DIR env var when it points to a non-existent directory", () => {
    process.env.PROJECT_DIR = path.join(tmpDir, "nope");
    expect(readCurrentProject()).toBeNull();
  });
});

describe("setCurrentProject", () => {
  test("writes currentProject and prepends to recentProjects", () => {
    setCurrentProject(tmpDir);
    const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(saved.currentProject).toBe(tmpDir);
    expect(saved.recentProjects).toEqual([tmpDir]);
  });

  test("bumps an existing recent entry to the front", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "b-"));
    try {
      setCurrentProject(a);
      setCurrentProject(b);
      setCurrentProject(a);
      const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(saved.recentProjects).toEqual([a, b]);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  test("caps recentProjects at 10 entries", () => {
    const dirs: string[] = [];
    for (let i = 0; i < 12; i++) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `cap-${i}-`));
      dirs.push(d);
      setCurrentProject(d);
    }
    try {
      const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(saved.recentProjects.length).toBe(10);
      expect(saved.recentProjects[0]).toBe(dirs[11]);
      expect(saved.recentProjects[9]).toBe(dirs[2]);
    } finally {
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test("throws when path does not exist", () => {
    expect(() => setCurrentProject(path.join(tmpDir, "nope"))).toThrow(
      /does not exist/i,
    );
  });

  test("throws when path is a file", () => {
    const file = path.join(tmpDir, "afile.txt");
    fs.writeFileSync(file, "x");
    expect(() => setCurrentProject(file)).toThrow(/not a directory/i);
  });

  test("creates the parent directory if missing", () => {
    _setConfigPathForTesting(path.join(tmpDir, "nested", "dir", "config.json"));
    setCurrentProject(tmpDir);
    expect(
      fs.existsSync(path.join(tmpDir, "nested", "dir", "config.json")),
    ).toBe(true);
  });
});

describe("getRecentProjects", () => {
  test("filters out directories that no longer exist", () => {
    const gone = path.join(tmpDir, "will-be-deleted");
    fs.mkdirSync(gone);
    setCurrentProject(gone);
    setCurrentProject(tmpDir);
    fs.rmdirSync(gone);
    expect(getRecentProjects()).toEqual([tmpDir]);
  });

  test("returns an empty list when no config exists", () => {
    expect(getRecentProjects()).toEqual([]);
  });
});
