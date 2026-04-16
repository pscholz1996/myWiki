import type { GitInfo } from "@/app/api/git/info/route";
import type {
  GitStatusResponse,
  GitFileStatus,
} from "@/app/api/git/status/route";

export type { GitInfo, GitStatusResponse, GitFileStatus };

async function errFrom(res: Response): Promise<Error> {
  try {
    const data = await res.json();
    return new Error(data.error ?? `HTTP ${res.status}`);
  } catch {
    return new Error(`HTTP ${res.status}`);
  }
}

export async function fetchGitInfo(): Promise<GitInfo> {
  const res = await fetch("/api/git/info", { cache: "no-store" });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

export async function fetchGitStatus(): Promise<GitStatusResponse> {
  const res = await fetch("/api/git/status", { cache: "no-store" });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

export async function stageFiles(paths: string[]): Promise<{ ok: boolean }> {
  const res = await fetch("/api/git/stage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

export async function unstageFiles(paths: string[]): Promise<{ ok: boolean }> {
  const res = await fetch("/api/git/unstage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

export async function commitChanges(
  message: string,
): Promise<{ ok: boolean; output: string }> {
  const res = await fetch("/api/git/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

export async function pullChanges(): Promise<{ ok: boolean; output: string }> {
  const res = await fetch("/api/git/pull", {
    method: "POST",
  });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

export async function pushChanges(): Promise<{ ok: boolean; output: string }> {
  const res = await fetch("/api/git/push", {
    method: "POST",
  });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}
