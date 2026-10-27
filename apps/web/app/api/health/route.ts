import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Says "this is myWiki" — not "something is listening".
 *
 * Launchers and external callers used to treat any answer on the port as
 * myWiki. That held until another app (an Electron tool with an embedded
 * Express server) took the port, and the launcher kept opening the browser
 * on it: "Cannot GET /". A fixed, app-specific answer is the only thing that
 * tells the two apart, so this response is a contract, not a status page —
 * keep the `app` field stable.
 */
export async function GET() {
  return NextResponse.json({ app: "mywiki" });
}
