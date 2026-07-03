import { NextResponse } from "next/server";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import {
  listAiSources,
  uploadAiSources,
  type AiUploadProgressEvent,
} from "@/lib/ai/knowledge-base";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const projectDir = getProjectDir();
    const manifest = await listAiSources(projectDir);
    return NextResponse.json(manifest);
  } catch (error) {
    if (error instanceof NoProjectSelectedError) {
      return NextResponse.json(
        { error: "no-project-selected" },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function sse(type: string, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Streamed as SSE rather than a single JSON response: embedding a large PDF
// through the local CPU-bound model can run tens of seconds, and a plain
// request/response gives the client nothing to show but a spinner for that
// whole window. Progress events (per-source extraction, per-batch
// embedding) let the UI show real, incremental status instead.
export async function POST(req: Request) {
  const formData = await req.formData().catch(() => null);
  const files = (formData?.getAll("files") ?? []).filter(
    (item): item is File => item instanceof File,
  );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (type: string, data: unknown) => {
        controller.enqueue(sse(type, data));
      };

      try {
        const projectDir = getProjectDir();

        if (files.length === 0) {
          push("error", { error: "No files uploaded" });
          return;
        }

        const { manifest, rejected } = await uploadAiSources(
          projectDir,
          files,
          (event: AiUploadProgressEvent) => push("progress", event),
        );

        if (rejected.length === files.length) {
          push("error", { error: "No files were accepted", rejected });
          return;
        }

        push("done", { ...manifest, rejected });
      } catch (error) {
        if (error instanceof NoProjectSelectedError) {
          push("error", { error: "no-project-selected" });
        } else {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          push("error", { error: message });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
