import { NextResponse } from "next/server";
import { getProjectTagline } from "@/lib/ai/tagline";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The generated tail of the empty state's subtitle.
 *
 * Always 200 with `{ tagline: string | null }`, even when generation fails:
 * this decorates one line of copy that already has a perfectly good default,
 * so an error status would only invite the client to show a problem the user
 * has no reason to care about.
 */
export async function GET() {
  try {
    const tagline = await getProjectTagline(getProjectDir());
    return NextResponse.json({ tagline });
  } catch (error) {
    if (error instanceof NoProjectSelectedError) {
      return NextResponse.json(
        { error: "no-project-selected" },
        { status: 409 },
      );
    }
    return NextResponse.json({ tagline: null });
  }
}
