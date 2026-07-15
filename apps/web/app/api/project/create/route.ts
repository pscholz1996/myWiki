import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { closeWatcher } from "@/lib/fs/watcher";
import { readCurrentProject, setCurrentProject } from "@/lib/project/config";

export const dynamic = "force-dynamic";

// A knowledge folder starts empty — the app fills .mywiki/ with the index
// and copied sources on first upload; there is nothing to scaffold.

export async function POST(req: Request) {
  let body: { parentPath?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        error: "bad-request",
        message:
          "Request body must be JSON with 'parentPath' and 'name' fields.",
      },
      { status: 400 },
    );
  }

  const parentPath =
    typeof body.parentPath === "string" ? body.parentPath.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!parentPath) {
    return NextResponse.json(
      { error: "empty-parent", message: "A location is required." },
      { status: 400 },
    );
  }
  if (!name) {
    return NextResponse.json(
      { error: "empty-name", message: "A project name is required." },
      { status: 400 },
    );
  }
  // The name must be a single new folder inside parentPath, not a nested
  // path — the client only offers a plain text field for it, so anything
  // with a separator or a "." / ".." segment is either a mistake or an
  // attempt to escape the chosen location.
  if (/[/\\]/.test(name) || name === "." || name === "..") {
    return NextResponse.json(
      {
        error: "invalid-name",
        message:
          "Project name can't contain a path separator or be '.' / '..'.",
      },
      { status: 400 },
    );
  }

  const resolvedParent = path.resolve(parentPath);
  try {
    const parentStat = await fs.stat(resolvedParent);
    if (!parentStat.isDirectory()) {
      return NextResponse.json(
        {
          error: "not-a-directory",
          message: "Location is not a directory.",
          path: resolvedParent,
        },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      {
        error: "path-not-found",
        message: "Location does not exist.",
        path: resolvedParent,
      },
      { status: 400 },
    );
  }

  const projectPath = path.join(resolvedParent, name);

  try {
    const existingStat = await fs.stat(projectPath).catch(() => null);
    if (existingStat) {
      if (!existingStat.isDirectory()) {
        return NextResponse.json(
          {
            error: "not-a-directory",
            message: "A file already exists with that name.",
            path: projectPath,
          },
          { status: 400 },
        );
      }
      const contents = await fs.readdir(projectPath);
      if (contents.length > 0) {
        return NextResponse.json(
          {
            error: "not-empty",
            message:
              "A folder with that name already exists and isn't empty. Choose a different name.",
            path: projectPath,
          },
          { status: 409 },
        );
      }
    } else {
      await fs.mkdir(projectPath, { recursive: true });
    }

    setCurrentProject(projectPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /EACCES|EPERM|permission/i.test(message)
      ? "permission-denied"
      : "create-failed";
    return NextResponse.json(
      { error: code, message, path: projectPath },
      { status: 500 },
    );
  }

  await closeWatcher();

  const current = readCurrentProject();
  return NextResponse.json({ current }, { status: 201 });
}
