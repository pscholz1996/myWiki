export interface EchoTracker {
  /** Record that the server just wrote to `path`; events within the window will be suppressed. */
  recordWrite(path: string): void;
  /**
   * Check whether the next incoming chokidar event for `path` should be suppressed
   * (because it's an echo of our own write). Consumes the entry — a second call
   * returns `false` unless recordWrite was called again.
   */
  shouldSuppress(path: string): boolean;
}

/**
 * Chokidar double-fires every server-originated write as a "change" event.
 * This helper remembers paths we just wrote for `windowMs` so the SSE watcher
 * can drop the echo and only forward genuine external edits.
 */
export function createEchoTracker(windowMs: number): EchoTracker {
  const expirations = new Map<string, number>();

  return {
    recordWrite(path: string) {
      expirations.set(path, Date.now() + windowMs);
    },

    shouldSuppress(path: string) {
      const expiresAt = expirations.get(path);
      if (expiresAt === undefined) return false;
      if (Date.now() > expiresAt) {
        expirations.delete(path);
        return false;
      }
      expirations.delete(path);
      return true;
    },
  };
}
