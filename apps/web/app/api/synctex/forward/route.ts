import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface ForwardRequest {
  buildId: string;
  file: string;
  line: number;
  column?: number;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ForwardRequest | null;
  if (!body || !body.buildId || !body.file || typeof body.line !== "number") {
    return NextResponse.json({ error: "invalid-request" }, { status: 400 });
  }

  const latexApiUrl = process.env.LATEX_API_URL || "http://localhost:3001";
  let upstream: Response;
  try {
    upstream = await fetch(`${latexApiUrl}/synctex/forward`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "upstream-failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (upstream.status === 404) {
    return NextResponse.json({ error: "recompile-needed" }, { status: 409 });
  }
  if (upstream.status === 204) {
    return new NextResponse(null, { status: 204 });
  }
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
