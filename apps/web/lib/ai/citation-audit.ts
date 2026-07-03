// Re-checks every \cite{...} already sitting in the project's .tex files —
// the anti-hallucination guarantee elsewhere in this codebase (cite(),
// verifyAiCitation) only ever runs at the moment a citation is inserted.
// Nothing re-checks it afterward: a source can be deleted, or a citation
// can reference a page that never existed, and the .tex text would keep
// silently claiming it's backed by evidence. This is a structural check —
// does the key resolve to a real .bib entry, linked to a real knowledge-
// base source, at a page that source actually has — not a re-verification
// of the exact sentence/quote that was originally checked (that quote was
// never persisted anywhere durable; only the chat citation chip had it).

import fs from "node:fs/promises";
import { listProjectTree, type FsNode } from "@/lib/fs/list";
import { resolveInProject } from "@/lib/fs/sandbox";
import { listAiSources } from "@/lib/ai/knowledge-base";
import type { AuditedCitation } from "@/lib/ai/types";

function flattenTree(nodes: FsNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      paths.push(node.path);
    } else if (node.children) {
      paths.push(...flattenTree(node.children));
    }
  }
  return paths;
}

// Matches \cite / \citep / \citet / \parencite / \autocite / \textcite,
// each optionally followed by one or two bracketed notes (biblatex's
// \cite[pre][post]{key} form, or plain LaTeX/natbib's single \cite[post]{key}
// — both are common depending on which package the project uses), then the
// required brace group of one or more comma-separated keys.
const CITE_PATTERN =
  /\\(?:cite|citep|citet|parencite|autocite|textcite)(?:\[([^\]]*)\])?(?:\[([^\]]*)\])?\{([^}]+)\}/g;

// "p. 12", "p.~12", "pp. 12-14", "page 12" — takes the first number found,
// which is what every page-bearing citation this system itself generates
// (\cite[p.~<page>]{key}) and the common manual conventions both produce.
const PAGE_NOTE_PATTERN = /\bpp?\.?\s*~?\s*(\d+)|\bpage\s*(\d+)/i;

function extractPage(notes: (string | undefined)[]): number | null {
  // The last present bracket is the "postnote" in both the single- and
  // dual-bracket forms — that's where a page reference conventionally goes.
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const note = notes[i];
    if (!note) continue;
    const match = note.match(PAGE_NOTE_PATTERN);
    const raw = match?.[1] ?? match?.[2];
    if (raw) return Number(raw);
  }
  return null;
}

interface CitationOccurrence {
  file: string;
  key: string;
  page: number | null;
}

function findCitationsInText(file: string, text: string): CitationOccurrence[] {
  const occurrences: CitationOccurrence[] = [];
  for (const match of text.matchAll(CITE_PATTERN)) {
    const page = extractPage([match[1], match[2]]);
    const keys = match[3]
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    for (const key of keys) {
      occurrences.push({ file, key, page });
    }
  }
  return occurrences;
}

// A .bib entry is "@type{key," at the start of an entry — this only needs
// to know which keys exist, not parse fields, so a single regex pass (same
// approach as agent.ts's bibtexHasKey) is enough.
function extractBibKeys(bibContent: string): Set<string> {
  const keys = new Set<string>();
  for (const match of bibContent.matchAll(/@[A-Za-z]+\s*\{\s*([A-Za-z0-9:_-]+)\s*,/g)) {
    keys.add(match[1]);
  }
  return keys;
}

export async function auditProjectCitations(
  projectDir: string,
): Promise<AuditedCitation[]> {
  const tree = await listProjectTree(projectDir);
  const allFiles = flattenTree(tree);
  const texFiles = allFiles.filter((p) => p.toLowerCase().endsWith(".tex"));
  const bibFiles = allFiles.filter((p) => p.toLowerCase().endsWith(".bib"));

  const occurrences: CitationOccurrence[] = [];
  for (const file of texFiles) {
    const content = await fs.readFile(resolveInProject(projectDir, file), "utf8");
    occurrences.push(...findCitationsInText(file, content));
  }

  const knownKeys = new Set<string>();
  for (const file of bibFiles) {
    const content = await fs.readFile(resolveInProject(projectDir, file), "utf8");
    for (const key of extractBibKeys(content)) knownKeys.add(key);
  }

  const manifest = await listAiSources(projectDir);
  const sourceByBibKey = new Map(
    manifest.sources.filter((source) => source.bibKey).map((source) => [source.bibKey!, source]),
  );

  return occurrences.map((occurrence): AuditedCitation => {
    if (!knownKeys.has(occurrence.key)) {
      return {
        ...occurrence,
        status: "missing-bib-entry",
        detail: `No BibTeX entry for "${occurrence.key}" — this citation will not compile.`,
      };
    }

    const source = sourceByBibKey.get(occurrence.key);
    if (!source) {
      return {
        ...occurrence,
        status: "unlinked-source",
        detail:
          "No knowledge-base source currently links to this key — either it was never sourced from the knowledge base, or its source was later deleted. The BibTeX entry itself is still fine.",
      };
    }

    if (occurrence.page !== null) {
      const pageCount = source.pageCount;
      if (typeof pageCount === "number" && (occurrence.page < 1 || occurrence.page > pageCount)) {
        return {
          ...occurrence,
          status: "page-out-of-range",
          detail: `Page ${occurrence.page} cited, but "${source.originalName}" only has ${pageCount} pages.`,
        };
      }
      return { ...occurrence, status: "ok", detail: "Resolves to a real source and page." };
    }

    return {
      ...occurrence,
      status: "no-page-cited",
      detail: `Resolves to "${source.originalName}" but cites no specific page.`,
    };
  });
}
