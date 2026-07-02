export type DiffLineKind = "add" | "remove" | "context" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface ParsedDiff {
  binary: boolean;
  lines: DiffLine[];
}

const BINARY_MARKER = /^Binary files .* differ$/m;

/**
 * Parses `git show <hash> -- <path>` output into typed lines for a hand-
 * rolled diff view — no diff-rendering dependency, matching this codebase's
 * existing minimal-dependency style. Deliberately not a general-purpose
 * unified-diff parser (no multi-file support): each call is scoped to one
 * file already, via the `-- <path>` git invocation.
 */
export function parseUnifiedDiff(raw: string): ParsedDiff {
  if (!raw.trim()) {
    return { binary: false, lines: [] };
  }

  if (BINARY_MARKER.test(raw)) {
    return { binary: true, lines: [] };
  }

  const lines: DiffLine[] = [];
  for (const rawLine of raw.split("\n")) {
    if (rawLine === "") continue;

    if (rawLine.startsWith("@@")) {
      lines.push({ kind: "hunk", text: rawLine });
    } else if (
      rawLine.startsWith("diff --git") ||
      rawLine.startsWith("index ") ||
      rawLine.startsWith("--- ") ||
      rawLine.startsWith("+++ ")
    ) {
      lines.push({ kind: "meta", text: rawLine });
    } else if (rawLine.startsWith("+")) {
      lines.push({ kind: "add", text: rawLine });
    } else if (rawLine.startsWith("-")) {
      lines.push({ kind: "remove", text: rawLine });
    } else {
      lines.push({ kind: "context", text: rawLine });
    }
  }

  return { binary: false, lines };
}
