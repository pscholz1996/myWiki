import { NextResponse } from "next/server";
import { forgetRecentProject } from "@/lib/project/config";
import { listKnownKbs } from "@/lib/project/kb-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { path?: string };
    const target = body.path?.trim();
    if (!target) {
      return NextResponse.json({ error: "Missing path" }, { status: 400 });
    }

    forgetRecentProject(target);
    return NextResponse.json({ recent: listKnownKbs() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
