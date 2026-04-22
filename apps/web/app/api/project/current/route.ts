import { NextResponse } from "next/server";
import { getRecentProjects, readCurrentProject } from "@/lib/project/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const current = readCurrentProject();
  const recent = getRecentProjects();
  return NextResponse.json({ current, recent });
}
