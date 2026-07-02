import type {
  AiChatRequest,
  AiChatStreamEvent,
  AiConversation,
  AiConversationSummary,
  AiManifest,
} from "@/lib/ai/types";

function errFrom(res: Response): Promise<Error> {
  return res
    .json()
    .then(
      (data: { error?: string }) =>
        new Error(data.error ?? `HTTP ${res.status}`),
    )
    .catch(() => new Error(`HTTP ${res.status}`));
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw await errFrom(res);
  return res.json() as Promise<T>;
}

export async function fetchAiManifest(): Promise<AiManifest> {
  return getJson<AiManifest>("/api/ai/sources");
}

export async function uploadAiSources(files: File[]): Promise<AiManifest> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }

  const res = await fetch("/api/ai/sources", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) throw await errFrom(res);
  return res.json() as Promise<AiManifest>;
}

export async function deleteAiSource(sourceId: string): Promise<AiManifest> {
  const res = await fetch(`/api/ai/sources/${sourceId}`, {
    method: "DELETE",
  });

  if (!res.ok) throw await errFrom(res);
  return res.json() as Promise<AiManifest>;
}

export async function fetchAiConversations(): Promise<AiConversationSummary[]> {
  const res = await fetch("/api/ai/conversations", { cache: "no-store" });
  if (!res.ok) throw await errFrom(res);
  const data = (await res.json()) as { conversations: AiConversationSummary[] };
  return data.conversations;
}

export async function fetchAiConversation(
  conversationId: string,
): Promise<AiConversation> {
  const res = await fetch(`/api/ai/conversations/${conversationId}`, {
    cache: "no-store",
  });
  if (!res.ok) throw await errFrom(res);
  const data = (await res.json()) as { conversation: AiConversation };
  return data.conversation;
}

export async function deleteAiConversation(
  conversationId: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/ai/conversations/${conversationId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw await errFrom(res);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function streamAiChat(
  request: AiChatRequest,
  onEvent: (event: AiChatStreamEvent) => void,
): Promise<void> {
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

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
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());

      if (!eventLine) continue;
      const type = eventLine.slice(6).trim();
      const dataText = dataLines.join("\n");

      try {
        onEvent({
          type: type as AiChatStreamEvent["type"] | string,
          conversationId: request.conversationId ?? "",
          data: dataText ? JSON.parse(dataText) : undefined,
        } as AiChatStreamEvent);
      } catch {
        onEvent({
          type: "error",
          conversationId: request.conversationId ?? "",
          message: dataText || "Failed to parse chat event",
        });
      }
    }
  }
}

export { errFrom, getJson };
