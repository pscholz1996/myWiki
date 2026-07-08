import { startClaudeLogin, cancelClaudeLogin } from "@/lib/ai/claude-login";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// POST + SSE, same shape as /api/ai/chat and /api/gh/login. The first event
// always carries the loginId the client needs to submit the pasted-back
// code to /api/claude/login/code — everything after that is just the
// in-flight process's own progress.
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

      const { loginId, events } = startClaudeLogin();
      push("login-id", { loginId });

      const onAbort = () => cancelClaudeLogin(loginId);
      req.signal.addEventListener("abort", onAbort);

      try {
        for await (const event of events) {
          push(event.type, event);
        }
      } catch (error) {
        push("error", {
          message: error instanceof Error ? error.message : "Sign-in failed",
          fallback: true,
        });
      } finally {
        req.signal.removeEventListener("abort", onAbort);
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
