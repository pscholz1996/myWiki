import { subscribe, type FsEvent } from "@/lib/fs/watcher";
import { getProjectDir } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";
// Long-lived; disable Next.js route buffering.
export const fetchCache = "force-no-store";

export async function GET() {
  // Ensure project dir is validated and watcher initialized before we start the stream.
  getProjectDir();

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();

      const send = (event: { type: string; payload?: unknown }) => {
        const data = `event: ${event.type}\ndata: ${JSON.stringify(event.payload ?? {})}\n\n`;
        controller.enqueue(enc.encode(data));
      };

      // Initial hello so the client knows the stream is alive.
      send({ type: "ready", payload: {} });

      const unsubscribe = subscribe((fsEvent: FsEvent) => {
        send({ type: "fs", payload: fsEvent });
      });

      // Heartbeat every 15s to keep proxies from closing idle connections.
      const heartbeat = setInterval(() => {
        controller.enqueue(enc.encode(`: heartbeat\n\n`));
      }, 15000);

      // Close hook — bound via AbortSignal on the request if available.
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Next.js signals cancellation via stream cancel.
      (controller as unknown as { __cleanup?: () => void }).__cleanup = cleanup;
    },
    cancel() {
      const self = this as unknown as { __cleanup?: () => void };
      self.__cleanup?.();
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
