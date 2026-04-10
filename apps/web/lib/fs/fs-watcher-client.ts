export type FsEventType = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

export interface FsEvent {
  type: FsEventType;
  path: string;
}

export type FsListener = (event: FsEvent) => void;
export type StatusListener = (
  status: "connecting" | "connected" | "disconnected",
) => void;

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 5000];

export interface FsWatcherHandle {
  close(): void;
}

export function startFsWatcher(
  onEvent: FsListener,
  onStatus?: StatusListener,
): FsWatcherHandle {
  let source: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    onStatus?.("connecting");
    source = new EventSource("/api/fs/watch");

    source.addEventListener("ready", () => {
      attempt = 0;
      onStatus?.("connected");
    });

    source.addEventListener("fs", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as FsEvent;
        onEvent(data);
      } catch (e) {
        console.warn("Invalid fs event", e);
      }
    });

    source.onerror = () => {
      if (closed) return;
      source?.close();
      source = null;
      onStatus?.("disconnected");
      const delay =
        RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
      source = null;
    },
  };
}
