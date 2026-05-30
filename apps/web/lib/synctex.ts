import { usePdfStore } from "@/stores/pdf-store";

export interface ForwardHit {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  width: number;
  height: number;
}

export interface InverseHit {
  file: string;
  line: number;
  column: number;
}

export type SyncOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "no-build" } // never compiled in this session
  | { kind: "recompile-needed" } // server evicted the build
  | { kind: "synctex-disabled" } // .synctex.gz wasn't produced
  | { kind: "outside-project" } // inverse target is a system file
  | { kind: "no-match" } // synctex found nothing for these coords
  | { kind: "error"; message: string };

/**
 * Forward-sync: from a source position to a PDF location. On success, the
 * caller is responsible for scrolling/highlighting; this function just calls
 * the server. Pass the *project-relative* file path the same way the compile
 * route did.
 */
export async function syncForward(
  file: string,
  line: number,
  column = 0,
): Promise<SyncOutcome<ForwardHit>> {
  const buildId = usePdfStore.getState().buildId;
  if (!buildId) return { kind: "no-build" };

  let res: Response;
  try {
    res = await fetch("/api/synctex/forward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buildId, file, line, column }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "network-failed";
    return { kind: "error", message };
  }

  if (res.status === 409) return { kind: "recompile-needed" };
  if (res.status === 422) return { kind: "synctex-disabled" };
  if (res.status === 204) return { kind: "no-match" };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { kind: "error", message: text || `synctex-${res.status}` };
  }
  const value = (await res.json()) as ForwardHit;
  return { kind: "ok", value };
}

/**
 * Inverse-sync: from a PDF coordinate (in PDF points, origin top-left) to a
 * source position.
 */
export async function syncInverse(
  page: number,
  x: number,
  y: number,
): Promise<SyncOutcome<InverseHit>> {
  const buildId = usePdfStore.getState().buildId;
  if (!buildId) return { kind: "no-build" };

  let res: Response;
  try {
    res = await fetch("/api/synctex/inverse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buildId, page, x, y }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "network-failed";
    return { kind: "error", message };
  }

  if (res.status === 409) return { kind: "recompile-needed" };
  if (res.status === 422) return { kind: "synctex-disabled" };
  if (res.status === 204) return { kind: "no-match" };
  if (res.status === 404) {
    const text = await res.text().catch(() => "");
    if (text.includes("outside-project")) return { kind: "outside-project" };
    return { kind: "no-match" };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { kind: "error", message: text || `synctex-${res.status}` };
  }
  const value = (await res.json()) as InverseHit;
  return { kind: "ok", value };
}

/**
 * Map an outcome onto a user-facing toast message. Returns null for "ok",
 * meaning the caller should not toast.
 */
export function describeOutcome<T>(outcome: SyncOutcome<T>): string | null {
  switch (outcome.kind) {
    case "ok":
      return null;
    case "no-build":
      return "Compile the document before syncing.";
    case "recompile-needed":
      return "PDF is out of date — recompile to sync.";
    case "synctex-disabled":
      return "SyncTeX is disabled for this document.";
    case "outside-project":
      return "Source is outside this project.";
    case "no-match":
      return "No sync target found for this position.";
    case "error":
      return `SyncTeX failed: ${outcome.message}`;
  }
}
