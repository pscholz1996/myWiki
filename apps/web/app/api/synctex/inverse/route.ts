import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface InverseRequest {
  buildId: string;
  page: number;
  x: number;
  y: number;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as InverseRequest | null;
  if (
    !body ||
    !body.buildId ||
    typeof body.page !== "number" ||
    typeof body.x !== "number" ||
    typeof body.y !== "number"
  ) {
    return NextResponse.json({ error: "invalid-request" }, { status: 400 });
  }

  const latexApiUrl = process.env.LATEX_API_URL || "http://localhost:3001";
  let upstream: Response;
  try {
    upstream = await fetch(`${latexApiUrl}/synctex/inverse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "upstream-failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (upstream.status === 404) {
    // Could be build-not-found (recompile-needed) or outside-project. The
    // upstream JSON body distinguishes them — pass it through unchanged so
    // the client can choose its toast.
    const text = await upstream.text();
    const data = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return { error: "not-found" };
      }
    })();
    if (data.error === "build-not-found") {
      return NextResponse.json({ error: "recompile-needed" }, { status: 409 });
    }
    return NextResponse.json(data, { status: 404 });
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
