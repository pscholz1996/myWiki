import fs from "node:fs";
import path from "node:path";
import { getRecentProjects } from "@/lib/project/config";
import { basename } from "@/lib/project/path-utils";

/**
 * A knowledge base this machine knows about: any folder from the
 * recent-projects list, enriched with a display name (from
 * `.mywiki/project.json`, falling back to the folder name) and the number
 * of indexed sources (from the AI manifest). All reads here are
 * side-effect-free on purpose — listing must never create `.mywiki/`
 * scaffolding inside folders the user merely opened once.
 */
export interface KnownKb {
  path: string;
  name: string;
  sourceCount: number;
}

function projectFile(dir: string): string {
  return path.join(dir, ".mywiki", "project.json");
}

export function readKbName(dir: string): string | null {
  try {
    const raw = fs.readFileSync(projectFile(dir), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name.trim()
      : null;
  } catch {
    return null;
  }
}

export function writeKbName(dir: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Knowledge base name is empty.");
  const file = projectFile(dir);
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed project.json — start fresh.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...existing, name: trimmed }, null, 2)}\n`,
    "utf8",
  );
}

export function countKbSources(dir: string): number {
  try {
    const raw = fs.readFileSync(
      path.join(dir, ".mywiki", "ai", "manifest.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { sources?: unknown };
    return Array.isArray(parsed.sources) ? parsed.sources.length : 0;
  } catch {
    return 0;
  }
}

export function getKbInfo(dir: string): KnownKb {
  return {
    path: dir,
    name: readKbName(dir) ?? basename(dir),
    sourceCount: countKbSources(dir),
  };
}

/**
 * All known knowledge bases, real libraries first: folders that already
 * hold indexed sources sort above ones that were merely opened, so the
 * pickers surface actual KBs instead of one-off browses.
 */
export function listKnownKbs(): KnownKb[] {
  return getRecentProjects()
    .map(getKbInfo)
    .sort((a, b) => {
      const aHas = a.sourceCount > 0;
      const bHas = b.sourceCount > 0;
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Resolves an external reference — an absolute path or a registered KB
 * name (case-insensitive) — to a project directory, without touching the
 * globally-selected project. Returns null if nothing matches.
 */
export function resolveKbRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;

  if (path.isAbsolute(trimmed)) {
    try {
      if (fs.statSync(trimmed).isDirectory()) return path.resolve(trimmed);
    } catch {
      // fall through to null
    }
    return null;
  }

  const lower = trimmed.toLowerCase();
  const match = listKnownKbs().find((kb) => kb.name.toLowerCase() === lower);
  return match ? match.path : null;
}
