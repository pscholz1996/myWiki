import { NextResponse } from "next/server";
import { resetProjectDirCache } from "@/lib/fs/project-dir";
import { closeWatcher } from "@/lib/fs/watcher";
import { readCurrentProject, setCurrentProject } from "@/lib/project/config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { path?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        error: "bad-request",
        message: "Request body must be JSON with a 'path' field.",
      },
      { status: 400 },
    );
  }

  const rawPath = typeof body.path === "string" ? body.path.trim() : "";
  if (!rawPath) {
    return NextResponse.json(
      { error: "empty-path", message: "Path is required." },
      { status: 400 },
    );
  }

  try {
    setCurrentProject(rawPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let code: string;
    if (/does not exist/i.test(message)) code = "path-not-found";
    else if (/not a directory/i.test(message)) code = "not-a-directory";
    else if (/EACCES|EPERM|permission/i.test(message))
      code = "permission-denied";
    else code = "invalid-path";
    return NextResponse.json(
      { error: code, message, path: rawPath },
      { status: 400 },
    );
  }

  resetProjectDirCache();
  await closeWatcher();

  const current = readCurrentProject();
  return NextResponse.json({ current });
}
