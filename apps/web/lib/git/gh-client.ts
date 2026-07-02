import type { GhStatus, GhUser } from "@/app/api/gh/status/route";
import type { GhLoginEvent } from "@/lib/git/gh-login";

export type { GhStatus, GhUser, GhLoginEvent };

async function errFrom(res: Response): Promise<Error> {
  try {
    const data = await res.json();
    return new Error(data.error ?? `HTTP ${res.status}`);
  } catch {
    return new Error(`HTTP ${res.status}`);
  }
}

export async function fetchGhStatus(): Promise<GhStatus> {
  const res = await fetch("/api/gh/status", { cache: "no-store" });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

export async function ghLogout(): Promise<{ ok: boolean }> {
  const res = await fetch("/api/gh/logout", { method: "POST" });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

export async function publishToGithub(params: {
  name: string;
  description?: string;
  visibility: "public" | "private";
}): Promise<{ ok: boolean; url: string | null }> {
  const res = await fetch("/api/gh/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

// Same SSE-over-POST parsing shape as lib/ai/ai-client.ts's streamAiChat —
// this repo's existing convention is a self-contained parser per client
// module rather than a shared abstraction.
export async function streamGhLogin(
  onEvent: (event: GhLoginEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/gh/login", { method: "POST", signal });
  if (!res.ok) throw await errFrom(res);
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const separator = buffer.indexOf("\n\n");
      if (separator === -1) break;

      const rawEvent = buffer.slice(0, separator).trim();
      buffer = buffer.slice(separator + 2);
      if (!rawEvent) continue;

      const lines = rawEvent.split("\n");
      const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      const dataText = dataLines.join("\n");
      if (!dataText) continue;

      try {
        onEvent(JSON.parse(dataText) as GhLoginEvent);
      } catch {
        // Malformed event frame — skip rather than crash the stream.
      }
    }
  }
}
