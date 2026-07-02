export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
}

// Unit separator (0x1f) instead of a printable delimiter like "|||" (used by
// info/route.ts for its single-commit case) — a commit subject can contain
// arbitrary printable text, including "|||", but never a raw control char.
const FIELD_SEP = "\x1f";

export const GIT_LOG_FORMAT = `%H${FIELD_SEP}%h${FIELD_SEP}%s${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI`;

/**
 * Parses `git log --format=<GIT_LOG_FORMAT>` output. %s is always exactly
 * the commit's first line (git itself excludes the body), so newline is a
 * safe record separator between commits.
 */
export function parseGitLog(raw: string): GitLogEntry[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  return trimmed.split("\n").flatMap((line) => {
    const [hash, shortHash, message, author, authorEmail, date] =
      line.split(FIELD_SEP);
    if (!hash) return [];
    return [
      {
        hash,
        shortHash: shortHash ?? hash.slice(0, 8),
        message: message ?? "",
        author: author ?? "",
        authorEmail: authorEmail ?? "",
        date: date ?? "",
      },
    ];
  });
}
