"use client";

import { useEffect, useState } from "react";

export interface CurrentProjectState {
  current: string | null;
  recent: string[];
  loading: boolean;
  error: string | null;
}

export function useCurrentProject(): CurrentProjectState {
  const [state, setState] = useState<CurrentProjectState>({
    current: null,
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
          recent: string[];
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        setState({
          current: data.current,
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
