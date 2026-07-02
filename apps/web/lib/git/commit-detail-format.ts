import type { GitFileStatus } from "@/app/api/git/status/route";

export interface GitCommitFileEntry {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
}

/**
 * Parses `git show --name-status` output (the part after the commit
 * header): lines are `<code>\t<path>` or `R<score>\t<old>\t<new>` for
 * renames. Reuses the GitFileStatus vocabulary (and its statusLabel/
 * statusColor helpers) from the working-tree status view — a single
 * commit's own change list doesn't have a staged/unstaged distinction, so
 * only a subset of that union is ever produced here.
 */
export function parseNameStatus(output: string): GitCommitFileEntry[] {
  const entries: GitCommitFileEntry[] = [];

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0];
    if (!code) continue;

    if (code.startsWith("R") || code.startsWith("C")) {
      const [, oldPath, newPath] = parts;
      if (newPath) {
        entries.push({ path: newPath, oldPath, status: "renamed" });
      }
      continue;
    }

    const path = parts[1];
    if (!path) continue;

    let status: GitFileStatus;
    switch (code[0]) {
      case "A":
        status = "staged";
        break;
      case "D":
        status = "deleted";
        break;
      default:
        status = "modified";
    }

    entries.push({ path, status });
  }

  return entries;
}
