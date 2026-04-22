import { NextResponse } from "next/server";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

interface BrowseEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path: string | null;
  parent: string | null;
  entries: BrowseEntry[];
}

function listDrives(): BrowseEntry[] {
  const drives: BrowseEntry[] = [];
  for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
    const letter = String.fromCharCode(code);
    const drive = `${letter}:\\`;
    if (fs.existsSync(drive)) {
      drives.push({ name: drive, path: drive });
    }
  }
  return drives;
}

function parentOf(p: string): string | null {
  const parent = path.dirname(p);
  if (parent === p) return null;
  return parent;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requested = url.searchParams.get("path")?.trim() ?? "";

  if (!requested) {
    const entries =
      process.platform === "win32" ? listDrives() : [{ name: "/", path: "/" }];
    return NextResponse.json({
      path: null,
      parent: null,
      entries,
    } satisfies BrowseResponse);
  }

  if (!path.isAbsolute(requested)) {
    return NextResponse.json(
      { error: "invalid-path", path: requested },
      { status: 400 },
    );
  }
  const resolved = path.resolve(requested);

  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isDirectory()) {
      return NextResponse.json(
        { error: "not-a-directory", path: resolved },
        { status: 400 },
      );
    }
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : null;
    if (code === "ENOENT") {
      return NextResponse.json(
        { error: "path-not-found", path: resolved },
        { status: 404 },
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      return NextResponse.json(
        { error: "permission-denied", path: resolved },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "read-failed", path: resolved },
      { status: 500 },
    );
  }

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fsp.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : null;
    if (code === "EACCES" || code === "EPERM") {
      return NextResponse.json(
        { error: "permission-denied", path: resolved },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "read-failed", path: resolved },
      { status: 500 },
    );
  }

  const entries: BrowseEntry[] = dirents
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, path: path.join(resolved, d.name) }))
    .sort((a, b) => {
      const aHidden = a.name.startsWith(".");
      const bHidden = b.name.startsWith(".");
      if (aHidden !== bHidden) return aHidden ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

  return NextResponse.json({
    path: resolved,
    parent: parentOf(resolved),
    entries,
  } satisfies BrowseResponse);
}
