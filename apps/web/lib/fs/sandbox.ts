import path from "node:path";

/**
 * Resolve a user-supplied relative path against `projectRoot`.
 * Guarantees the resolved path lives inside `projectRoot`.
 *
 * Throws on absolute paths, paths containing null bytes, empty paths,
 * or paths that resolve outside `projectRoot` via traversal/symlink-escape
 * attempts.
 *
 * Callers must pass an absolute, already-resolved `projectRoot`.
 */
export function resolveInProject(
  projectRoot: string,
  userPath: string,
): string {
  if (userPath === null || userPath === undefined) {
    throw new Error("Path is empty");
  }

  if (userPath.includes("\u0000")) {
    throw new Error("Invalid path: contains null byte");
  }

  const trimmed = userPath.trim();
  if (trimmed.length === 0) {
    throw new Error("Path is empty");
  }

  // Normalize backslashes so Windows-style inputs work.
  const normalizedInput = trimmed.replace(/\\/g, "/");

  if (path.posix.isAbsolute(normalizedInput) || /^[a-zA-Z]:/.test(normalizedInput)) {
    throw new Error("Absolute paths are not allowed");
  }

  const normalizedRoot = projectRoot.replace(/\\/g, "/");
  const joined = path.posix.join(normalizedRoot, normalizedInput);
  const resolved = path.posix.normalize(joined);

  const rootWithSep = normalizedRoot.endsWith("/")
    ? normalizedRoot
    : `${normalizedRoot}/`;

  if (resolved !== normalizedRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error("Path resolves outside project root");
  }

  return resolved;
}
