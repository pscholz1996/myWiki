import fs from "node:fs/promises";
import path from "node:path";
import { ALLOWED_EXTS, EXCLUDED_DIRS } from "@/lib/fs/project-dir";

export interface FsNode {
  path: string; // relative POSIX, e.g. "chapters/intro.tex"
  type: "file" | "dir";
  mtime: number; // ms since epoch
  children?: FsNode[];
}

export async function listProjectTree(
  projectDir: string,
  absDir: string = projectDir,
): Promise<FsNode[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const nodes: FsNode[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

    const absPath = path.join(absDir, entry.name);
    const relPath = path.relative(projectDir, absPath).replace(/\\/g, "/");
    const stat = await fs.stat(absPath);

    if (entry.isDirectory()) {
      const children = await listProjectTree(projectDir, absPath);
      if (children.length > 0) {
        nodes.push({
          path: relPath,
          type: "dir",
          mtime: stat.mtimeMs,
          children,
        });
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) continue;
      nodes.push({
        path: relPath,
        type: "file",
        mtime: stat.mtimeMs,
      });
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return nodes;
}
