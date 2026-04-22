import { subscribe, type FsEvent } from "@/lib/fs/watcher";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET() {
  try {
    getProjectDir();
  } catch (error) {
    if (error instanceof NoProjectSelectedError) {
      return new Response(JSON.stringify({ error: "no-project-selected" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw error;
  }

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;

      const safeSend = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          closed = true;
          doCleanup();
        }
      };

      const send = (event: { type: string; payload?: unknown }) => {
        safeSend(
          `event: ${event.type}\ndata: ${JSON.stringify(event.payload ?? {})}\n\n`,
        );
      };

      send({ type: "ready", payload: {} });

      const unsubscribe = subscribe((fsEvent: FsEvent) => {
        send({ type: "fs", payload: fsEvent });
      });

      const heartbeat = setInterval(() => {
        safeSend(`: heartbeat\n\n`);
      }, 15000);

      const doCleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      cleanup = doCleanup;
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
