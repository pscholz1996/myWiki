import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditProjectCitations } from "./citation-audit";
import type { AiManifest, AiSourceRecord } from "./types";

let projectDir: string;

function writeManifest(sources: AiSourceRecord[]) {
  const manifest: AiManifest = {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    embeddingModel: "test",
    embeddingDimensions: null,
    sources,
    index: { chunkCount: 0, embeddingCount: 0, generatedAt: null },
  };
  fs.writeFileSync(
    path.join(projectDir, ".openlatex", "ai", "manifest.json"),
    JSON.stringify(manifest),
  );
}

function source(overrides: Partial<AiSourceRecord> & { id: string }): AiSourceRecord {
  return {
    originalName: `${overrides.id}.pdf`,
    storedName: `${overrides.id}.pdf`,
    relativePath: `.openlatex/ai/sources/${overrides.id}.pdf`,
    kind: "pdf",
    bytes: 0,
    ingestedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "openlatex-audit-"));
  fs.mkdirSync(path.join(projectDir, ".openlatex", "ai"), { recursive: true });
  writeManifest([]);
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("auditProjectCitations", () => {
  test("returns an empty list when there are no .tex files", async () => {
    expect(await auditProjectCitations(projectDir)).toEqual([]);
  });

  test("flags a key with no matching .bib entry", async () => {
    fs.writeFileSync(
      path.join(projectDir, "main.tex"),
      "See \\cite{ghost2020} for details.",
    );
    fs.writeFileSync(path.join(projectDir, "refs.bib"), "");

    const [result] = await auditProjectCitations(projectDir);
    expect(result.key).toBe("ghost2020");
    expect(result.status).toBe("missing-bib-entry");
  });

  test("marks a citation ok when the key resolves to a real source at a valid page", async () => {
    fs.writeFileSync(
      path.join(projectDir, "main.tex"),
      "As shown \\cite[p.~5]{smith2020}, this holds.",
    );
    fs.writeFileSync(
      path.join(projectDir, "refs.bib"),
      "@article{smith2020,\n  title = {Example},\n}\n",
    );
    writeManifest([source({ id: "src-1", bibKey: "smith2020", pageCount: 10 })]);

    const [result] = await auditProjectCitations(projectDir);
    expect(result).toMatchObject({ key: "smith2020", page: 5, status: "ok" });
  });

  test("flags a cited page beyond the source's actual page count", async () => {
    fs.writeFileSync(
      path.join(projectDir, "main.tex"),
      "\\cite[p.~99]{smith2020}",
    );
    fs.writeFileSync(path.join(projectDir, "refs.bib"), "@article{smith2020,\n}\n");
    writeManifest([source({ id: "src-1", bibKey: "smith2020", pageCount: 10 })]);

    const [result] = await auditProjectCitations(projectDir);
    expect(result.status).toBe("page-out-of-range");
    expect(result.detail).toContain("only has 10 pages");
  });

  test("flags a .bib entry with no linked knowledge-base source, without asserting deletion", async () => {
    fs.writeFileSync(path.join(projectDir, "main.tex"), "\\cite{orphan2019}");
    fs.writeFileSync(path.join(projectDir, "refs.bib"), "@misc{orphan2019,\n}\n");
    // No sources at all in the manifest.

    const [result] = await auditProjectCitations(projectDir);
    expect(result.status).toBe("unlinked-source");
    expect(result.detail).not.toMatch(/was deleted/i);
  });

  test("flags a citation with no page as informational, not an error", async () => {
    fs.writeFileSync(path.join(projectDir, "main.tex"), "\\cite{smith2020}");
    fs.writeFileSync(path.join(projectDir, "refs.bib"), "@article{smith2020,\n}\n");
    writeManifest([source({ id: "src-1", bibKey: "smith2020", pageCount: 10 })]);

    const [result] = await auditProjectCitations(projectDir);
    expect(result.status).toBe("no-page-cited");
    expect(result.page).toBeNull();
  });

  test("expands a multi-key \\cite{a,b} into one occurrence per key", async () => {
    fs.writeFileSync(
      path.join(projectDir, "main.tex"),
      "\\cite{smith2020,jones2021}",
    );
    fs.writeFileSync(
      path.join(projectDir, "refs.bib"),
      "@article{smith2020,\n}\n@article{jones2021,\n}\n",
    );
    writeManifest([
      source({ id: "src-1", bibKey: "smith2020" }),
      source({ id: "src-2", bibKey: "jones2021" }),
    ]);

    const results = await auditProjectCitations(projectDir);
    expect(results.map((r) => r.key).sort()).toEqual(["jones2021", "smith2020"]);
  });

  test("recognizes natbib/biblatex citation commands beyond plain \\cite", async () => {
    fs.writeFileSync(
      path.join(projectDir, "main.tex"),
      "\\citep{a2020} and \\parencite[p.~2]{b2021} and \\textcite{c2022}.",
    );
    fs.writeFileSync(
      path.join(projectDir, "refs.bib"),
      "@article{a2020,\n}\n@article{b2021,\n}\n@article{c2022,\n}\n",
    );
    writeManifest([
      source({ id: "1", bibKey: "a2020" }),
      source({ id: "2", bibKey: "b2021", pageCount: 5 }),
      source({ id: "3", bibKey: "c2022" }),
    ]);

    const results = await auditProjectCitations(projectDir);
    expect(results).toHaveLength(3);
    const byKey = new Map(results.map((r) => [r.key, r]));
    expect(byKey.get("b2021")?.page).toBe(2);
  });

  test("scans every .tex file in the project, not just main.tex", async () => {
    fs.mkdirSync(path.join(projectDir, "chapters"));
    fs.writeFileSync(path.join(projectDir, "main.tex"), "\\cite{a2020}");
    fs.writeFileSync(
      path.join(projectDir, "chapters", "intro.tex"),
      "\\cite{ghost2020}",
    );
    fs.writeFileSync(path.join(projectDir, "refs.bib"), "@article{a2020,\n}\n");
    writeManifest([source({ id: "1", bibKey: "a2020" })]);

    const results = await auditProjectCitations(projectDir);
    const files = results.map((r) => r.file).sort();
    expect(files).toEqual(["chapters/intro.tex", "main.tex"]);
  });
});
