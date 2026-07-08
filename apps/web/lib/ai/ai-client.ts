import type {
  AiChatRequest,
  AiChatStreamEvent,
  AiConversation,
  AiManifest,
  AiPlanUsage,
  AiRejectedSourceFile,
  AiSourceRecord,
  AiUploadProgressEvent,
  AiUploadResult,
} from "@/lib/ai/types";

function errFrom(res: Response): Promise<Error> {
  return res
    .json()
    .then((data: { error?: string; rejected?: AiRejectedSourceFile[] }) => {
      const reasons = data.rejected?.map((r) => `${r.name}: ${r.reason}`).join("; ");
      const message = reasons ? `${data.error ?? "Upload failed"} (${reasons})` : data.error;
      return new Error(message ?? `HTTP ${res.status}`);
    })
    .catch(() => new Error(`HTTP ${res.status}`));
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw await errFrom(res);
  return res.json() as Promise<T>;
}

// Shared line-buffering for text/event-stream responses — splits on the
// blank-line event separator and hands each event's raw "event:"/"data:"
// lines to the caller. Deliberately doesn't parse the data as JSON itself:
// streamAiChat and uploadAiSources want different fallback behavior on a
// malformed event (a different error-event shape each), so that stays with
// the caller instead of being forced into one shared shape here.
async function readSseEvents(
  res: Response,
  onEvent: (type: string, dataText: string) => void,
): Promise<void> {
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
      onEvent(eventLine.slice(6).trim(), dataLines.join("\n"));
    }
  }
}

export async function fetchAiManifest(): Promise<AiManifest> {
  return getJson<AiManifest>("/api/ai/sources");
}

export async function uploadAiSources(
  files: File[],
  onProgress?: (event: AiUploadProgressEvent) => void,
): Promise<AiUploadResult> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }

  const res = await fetch("/api/ai/sources", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) throw await errFrom(res);

  let result: AiUploadResult | null = null;
  let errorMessage: string | null = null;

  await readSseEvents(res, (type, dataText) => {
    let data: unknown;
    try {
      data = dataText ? JSON.parse(dataText) : undefined;
    } catch {
      errorMessage = "Failed to parse upload progress";
      return;
    }

    if (type === "progress") {
      onProgress?.(data as AiUploadProgressEvent);
    } else if (type === "done") {
      result = data as AiUploadResult;
    } else if (type === "error") {
      const errData = data as {
        error?: string;
        rejected?: AiRejectedSourceFile[];
      };
      const reasons = errData.rejected
        ?.map((r) => `${r.name}: ${r.reason}`)
        .join("; ");
      errorMessage = reasons
        ? `${errData.error ?? "Upload failed"} (${reasons})`
        : (errData.error ?? "Upload failed");
    }
  });

  if (errorMessage) throw new Error(errorMessage);
  if (!result) throw new Error("Upload ended without a result");
  return result;
}

export async function deleteAiSource(sourceId: string): Promise<AiManifest> {
  const res = await fetch(`/api/ai/sources/${sourceId}`, {
    method: "DELETE",
  });

  if (!res.ok) throw await errFrom(res);
  return res.json() as Promise<AiManifest>;
}

export async function updateAiSourceMetadata(
  sourceId: string,
  updates: { title: string; authors: string[]; year: string },
): Promise<AiSourceRecord> {
  const res = await fetch(`/api/ai/sources/${sourceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });

  if (!res.ok) throw await errFrom(res);
  return res.json() as Promise<AiSourceRecord>;
}

// There's exactly one conversation per project — no id to pick between.
export async function fetchAiConversation(): Promise<AiConversation | null> {
  const res = await fetch("/api/ai/conversation", { cache: "no-store" });
  if (!res.ok) throw await errFrom(res);
  const data = (await res.json()) as { conversation: AiConversation | null };
  return data.conversation;
}

export async function clearAiConversation(): Promise<{ ok: boolean }> {
  const res = await fetch("/api/ai/conversation", { method: "DELETE" });
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

  await readSseEvents(res, (type, dataText) => {
    try {
      onEvent({
        type: type as AiChatStreamEvent["type"] | string,
        data: dataText ? JSON.parse(dataText) : undefined,
      } as AiChatStreamEvent);
    } catch {
      onEvent({
        type: "error",
        message: dataText || "Failed to parse chat event",
      });
    }
  });
}

// null before the first message of a server run (no live SDK session yet
// to ask) — not an error, just "not available yet".
export async function fetchPlanUsage(): Promise<AiPlanUsage | null> {
  const data = await getJson<{ usage: AiPlanUsage | null }>("/api/ai/usage");
  return data.usage;
}

export { errFrom, getJson };
