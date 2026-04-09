import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createEchoTracker } from "./echo-suppression";

describe("createEchoTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("suppresses an event that arrives immediately after recordWrite", () => {
    const tracker = createEchoTracker(100);
    tracker.recordWrite("/p/main.tex");
    expect(tracker.shouldSuppress("/p/main.tex")).toBe(true);
  });

  test("suppresses an event 99ms after recordWrite", () => {
    const tracker = createEchoTracker(100);
    tracker.recordWrite("/p/main.tex");
    vi.advanceTimersByTime(99);
    expect(tracker.shouldSuppress("/p/main.tex")).toBe(true);
  });

  test("does not suppress an event 101ms after recordWrite", () => {
    const tracker = createEchoTracker(100);
    tracker.recordWrite("/p/main.tex");
    vi.advanceTimersByTime(101);
    expect(tracker.shouldSuppress("/p/main.tex")).toBe(false);
  });

  test("does not suppress an event with no preceding write", () => {
    const tracker = createEchoTracker(100);
    expect(tracker.shouldSuppress("/p/main.tex")).toBe(false);
  });

  test("concurrent writes to different paths do not interfere", () => {
    const tracker = createEchoTracker(100);
    tracker.recordWrite("/p/a.tex");
    vi.advanceTimersByTime(60);
    tracker.recordWrite("/p/b.tex");
    vi.advanceTimersByTime(50);
    // a.tex has been 110ms since write → not suppressed
    expect(tracker.shouldSuppress("/p/a.tex")).toBe(false);
    // b.tex has been 50ms since write → suppressed
    expect(tracker.shouldSuppress("/p/b.tex")).toBe(true);
  });

  test("shouldSuppress consumes the entry (only first event within window is suppressed)", () => {
    const tracker = createEchoTracker(100);
    tracker.recordWrite("/p/main.tex");
    expect(tracker.shouldSuppress("/p/main.tex")).toBe(true);
    expect(tracker.shouldSuppress("/p/main.tex")).toBe(false);
  });
});
