import { NextResponse } from "next/server";
import { readCurrentProject } from "@/lib/project/config";
import { getKbInfo, listKnownKbs } from "@/lib/project/kb-registry";

export const dynamic = "force-dynamic";

export async function GET() {
  const current = readCurrentProject();
  return NextResponse.json({
    current,
    currentName: current ? getKbInfo(current).name : null,
    recent: listKnownKbs(),
  });
}
