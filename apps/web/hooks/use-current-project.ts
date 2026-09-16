"use client";

import { useEffect, useState } from "react";
import type { KnownKb } from "@/lib/project/kb-registry";

export interface CurrentProjectState {
  current: string | null;
  currentName: string | null;
  recent: KnownKb[];
  loading: boolean;
  error: string | null;
}

export function useCurrentProject(): CurrentProjectState {
  const [state, setState] = useState<CurrentProjectState>({
    current: null,
    currentName: null,
    recent: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/project/current")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{
          current: string | null;
          currentName: string | null;
          recent: KnownKb[];
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        setState({
          current: data.current,
          currentName: data.currentName,
          recent: data.recent,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Unknown error";
        setState((s) => ({ ...s, loading: false, error: message }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
