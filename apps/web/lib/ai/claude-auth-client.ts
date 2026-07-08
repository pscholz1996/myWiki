import type { ClaudeAuthStatus, ClaudeLoginEvent } from "@/lib/ai/claude-login";

export type { ClaudeAuthStatus, ClaudeLoginEvent };

export type ClaudeLoginStreamEvent =
  | { type: "login-id"; loginId: string }
  | ClaudeLoginEvent;

async function errFrom(res: Response): Promise<Error> {
  try {
    const data = await res.json();
    return new Error(data.error ?? `HTTP ${res.status}`);
  } catch {
    return new Error(`HTTP ${res.status}`);
  }
}

export async function fetchClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
  const res = await fetch("/api/claude/status", { cache: "no-store" });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

export async function claudeLogout(): Promise<{ ok: boolean }> {
  const res = await fetch("/api/claude/logout", { method: "POST" });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

export async function submitClaudeLoginCode(
  loginId: string,
  code: string,
): Promise<{ ok: boolean }> {
  const res = await fetch("/api/claude/login/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, code }),
  });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

// Same SSE-over-POST parsing shape as lib/git/gh-client.ts's streamGhLogin.
export async function streamClaudeLogin(
  onEvent: (event: ClaudeLoginStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/claude/login", { method: "POST", signal });
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
        onEvent(JSON.parse(dataText) as ClaudeLoginStreamEvent);
      } catch {
        // Malformed event frame — skip rather than crash the stream.
      }
    }
  }
}
