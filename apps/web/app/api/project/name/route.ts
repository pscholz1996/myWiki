import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { readCurrentProject } from "@/lib/project/config";
import { getKbInfo, writeKbName } from "@/lib/project/kb-registry";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { path?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        error: "bad-request",
        message: "Request body must be JSON with a 'name' field.",
      },
      { status: 400 },
    );
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json(
      { error: "empty-name", message: "Name is required." },
      { status: 400 },
    );
  }

  let target: string | null;
  if (typeof body.path === "string" && body.path.trim()) {
    const resolved = path.resolve(body.path.trim());
    try {
      if (!fs.statSync(resolved).isDirectory()) throw new Error();
    } catch {
      return NextResponse.json(
        { error: "path-not-found", path: resolved },
        { status: 404 },
      );
    }
    target = resolved;
  } else {
    target = readCurrentProject();
    if (!target) {
      return NextResponse.json(
        { error: "no-project-selected" },
        { status: 409 },
      );
    }
  }

  writeKbName(target, name);
  return NextResponse.json({ kb: getKbInfo(target) });
}
