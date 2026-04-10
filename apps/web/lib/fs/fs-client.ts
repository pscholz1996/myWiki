import type { FsNode } from "@/app/api/fs/list/route";

export type { FsNode };

export interface ListResponse {
  root: string;
  tree: FsNode[];
}

export interface TextReadResponse {
  path: string;
  type: "text";
  content: string;
  mtime: number;
}

export interface BinaryReadResponse {
  path: string;
  type: "binary";
  dataUrl: string;
  mtime: number;
}

export type ReadResponse = TextReadResponse | BinaryReadResponse;

async function errFrom(res: Response): Promise<Error> {
  try {
    const data = await res.json();
    return new Error(data.error ?? `HTTP ${res.status}`);
  } catch {
    return new Error(`HTTP ${res.status}`);
  }
}

export async function listFiles(): Promise<ListResponse> {
  const res = await fetch("/api/fs/list", { cache: "no-store" });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

export async function readFile(path: string): Promise<ReadResponse> {
  const res = await fetch(`/api/fs/read?path=${encodeURIComponent(path)}`, {
    cache: "no-store",
  });
  if (!res.ok) throw await errFrom(res);
  return res.json();
}

export async function writeFile(path: string, content: string): Promise<{ mtime: number }> {
  const res = await fetch(`/api/fs/write?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    body: content,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
  if (!res.ok) throw await errFrom(res);
  const data = await res.json();
  return { mtime: data.mtime };
}
