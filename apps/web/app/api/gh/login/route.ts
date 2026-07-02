import { runGhDeviceLogin } from "@/lib/git/gh-login";

export const dynamic = "force-dynamic";

function sse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// POST + SSE (not a plain GET+EventSource) for the same reason as
// /api/ai/chat: the client reads the body manually via
// res.body.getReader(), since EventSource can't POST and this route needs
// no request body anyway — POST here just signals "start a login attempt"
// rather than carrying data.
export async function POST(req: Request) {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const push = (type: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(type, data)));
        } catch {
          closed = true;
        }
      };

      try {
        for await (const event of runGhDeviceLogin(req.signal)) {
          push(event.type, event);
        }
      } catch (error) {
        push("error", {
          message: error instanceof Error ? error.message : "Sign-in failed",
          fallback: true,
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
