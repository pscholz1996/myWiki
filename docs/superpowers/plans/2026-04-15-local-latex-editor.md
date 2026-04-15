# Local LaTeX Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the forked open-prism app from an AI-assisted, browser-storage LaTeX editor into a local filesystem-backed LaTeX editor with auto-reload on external edits, all AI features removed.

**Architecture:** Next.js 16 app serves API routes for filesystem read/write/list and an SSE stream for file-watch events driven by chokidar. Client state (Zustand) mirrors disk state. All edits debounce-write to disk; all disk changes push through SSE back to the editor. `latex-api` (Hono) is untouched. VS Code's Git integration handles version control externally.

**Tech Stack:** Next.js 16, React 19, TypeScript (strict), Zustand 5, CodeMirror 6, react-pdf, chokidar (new), Vitest (new), tailwindcss v4.

**Reference:** [Design spec](../specs/2026-04-15-local-latex-editor-design.md) — read it first.

---

## File layout at the end of this plan

**Under `apps/web/`:**

- `app/api/fs/list/route.ts` — GET, returns recursive tree
- `app/api/fs/read/route.ts` — GET, returns file content
- `app/api/fs/write/route.ts` — PUT, writes UTF-8 body to disk
- `app/api/fs/watch/route.ts` — GET SSE stream
- `app/api/pdf/cached/route.ts` — GET, returns cached PDF if fresh, else 404
- `app/api/compile/route.ts` — **modified** — reads from disk, writes PDF to `.openprism/out.pdf`
- `app/provider.tsx` — **modified** — AI provider removed
- `app/page.tsx` / `app/layout.tsx` — touched if needed
- `lib/fs/sandbox.ts` — pure path-resolver; unit-tested
- `lib/fs/sandbox.test.ts` — Vitest tests
- `lib/fs/echo-suppression.ts` — pure write-echo tracker; unit-tested
- `lib/fs/echo-suppression.test.ts` — Vitest tests
- `lib/fs/project-dir.ts` — reads `PROJECT_DIR` env, validates, exports absolute path; ensures `.openprism/` exists
- `lib/fs/watcher.ts` — chokidar singleton + event-bus used by `watch` route
- `lib/fs/fs-client.ts` — typed client wrappers for the fs API routes
- `lib/fs/fs-watcher-client.ts` — client EventSource with reconnect
- `lib/latex-compiler.ts` — **modified** — removes resource arg; compile pulls from server
- `stores/fs-store.ts` — tree state; populated from `/api/fs/list`, mutated by watcher events
- `stores/editor-store.ts` — active file + buffer + debounced write-through
- `stores/pdf-store.ts` — PDF bytes + compile status
- `components/workspace/sidebar/file-tree.tsx` — recursive tree view
- `components/workspace/sidebar/sidebar.tsx` — **modified** — uses file-tree, outline kept
- `components/workspace/editor/latex-editor.tsx` — **modified** — write-through + watcher-driven reload
- `components/workspace/preview/pdf-preview.tsx` — **modified** — consumes pdf-store only
- `components/workspace/workspace-layout.tsx` — **modified** — startup hook wiring
- `hooks/use-fs-startup.ts` — new: calls `/api/fs/list`, opens watcher SSE, loads cached PDF
- `.env.example` — **modified** — `PROJECT_DIR` only

**Deleted under `apps/web/`:**

- `app/api/chat/` (entire directory)
- `components/assistant-ui/` (entire directory)
- `components/workspace/editor/ai-drawer.tsx`
- `hooks/use-document-context.ts`
- `hooks/use-storage-ready.ts` (no longer needed — no async storage)
- `hooks/use-project-init.ts` (replaced by `use-fs-startup.ts`)
- `lib/ratelimit.ts`
- `lib/storage/` (entire directory)
- `stores/document-store.ts`

**Unchanged:**

- `apps/latex-api/` — zero changes
- All shadcn/ui components under `components/ui/`
- All other editor sub-components (`editor-toolbar`, `latex-tools`, `search-panel`, `image-preview`, `pdf-viewer`)

---

## Phase 1 — Foundation & cleanup

### Task 1: Add Vitest

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/vitest.config.ts`

- [ ] **Step 1: Add vitest devDependency**

In `apps/web/package.json`, add to `devDependencies`:

```json
"vitest": "^2.1.8"
```

And add to `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Install**

Run: `cd apps/web && pnpm install`
Expected: vitest installed, no errors.

- [ ] **Step 3: Create vitest config**

Create `apps/web/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
```

- [ ] **Step 4: Smoke-test vitest**

Create `apps/web/lib/__vitest-smoke.test.ts`:

```ts
import { expect, test } from "vitest";

test("vitest runs", () => {
  expect(1 + 1).toBe(2);
});
```

Run: `cd apps/web && pnpm test`
Expected: 1 passed, 0 failed.

Delete the smoke file: `rm apps/web/lib/__vitest-smoke.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml apps/web/vitest.config.ts
git commit -m "chore: add vitest for apps/web"
```

---

### Task 2: Remove AI integration — code deletions

**Files:**
- Delete: `apps/web/app/api/chat/` (directory)
- Delete: `apps/web/components/assistant-ui/` (directory)
- Delete: `apps/web/components/workspace/editor/ai-drawer.tsx`
- Delete: `apps/web/hooks/use-document-context.ts`
- Delete: `apps/web/lib/ratelimit.ts`

- [ ] **Step 1: Delete AI-only directories and files**

Run:

```bash
cd apps/web
rm -rf app/api/chat
rm -rf components/assistant-ui
rm components/workspace/editor/ai-drawer.tsx
rm hooks/use-document-context.ts
rm lib/ratelimit.ts
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "refactor: remove AI integration code"
```

Don't try to build yet — imports referencing these files are still in `provider.tsx`, `latex-editor.tsx`, `compile/route.ts`. The next tasks fix those.

---

### Task 3: Unwire AI from `provider.tsx` and `compile/route.ts`

**Files:**
- Modify: `apps/web/app/provider.tsx`
- Modify: `apps/web/app/api/compile/route.ts`

- [ ] **Step 1: Replace `provider.tsx` with AI-free version**

Overwrite `apps/web/app/provider.tsx` entirely with:

```tsx
"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

export function RootProvider({ children }: { children: ReactNode }) {
  useKeyboardShortcuts();

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      {children}
      <Toaster />
    </ThemeProvider>
  );
}
```

- [ ] **Step 2: Strip rate-limit guard from `compile/route.ts`**

In `apps/web/app/api/compile/route.ts`, delete lines 2 (`import { compileRatelimit, getIP } from "@/lib/ratelimit";`) and the entire `if (compileRatelimit) { ... }` block (lines 14–32 of the original file).

The file will still reference `resources` from request body — that's fine for now, we rewrite this route in Task 20.

- [ ] **Step 3: Remove AI imports from `latex-editor.tsx`**

In `apps/web/components/workspace/editor/latex-editor.tsx`, delete the line `import { AIDrawer } from "./ai-drawer";` and both `<AIDrawer />` JSX occurrences (inside the image-preview branch and the main return).

- [ ] **Step 4: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: No AI-related import errors. There may still be errors related to storage / document-store; those get fixed in later tasks. Note any errors that are *not* about AI for your own awareness but don't fix them yet.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/provider.tsx apps/web/app/api/compile/route.ts apps/web/components/workspace/editor/latex-editor.tsx
git commit -m "refactor: unwire AI providers and drawer"
```

---

### Task 4: Remove AI dependencies from package.json

**Files:**
- Modify: `apps/web/package.json`

- [ ] **Step 1: Remove AI packages**

In `apps/web/package.json`, delete these keys from `dependencies`:

- `@ai-sdk/openai`
- `@assistant-ui/react`
- `@assistant-ui/react-ai-sdk`
- `@assistant-ui/react-markdown`
- `@assistant-ui/store`
- `ai`
- `@upstash/ratelimit`
- `@upstash/redis`

Also remove `idb` — we're replacing IndexedDB storage. (The `storage/` dir still references it; it'll be deleted in Task 14.)

- [ ] **Step 2: Reinstall**

Run: `cd apps/web && pnpm install`
Expected: lockfile updates, `node_modules` shrinks. No install errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml ../../pnpm-lock.yaml
git commit -m "chore: drop AI and IndexedDB dependencies"
```

If there's only one lockfile path (monorepo root), adjust the `git add` accordingly — `git status` will show you which exists.

---

### Task 5: Update `.env.example` and README

**Files:**
- Modify: `apps/web/.env.example`
- Modify: `README.md` (project root)

- [ ] **Step 1: Rewrite `.env.example`**

Replace the entire contents of `apps/web/.env.example` with:

```
# Required — absolute or relative path to the directory containing your LaTeX project.
# Relative paths are resolved from apps/web/.
# Example: PROJECT_DIR=../../my-thesis
PROJECT_DIR=""

# Optional — URL of the latex-api service. Defaults to http://localhost:3001.
LATEX_API_URL=""
```

- [ ] **Step 2: Update root `README.md`**

Replace the "Quick Start" section of `README.md` (project root) with:

````markdown
## Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment
cp apps/web/.env.example apps/web/.env.local
# Edit apps/web/.env.local — set PROJECT_DIR to the directory of your LaTeX project.

# Start the LaTeX compiler service (in one terminal)
cd apps/latex-api && docker build -t latex-api . && docker run -p 3001:3001 latex-api

# Start the editor (in another terminal)
pnpm dev:web
```

Open http://localhost:3000 in a browser. Keep VS Code open on the same `PROJECT_DIR` — edits in either side flow to the other via filesystem watching.
````

Remove the "AI-Assisted Writing" bullet and the "Deployment → Vercel" section — they no longer apply.

- [ ] **Step 3: Commit**

```bash
git add apps/web/.env.example README.md
git commit -m "docs: document PROJECT_DIR env and local-run workflow"
```

---

## Phase 2 — Server-side filesystem layer (TDD)

### Task 6: `lib/fs/sandbox.ts` — path-resolver helper (TDD)

**Files:**
- Create: `apps/web/lib/fs/sandbox.ts`
- Test: `apps/web/lib/fs/sandbox.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/lib/fs/sandbox.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { resolveInProject } from "./sandbox";

const ROOT = "/home/user/project";

describe("resolveInProject", () => {
  test("accepts a simple relative filename", () => {
    expect(resolveInProject(ROOT, "main.tex")).toBe("/home/user/project/main.tex");
  });

  test("accepts a nested relative path", () => {
    expect(resolveInProject(ROOT, "chapters/intro.tex")).toBe(
      "/home/user/project/chapters/intro.tex",
    );
  });

  test("normalizes backslashes to forward slashes", () => {
    expect(resolveInProject(ROOT, "chapters\\intro.tex")).toBe(
      "/home/user/project/chapters/intro.tex",
    );
  });

  test("accepts explicit ./ prefix", () => {
    expect(resolveInProject(ROOT, "./main.tex")).toBe("/home/user/project/main.tex");
  });

  test("collapses legitimate internal traversal that stays in root", () => {
    expect(resolveInProject(ROOT, "chapters/../main.tex")).toBe(
      "/home/user/project/main.tex",
    );
  });

  test("rejects traversal escaping root", () => {
    expect(() => resolveInProject(ROOT, "../etc/passwd")).toThrow(/outside project/i);
  });

  test("rejects absolute POSIX path", () => {
    expect(() => resolveInProject(ROOT, "/etc/passwd")).toThrow(/absolute/i);
  });

  test("rejects absolute Windows-style path", () => {
    expect(() => resolveInProject(ROOT, "C:/Windows/System32")).toThrow(/absolute/i);
  });

  test("rejects empty path", () => {
    expect(() => resolveInProject(ROOT, "")).toThrow(/empty/i);
  });

  test("rejects whitespace-only path", () => {
    expect(() => resolveInProject(ROOT, "   ")).toThrow(/empty/i);
  });

  test("rejects a path containing null byte", () => {
    expect(() => resolveInProject(ROOT, "main.tex\u0000")).toThrow(/invalid/i);
  });

  test("returns root itself for empty-after-trim relative resolution of '.'", () => {
    expect(resolveInProject(ROOT, ".")).toBe("/home/user/project");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd apps/web && pnpm test sandbox`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `sandbox.ts`**

Create `apps/web/lib/fs/sandbox.ts`:

```ts
import path from "node:path";

/**
 * Resolve a user-supplied relative path against `projectRoot`.
 * Guarantees the resolved path lives inside `projectRoot`.
 *
 * Throws on absolute paths, paths containing null bytes, empty paths,
 * or paths that resolve outside `projectRoot` via traversal/symlink-escape
 * attempts.
 *
 * Callers must pass an absolute, already-resolved `projectRoot`.
 */
export function resolveInProject(
  projectRoot: string,
  userPath: string,
): string {
  if (userPath === null || userPath === undefined) {
    throw new Error("Path is empty");
  }

  if (userPath.includes("\u0000")) {
    throw new Error("Invalid path: contains null byte");
  }

  const trimmed = userPath.trim();
  if (trimmed.length === 0) {
    throw new Error("Path is empty");
  }

  // Normalize backslashes so Windows-style inputs work.
  const normalizedInput = trimmed.replace(/\\/g, "/");

  if (path.posix.isAbsolute(normalizedInput) || /^[a-zA-Z]:/.test(normalizedInput)) {
    throw new Error("Absolute paths are not allowed");
  }

  const normalizedRoot = projectRoot.replace(/\\/g, "/");
  const joined = path.posix.join(normalizedRoot, normalizedInput);
  const resolved = path.posix.normalize(joined);

  const rootWithSep = normalizedRoot.endsWith("/")
    ? normalizedRoot
    : `${normalizedRoot}/`;

  if (resolved !== normalizedRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error("Path resolves outside project root");
  }

  return resolved;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd apps/web && pnpm test sandbox`
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fs/sandbox.ts apps/web/lib/fs/sandbox.test.ts
git commit -m "feat(fs): add sandboxed path resolver"
```

Note: symlink-escape protection at the filesystem level is performed at call-sites via `fs.realpath` checks — this helper handles the textual path-resolution boundary only, which is what the tests cover. The API-route code in Task 11 adds the runtime realpath check.

---

### Task 7: `lib/fs/echo-suppression.ts` — write-echo tracker (TDD)

**Files:**
- Create: `apps/web/lib/fs/echo-suppression.ts`
- Test: `apps/web/lib/fs/echo-suppression.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/lib/fs/echo-suppression.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd apps/web && pnpm test echo-suppression`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `echo-suppression.ts`**

Create `apps/web/lib/fs/echo-suppression.ts`:

```ts
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd apps/web && pnpm test echo-suppression`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fs/echo-suppression.ts apps/web/lib/fs/echo-suppression.test.ts
git commit -m "feat(fs): add write-echo tracker for chokidar suppression"
```

---

### Task 8: `lib/fs/project-dir.ts` — env + `.openprism/` bootstrap

**Files:**
- Create: `apps/web/lib/fs/project-dir.ts`

- [ ] **Step 1: Implement**

Create `apps/web/lib/fs/project-dir.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

let cached: string | null = null;

/**
 * Returns the absolute, realpath-resolved PROJECT_DIR.
 * Validates on first call; throws a clear error if unset or missing.
 * Ensures `.openprism/` and `.openprism/.gitignore` exist.
 */
export function getProjectDir(): string {
  if (cached) return cached;

  const raw = process.env.PROJECT_DIR;
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      "PROJECT_DIR is not set. Add PROJECT_DIR=<path-to-your-latex-project> to apps/web/.env.local.",
    );
  }

  const resolved = path.resolve(raw.trim());

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `PROJECT_DIR does not exist: ${resolved}. Create the directory or fix the path in apps/web/.env.local.`,
    );
  }

  const stats = fs.statSync(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`PROJECT_DIR must be a directory: ${resolved}`);
  }

  // Resolve symlinks so all downstream comparisons work consistently.
  const real = fs.realpathSync(resolved).replace(/\\/g, "/");

  // Ensure .openprism/ exists with a .gitignore that hides its contents.
  const buildDir = path.posix.join(real, ".openprism");
  if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
  }
  const gitignore = path.posix.join(buildDir, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, "*\n", "utf8");
  }

  cached = real;
  return real;
}

export const BUILD_DIR_NAME = ".openprism";
export const EXCLUDED_DIRS = new Set([".git", "node_modules", BUILD_DIR_NAME]);
export const ALLOWED_EXTS = new Set([
  ".tex",
  ".bib",
  ".cls",
  ".sty",
  ".png",
  ".jpg",
  ".jpeg",
  ".pdf",
]);
export const TEXT_EXTS = new Set([".tex", ".bib", ".cls", ".sty"]);
```

- [ ] **Step 2: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit lib/fs/project-dir.ts`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/fs/project-dir.ts
git commit -m "feat(fs): add project-dir env loader and build-dir bootstrap"
```

---

### Task 9: `lib/fs/watcher.ts` — chokidar singleton + event bus

**Files:**
- Modify: `apps/web/package.json` (add chokidar)
- Create: `apps/web/lib/fs/watcher.ts`

- [ ] **Step 1: Add chokidar**

In `apps/web/package.json`, add to `dependencies`:

```json
"chokidar": "^4.0.3"
```

Run: `cd apps/web && pnpm install`

- [ ] **Step 2: Implement**

Create `apps/web/lib/fs/watcher.ts`:

```ts
import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import {
  ALLOWED_EXTS,
  BUILD_DIR_NAME,
  getProjectDir,
} from "./project-dir";
import { createEchoTracker } from "./echo-suppression";

export type FsEventType = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

export interface FsEvent {
  type: FsEventType;
  /** POSIX-style relative path from PROJECT_DIR. */
  path: string;
}

type Listener = (event: FsEvent) => void;

let watcher: FSWatcher | null = null;
const listeners = new Set<Listener>();
export const echo = createEchoTracker(100);

function toRelativePosix(absolutePath: string, projectDir: string): string {
  const rel = path.relative(projectDir, absolutePath).replace(/\\/g, "/");
  return rel;
}

function shouldEmit(type: FsEventType, relPath: string): boolean {
  // Never forward events from excluded dirs.
  const segments = relPath.split("/");
  if (segments.some((s) => s === ".git" || s === "node_modules" || s === BUILD_DIR_NAME)) {
    return false;
  }

  if (type === "addDir" || type === "unlinkDir") return true;

  const ext = path.extname(relPath).toLowerCase();
  return ALLOWED_EXTS.has(ext);
}

function getWatcher(): FSWatcher {
  if (watcher) return watcher;

  const projectDir = getProjectDir();
  watcher = chokidar.watch(projectDir, {
    ignored: (target) => {
      const rel = toRelativePosix(target, projectDir);
      if (rel === "") return false;
      const first = rel.split("/")[0];
      return first === ".git" || first === "node_modules" || first === BUILD_DIR_NAME;
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
  });

  const dispatch = (type: FsEventType) => (absPath: string) => {
    const absPathPosix = absPath.replace(/\\/g, "/");
    const rel = toRelativePosix(absPath, projectDir);
    if (!shouldEmit(type, rel)) return;
    if ((type === "add" || type === "change") && echo.shouldSuppress(absPathPosix)) return;
    const event: FsEvent = { type, path: rel };
    for (const listener of listeners) listener(event);
  };

  watcher.on("add", dispatch("add"));
  watcher.on("change", dispatch("change"));
  watcher.on("unlink", dispatch("unlink"));
  watcher.on("addDir", dispatch("addDir"));
  watcher.on("unlinkDir", dispatch("unlinkDir"));

  return watcher;
}

export function subscribe(listener: Listener): () => void {
  getWatcher();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: No errors in the new files. (Other files may still have errors from pending refactors.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml apps/web/lib/fs/watcher.ts
git commit -m "feat(fs): add chokidar watcher singleton with echo suppression"
```

---

### Task 10: `/api/fs/list` route

**Files:**
- Create: `apps/web/app/api/fs/list/route.ts`

- [ ] **Step 1: Implement the route**

Create `apps/web/app/api/fs/list/route.ts`:

```ts
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ALLOWED_EXTS,
  BUILD_DIR_NAME,
  EXCLUDED_DIRS,
  getProjectDir,
} from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";

export interface FsNode {
  path: string; // relative POSIX, e.g. "chapters/intro.tex"
  type: "file" | "dir";
  mtime: number; // ms since epoch
  children?: FsNode[];
}

async function walk(absDir: string, projectDir: string): Promise<FsNode[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const nodes: FsNode[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

    const absPath = path.join(absDir, entry.name);
    const relPath = path.relative(projectDir, absPath).replace(/\\/g, "/");
    const stat = await fs.stat(absPath);

    if (entry.isDirectory()) {
      const children = await walk(absPath, projectDir);
      if (children.length > 0) {
        nodes.push({
          path: relPath,
          type: "dir",
          mtime: stat.mtimeMs,
          children,
        });
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) continue;
      nodes.push({
        path: relPath,
        type: "file",
        mtime: stat.mtimeMs,
      });
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return nodes;
}

export async function GET() {
  try {
    const projectDir = getProjectDir();
    const tree = await walk(projectDir, projectDir);
    return NextResponse.json({ root: projectDir, tree });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Manual smoke test**

Set up a test project: create `c:/Git/Uni/OpenLaTex/tmp-test-project/main.tex` with `\documentclass{article}\begin{document}Hello\end{document}`, and `c:/Git/Uni/OpenLaTex/tmp-test-project/chapters/intro.tex` with any content.

Set `PROJECT_DIR=../../tmp-test-project` in `apps/web/.env.local` (create the file if absent).

Run: `cd apps/web && pnpm dev`
Open: http://localhost:3000/api/fs/list
Expected JSON shape:

```json
{
  "root": "c:/Git/Uni/OpenLaTex/tmp-test-project",
  "tree": [
    { "path": "chapters", "type": "dir", "mtime": ..., "children": [
      { "path": "chapters/intro.tex", "type": "file", "mtime": ... }
    ] },
    { "path": "main.tex", "type": "file", "mtime": ... }
  ]
}
```

Stop the dev server.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/fs/list/route.ts
git commit -m "feat(api): add GET /api/fs/list recursive tree"
```

---

### Task 11: `/api/fs/read` route

**Files:**
- Create: `apps/web/app/api/fs/read/route.ts`

- [ ] **Step 1: Implement**

Create `apps/web/app/api/fs/read/route.ts`:

```ts
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getProjectDir, TEXT_EXTS, ALLOWED_EXTS } from "@/lib/fs/project-dir";
import { resolveInProject } from "@/lib/fs/sandbox";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const userPath = url.searchParams.get("path");
    if (!userPath) {
      return NextResponse.json({ error: "Missing 'path' query parameter" }, { status: 400 });
    }

    const projectDir = getProjectDir();
    const absPath = resolveInProject(projectDir, userPath);

    // Guard against symlink escapes at runtime.
    const real = await fs.realpath(absPath);
    const realNormalized = real.replace(/\\/g, "/");
    const rootWithSep = projectDir.endsWith("/") ? projectDir : `${projectDir}/`;
    if (realNormalized !== projectDir && !realNormalized.startsWith(rootWithSep)) {
      return NextResponse.json({ error: "Path escapes project" }, { status: 400 });
    }

    const ext = path.extname(absPath).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return NextResponse.json({ error: "File type not allowed" }, { status: 400 });
    }

    const stat = await fs.stat(absPath);

    if (TEXT_EXTS.has(ext)) {
      const content = await fs.readFile(absPath, "utf8");
      return NextResponse.json({
        path: userPath,
        type: "text",
        content,
        mtime: stat.mtimeMs,
      });
    }

    const buf = await fs.readFile(absPath);
    const base64 = buf.toString("base64");
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".pdf"
            ? "application/pdf"
            : "application/octet-stream";
    return NextResponse.json({
      path: userPath,
      type: "binary",
      dataUrl: `data:${mime};base64,${base64}`,
      mtime: stat.mtimeMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const code = /outside|absolute|empty|invalid/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status: code });
  }
}
```

- [ ] **Step 2: Manual smoke test**

With `pnpm dev` running and `PROJECT_DIR` set:

- GET `/api/fs/read?path=main.tex` → JSON with `type: "text"` and `content` string
- GET `/api/fs/read?path=../etc/passwd` → 400 with error
- GET `/api/fs/read?path=nonexistent.tex` → 500 with ENOENT message

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/fs/read/route.ts
git commit -m "feat(api): add GET /api/fs/read with sandbox guard"
```

---

### Task 12: `/api/fs/write` route

**Files:**
- Create: `apps/web/app/api/fs/write/route.ts`

- [ ] **Step 1: Implement**

Create `apps/web/app/api/fs/write/route.ts`:

```ts
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getProjectDir, TEXT_EXTS } from "@/lib/fs/project-dir";
import { resolveInProject } from "@/lib/fs/sandbox";
import { echo } from "@/lib/fs/watcher";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  try {
    const url = new URL(req.url);
    const userPath = url.searchParams.get("path");
    if (!userPath) {
      return NextResponse.json({ error: "Missing 'path' query parameter" }, { status: 400 });
    }

    const projectDir = getProjectDir();
    const absPath = resolveInProject(projectDir, userPath);

    const ext = path.extname(absPath).toLowerCase();
    if (!TEXT_EXTS.has(ext)) {
      return NextResponse.json({ error: "Only text files can be written" }, { status: 400 });
    }

    const body = await req.text();

    // Ensure parent exists.
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    // Record the write before it lands so the watcher can suppress the echo.
    echo.recordWrite(absPath);

    await fs.writeFile(absPath, body, "utf8");

    const stat = await fs.stat(absPath);
    return NextResponse.json({ path: userPath, mtime: stat.mtimeMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const code = /outside|absolute|empty|invalid|only text/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status: code });
  }
}
```

- [ ] **Step 2: Manual smoke test**

With `pnpm dev` running:

```bash
curl -X PUT "http://localhost:3000/api/fs/write?path=test-write.tex" \
  --data-binary "hello from curl"
```

Verify the file appears on disk under `PROJECT_DIR` with the expected contents. Delete it after.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/fs/write/route.ts
git commit -m "feat(api): add PUT /api/fs/write with echo recording"
```

---

### Task 13: `/api/fs/watch` SSE route

**Files:**
- Create: `apps/web/app/api/fs/watch/route.ts`

- [ ] **Step 1: Implement**

Create `apps/web/app/api/fs/watch/route.ts`:

```ts
import { subscribe, type FsEvent } from "@/lib/fs/watcher";
import { getProjectDir } from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";
// Long-lived; disable Next.js route buffering.
export const fetchCache = "force-no-store";

export async function GET() {
  // Ensure project dir is validated and watcher initialized before we start the stream.
  getProjectDir();

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();

      const send = (event: { type: string; payload?: unknown }) => {
        const data = `event: ${event.type}\ndata: ${JSON.stringify(event.payload ?? {})}\n\n`;
        controller.enqueue(enc.encode(data));
      };

      // Initial hello so the client knows the stream is alive.
      send({ type: "ready", payload: {} });

      const unsubscribe = subscribe((fsEvent: FsEvent) => {
        send({ type: "fs", payload: fsEvent });
      });

      // Heartbeat every 15s to keep proxies from closing idle connections.
      const heartbeat = setInterval(() => {
        controller.enqueue(enc.encode(`: heartbeat\n\n`));
      }, 15000);

      // Close hook — bound via AbortSignal on the request if available.
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Next.js signals cancellation via stream cancel.
      (controller as unknown as { __cleanup?: () => void }).__cleanup = cleanup;
    },
    cancel() {
      const self = this as unknown as { __cleanup?: () => void };
      self.__cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 2: Manual smoke test**

With `pnpm dev` running:

```bash
curl -N http://localhost:3000/api/fs/watch
```

You should see `event: ready` immediately, then a `event: fs` line whenever you touch a `.tex` file in `PROJECT_DIR`. Edit a file externally to verify events come through. Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/fs/watch/route.ts
git commit -m "feat(api): add GET /api/fs/watch SSE stream"
```

---

## Phase 3 — Client-side filesystem layer

### Task 14: `lib/fs/fs-client.ts` typed wrappers

**Files:**
- Create: `apps/web/lib/fs/fs-client.ts`

- [ ] **Step 1: Implement**

Create `apps/web/lib/fs/fs-client.ts`:

```ts
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
```

- [ ] **Step 2: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: No errors in `lib/fs/fs-client.ts`. (Other errors remain.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/fs/fs-client.ts
git commit -m "feat(fs): add typed client wrappers for fs api"
```

---

### Task 15: `lib/fs/fs-watcher-client.ts` EventSource with reconnect

**Files:**
- Create: `apps/web/lib/fs/fs-watcher-client.ts`

- [ ] **Step 1: Implement**

Create `apps/web/lib/fs/fs-watcher-client.ts`:

```ts
export type FsEventType = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

export interface FsEvent {
  type: FsEventType;
  path: string;
}

export type FsListener = (event: FsEvent) => void;
export type StatusListener = (status: "connecting" | "connected" | "disconnected") => void;

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 5000];

export interface FsWatcherHandle {
  close(): void;
}

export function startFsWatcher(
  onEvent: FsListener,
  onStatus?: StatusListener,
): FsWatcherHandle {
  let source: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    onStatus?.("connecting");
    source = new EventSource("/api/fs/watch");

    source.addEventListener("ready", () => {
      attempt = 0;
      onStatus?.("connected");
    });

    source.addEventListener("fs", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as FsEvent;
        onEvent(data);
      } catch (e) {
        console.warn("Invalid fs event", e);
      }
    });

    source.onerror = () => {
      if (closed) return;
      source?.close();
      source = null;
      onStatus?.("disconnected");
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
      source = null;
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/lib/fs/fs-watcher-client.ts
git commit -m "feat(fs): add client-side EventSource watcher with reconnect"
```

---

## Phase 4 — Zustand store split

### Task 16: `stores/fs-store.ts`

**Files:**
- Create: `apps/web/stores/fs-store.ts`

- [ ] **Step 1: Implement**

Create `apps/web/stores/fs-store.ts`:

```ts
import { create } from "zustand";
import type { FsNode } from "@/lib/fs/fs-client";
import { listFiles } from "@/lib/fs/fs-client";
import type { FsEvent } from "@/lib/fs/fs-watcher-client";

interface FsState {
  root: string | null;
  tree: FsNode[];
  loading: boolean;
  error: string | null;

  loadTree: () => Promise<void>;
  applyEvent: (event: FsEvent) => void;
}

/** Walk the tree and collect every file path for flat lookups. */
export function flattenFiles(tree: FsNode[]): string[] {
  const out: string[] = [];
  const stack = [...tree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === "file") out.push(node.path);
    else if (node.children) stack.push(...node.children);
  }
  return out;
}

function addNodeToTree(tree: FsNode[], newNode: FsNode): FsNode[] {
  const segments = newNode.path.split("/");
  if (segments.length === 1) {
    if (tree.some((n) => n.path === newNode.path)) return tree;
    return [...tree, newNode].sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
  }

  const [firstSegment, ...rest] = segments;
  const parentPath = firstSegment;
  return tree.map((node) => {
    if (node.path === parentPath && node.type === "dir") {
      const updatedChildren = addNodeToTree(node.children ?? [], {
        ...newNode,
        path: rest.join("/") === "" ? newNode.path : newNode.path,
      });
      return { ...node, children: updatedChildren };
    }
    return node;
  });
}

function removeFromTree(tree: FsNode[], targetPath: string): FsNode[] {
  const result: FsNode[] = [];
  for (const node of tree) {
    if (node.path === targetPath) continue;
    if (node.type === "dir" && targetPath.startsWith(`${node.path}/`)) {
      const children = removeFromTree(node.children ?? [], targetPath);
      result.push({ ...node, children });
    } else {
      result.push(node);
    }
  }
  return result;
}

export const useFsStore = create<FsState>((set) => ({
  root: null,
  tree: [],
  loading: false,
  error: null,

  async loadTree() {
    set({ loading: true, error: null });
    try {
      const { root, tree } = await listFiles();
      set({ root, tree, loading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to list files";
      set({ error: message, loading: false });
    }
  },

  applyEvent(event) {
    set((state) => {
      if (event.type === "unlink" || event.type === "unlinkDir") {
        return { tree: removeFromTree(state.tree, event.path) };
      }

      if (event.type === "add" || event.type === "addDir") {
        const isDir = event.type === "addDir";
        const newNode: FsNode = {
          path: event.path,
          type: isDir ? "dir" : "file",
          mtime: Date.now(),
          ...(isDir ? { children: [] } : {}),
        };
        return { tree: addNodeToTree(state.tree, newNode) };
      }

      // change — just bump mtime
      return {
        tree: bumpMtime(state.tree, event.path),
      };
    });
  },
}));

function bumpMtime(tree: FsNode[], targetPath: string): FsNode[] {
  return tree.map((node) => {
    if (node.path === targetPath) return { ...node, mtime: Date.now() };
    if (node.type === "dir" && targetPath.startsWith(`${node.path}/`)) {
      return { ...node, children: bumpMtime(node.children ?? [], targetPath) };
    }
    return node;
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/stores/fs-store.ts
git commit -m "feat(store): add fs-store for tree state and watcher events"
```

Note: `addNodeToTree` for deeply nested new files is simplified — the next `loadTree` call after reconnect self-heals any structural mismatch. This is intentional; we don't need perfect incremental updates since the watcher-reconnect path is the safety net.

---

### Task 17: `stores/editor-store.ts`

**Files:**
- Create: `apps/web/stores/editor-store.ts`

- [ ] **Step 1: Implement**

Create `apps/web/stores/editor-store.ts`:

```ts
import { create } from "zustand";
import { readFile, writeFile } from "@/lib/fs/fs-client";

const WRITE_DEBOUNCE_MS = 300;

interface EditorState {
  activePath: string | null;
  /** Kind of the active file — "text" means editable in CodeMirror. */
  activeKind: "text" | "binary" | null;
  /** Current in-editor buffer for text files. */
  buffer: string;
  /** Data URL for binary previews. */
  activeDataUrl: string | null;
  /** True while a local edit is queued to be written. Used to gate watcher reloads. */
  writePending: boolean;
  loading: boolean;
  loadError: string | null;
  saveError: string | null;

  openFile: (path: string) => Promise<void>;
  closeFile: () => void;
  setBuffer: (next: string) => void;
  /** Called by the fs-watcher when the active file changed externally. */
  reloadFromDisk: () => Promise<void>;
  /** Called by the fs-watcher when the active file was deleted externally. */
  handleExternalDelete: () => void;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

async function flushWrite(get: () => EditorState, set: (p: Partial<EditorState>) => void) {
  const { activePath, buffer, activeKind } = get();
  if (!activePath || activeKind !== "text") {
    set({ writePending: false });
    return;
  }
  try {
    await writeFile(activePath, buffer);
    set({ saveError: null, writePending: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Save failed";
    set({ saveError: message, writePending: false });
  }
}

export const useEditorStore = create<EditorState>((set, get) => ({
  activePath: null,
  activeKind: null,
  buffer: "",
  activeDataUrl: null,
  writePending: false,
  loading: false,
  loadError: null,
  saveError: null,

  async openFile(path) {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
      await flushWrite(get, (p) => set(p));
    }

    set({
      activePath: path,
      activeKind: null,
      buffer: "",
      activeDataUrl: null,
      loading: true,
      loadError: null,
    });

    try {
      const res = await readFile(path);
      if (res.type === "text") {
        set({ activeKind: "text", buffer: res.content, loading: false });
      } else {
        set({ activeKind: "binary", activeDataUrl: res.dataUrl, loading: false });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open file";
      set({ loadError: message, loading: false });
    }
  },

  closeFile() {
    set({
      activePath: null,
      activeKind: null,
      buffer: "",
      activeDataUrl: null,
      writePending: false,
    });
  },

  setBuffer(next) {
    set({ buffer: next, writePending: true });
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flushWrite(get, (p) => set(p));
    }, WRITE_DEBOUNCE_MS);
  },

  async reloadFromDisk() {
    const { activePath, writePending } = get();
    if (!activePath) return;
    if (writePending) return; // skip — our pending write will land after
    try {
      const res = await readFile(activePath);
      if (res.type === "text") set({ buffer: res.content });
      else set({ activeDataUrl: res.dataUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reload file";
      set({ loadError: message });
    }
  },

  handleExternalDelete() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    set({
      activePath: null,
      activeKind: null,
      buffer: "",
      activeDataUrl: null,
      writePending: false,
    });
  },
}));
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/stores/editor-store.ts
git commit -m "feat(store): add editor-store with debounced write-through"
```

---

### Task 18: `stores/pdf-store.ts`

**Files:**
- Create: `apps/web/stores/pdf-store.ts`

- [ ] **Step 1: Implement**

Create `apps/web/stores/pdf-store.ts`:

```ts
import { create } from "zustand";

interface PdfState {
  pdfData: Uint8Array | null;
  compileError: string | null;
  isCompiling: boolean;

  setPdfData: (data: Uint8Array | null) => void;
  setCompileError: (error: string | null) => void;
  setIsCompiling: (value: boolean) => void;
}

export const usePdfStore = create<PdfState>((set) => ({
  pdfData: null,
  compileError: null,
  isCompiling: false,

  setPdfData: (data) => set({ pdfData: data, compileError: null }),
  setCompileError: (error) => set({ compileError: error, pdfData: null }),
  setIsCompiling: (value) => set({ isCompiling: value }),
}));
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/stores/pdf-store.ts
git commit -m "feat(store): add pdf-store for compile output state"
```

---

### Task 19: Delete the old document-store and IndexedDB storage

**Files:**
- Delete: `apps/web/stores/document-store.ts`
- Delete: `apps/web/lib/storage/` (directory)
- Delete: `apps/web/hooks/use-storage-ready.ts`

- [ ] **Step 1: Delete**

```bash
cd apps/web
rm stores/document-store.ts
rm -rf lib/storage
rm hooks/use-storage-ready.ts
```

- [ ] **Step 2: Type-check (expected to fail loudly)**

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: Errors in `sidebar.tsx`, `latex-editor.tsx`, `pdf-preview.tsx`, `workspace-layout.tsx`, `use-project-init.ts` — all referencing the deleted store.

Record this list of errors — the next tasks fix each file. **Do not commit yet** (build is broken).

- [ ] **Step 3: Keep going — no commit at this step**

The next tasks restore a buildable state. Continue to Task 20.

---

## Phase 5 — UI refactor

### Task 20: New file-tree component

**Files:**
- Create: `apps/web/components/workspace/sidebar/file-tree.tsx`

Note: the sidebar currently lives at `apps/web/components/workspace/sidebar.tsx` (a flat file). We'll keep the new tree component in a new `sidebar/` subdirectory and move the sidebar file into it in Task 21.

- [ ] **Step 1: Implement**

Create `apps/web/components/workspace/sidebar/file-tree.tsx`:

```tsx
"use client";

import { useState } from "react";
import { ChevronRightIcon, FileTextIcon, FolderIcon, ImageIcon } from "lucide-react";
import type { FsNode } from "@/lib/fs/fs-client";
import { cn } from "@/lib/utils";

interface FileTreeProps {
  nodes: FsNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
}

export function FileTree({ nodes, activePath, onOpen }: FileTreeProps) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

function iconFor(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return <ImageIcon className="size-4 shrink-0 text-muted-foreground" />;
  }
  return <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />;
}

interface TreeNodeProps {
  node: FsNode;
  depth: number;
  activePath: string | null;
  onOpen: (path: string) => void;
}

function TreeNode({ node, depth, activePath, onOpen }: TreeNodeProps) {
  const [open, setOpen] = useState(depth < 1);
  const name = node.path.split("/").pop() ?? node.path;
  const paddingLeft = depth * 12 + 8;

  if (node.type === "dir") {
    return (
      <li>
        <button
          className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-sm hover:bg-sidebar-accent/50"
          style={{ paddingLeft }}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{name}</span>
        </button>
        {open && node.children && node.children.length > 0 && (
          <ul className="space-y-0.5">
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                onOpen={onOpen}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isActive = node.path === activePath;
  return (
    <li>
      <button
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm transition-colors",
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "hover:bg-sidebar-accent/50",
        )}
        style={{ paddingLeft: paddingLeft + 18 /* indent past the chevron */ }}
        onClick={() => onOpen(node.path)}
      >
        {iconFor(node.path)}
        <span className="truncate">{name}</span>
      </button>
    </li>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/components/workspace/sidebar/file-tree.tsx
git commit -m "feat(ui): add recursive file-tree component"
```

---

### Task 21: Rewrite sidebar to use file-tree

**Files:**
- Move: `apps/web/components/workspace/sidebar.tsx` → `apps/web/components/workspace/sidebar/sidebar.tsx`
- Modify: `apps/web/components/workspace/workspace-layout.tsx` (import path)

- [ ] **Step 1: Create the new sidebar**

Create `apps/web/components/workspace/sidebar/sidebar.tsx`:

```tsx
"use client";

import { useCallback, useMemo } from "react";
import {
  FolderIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ListIcon,
  HashIcon,
  GithubIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useFsStore } from "@/stores/fs-store";
import { useEditorStore } from "@/stores/editor-store";
import { Button } from "@/components/ui/button";
import { FileTree } from "./file-tree";
import packageJson from "@/package.json";

interface TocItem {
  level: number;
  title: string;
  line: number;
}

function parseTableOfContents(content: string): TocItem[] {
  const lines = content.split("\n");
  const toc: TocItem[] = [];
  const sectionRegex =
    /\\(section|subsection|subsubsection|chapter|part)\*?\s*\{([^}]*)\}/;
  const levelMap: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 2,
    subsection: 3,
    subsubsection: 4,
  };

  lines.forEach((line, index) => {
    const match = line.match(sectionRegex);
    if (match) {
      const [, type, title] = match;
      toc.push({
        level: levelMap[type] ?? 2,
        title: title.trim(),
        line: index + 1,
      });
    }
  });
  return toc;
}

export function Sidebar() {
  const tree = useFsStore((s) => s.tree);
  const root = useFsStore((s) => s.root);
  const activePath = useEditorStore((s) => s.activePath);
  const buffer = useEditorStore((s) => s.buffer);
  const activeKind = useEditorStore((s) => s.activeKind);
  const openFile = useEditorStore((s) => s.openFile);
  const { theme, setTheme } = useTheme();

  const toc = useMemo(
    () => (activeKind === "text" ? parseTableOfContents(buffer) : []),
    [buffer, activeKind],
  );

  const rootName = useMemo(() => {
    if (!root) return "Project";
    const parts = root.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? "Project";
  }, [root]);

  const handleTocClick = useCallback((_line: number) => {
    // Wired later when we add position-jumping in the editor; for now no-op.
  }, []);

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-12 items-center border-sidebar-border border-b px-3">
        <div className="flex flex-col">
          <span className="font-semibold text-sm">OpenPrism</span>
          <span className="text-muted-foreground text-xs truncate">{rootName}</span>
        </div>
      </div>

      <div className="flex h-9 items-center justify-between border-sidebar-border border-b px-3">
        <div className="flex items-center gap-2">
          <FolderIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-xs">Files</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <FileTree nodes={tree} activePath={activePath} onOpen={openFile} />
      </div>

      <div className="flex h-9 items-center gap-2 border-sidebar-border border-t px-3">
        <ListIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-xs">Outline</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {toc.length > 0 ? (
          toc.map((item, index) => (
            <button
              key={index}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50"
              style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
              onClick={() => handleTocClick(item.line)}
            >
              <HashIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{item.title}</span>
            </button>
          ))
        ) : (
          <div className="px-2 py-1 text-muted-foreground text-xs">No sections found</div>
        )}
      </div>

      <div className="flex items-center justify-between border-sidebar-border border-t px-3 py-2 text-muted-foreground text-xs">
        <span>OpenPrism v{packageJson.version}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-6" asChild>
            <a
              href="https://github.com/assistant-ui/open-prism"
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub"
            >
              <GithubIcon className="size-3.5" />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => {
              if (theme === "system") setTheme("light");
              else if (theme === "light") setTheme("dark");
              else setTheme("system");
            }}
            title={
              theme === "system" ? "System theme" : theme === "light" ? "Light mode" : "Dark mode"
            }
          >
            {theme === "system" ? (
              <MonitorIcon className="size-3.5" />
            ) : theme === "light" ? (
              <SunIcon className="size-3.5" />
            ) : (
              <MoonIcon className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Delete the old sidebar**

```bash
rm apps/web/components/workspace/sidebar.tsx
```

- [ ] **Step 3: Update the import in `workspace-layout.tsx`**

In `apps/web/components/workspace/workspace-layout.tsx`, change line 4:

```tsx
import { Sidebar } from "./sidebar";
```

to:

```tsx
import { Sidebar } from "./sidebar/sidebar";
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/workspace/sidebar apps/web/components/workspace/workspace-layout.tsx apps/web/components/workspace/sidebar.tsx
git commit -m "refactor(ui): rewrite sidebar around fs-store file tree"
```

(The `sidebar.tsx` deletion is captured by `git add`'s `-A` behavior since we're adding everything in the dir. If git shows it as untracked, use `git rm apps/web/components/workspace/sidebar.tsx` instead.)

---

### Task 22: Refactor `latex-editor.tsx` — write-through + watcher reload

**Files:**
- Modify: `apps/web/components/workspace/editor/latex-editor.tsx`

This is the biggest single edit in the plan. Read the current file first for context.

- [ ] **Step 1: Remove Enter-to-compile and switch state source to new stores**

Replace the imports and the top of `LatexEditor` to reference `useEditorStore` instead of `useDocumentStore`. Keep all the sticky-line parsing / search / highlighting code — those are independent of storage.

Overwrite `apps/web/components/workspace/editor/latex-editor.tsx` with:

```tsx
"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  scrollPastEnd,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewlineAndIndent,
} from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { oneDark, oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import {
  search,
  highlightSelectionMatches,
  SearchQuery,
  setSearchQuery as setSearchQueryEffect,
  findNext,
  findPrevious,
} from "@codemirror/search";
import { latex } from "codemirror-lang-latex";
import { useEditorStore } from "@/stores/editor-store";
import { EditorToolbar } from "./editor-toolbar";
import { ImagePreview } from "./image-preview";
import { LatexTools } from "./latex-tools";
import { SearchPanel } from "./search-panel";

interface StickyItem {
  type: "section" | "begin";
  name: string;
  content: string;
  html: string;
  line: number;
}

interface ParsedLine {
  type: "section" | "begin" | "end";
  name: string;
  content: string;
  line: number;
}

function parseLatexStructure(content: string): ParsedLine[] {
  const lines = content.split("\n");
  const result: ParsedLine[] = [];
  const sectionRegex = /\\(part|chapter|section|subsection|subsubsection)\*?\s*\{[^}]*\}/;
  const beginRegex = /\\begin\{([^}]+)\}/;
  const endRegex = /\\end\{([^}]+)\}/;

  lines.forEach((lineContent, index) => {
    const sectionMatch = lineContent.match(sectionRegex);
    if (sectionMatch) {
      result.push({ type: "section", name: sectionMatch[1], content: lineContent, line: index + 1 });
      return;
    }
    const beginMatch = lineContent.match(beginRegex);
    if (beginMatch) {
      result.push({ type: "begin", name: beginMatch[1], content: lineContent, line: index + 1 });
      return;
    }
    const endMatch = lineContent.match(endRegex);
    if (endMatch) {
      result.push({ type: "end", name: endMatch[1], content: lineContent, line: index + 1 });
    }
  });
  return result;
}

function getStickyLines(parsedLines: ParsedLine[], currentLine: number): StickyItem[] {
  const stack: StickyItem[] = [];
  const sectionLevelMap: Record<string, number> = {
    part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4,
  };

  for (const item of parsedLines) {
    if (item.line > currentLine) break;
    if (item.type === "section") {
      const level = sectionLevelMap[item.name] ?? 2;
      while (
        stack.length > 0 &&
        stack[stack.length - 1].type === "section" &&
        sectionLevelMap[stack[stack.length - 1].name] >= level
      ) {
        stack.pop();
      }
      stack.push({ type: "section", name: item.name, content: item.content, html: "", line: item.line });
    } else if (item.type === "begin") {
      stack.push({ type: "begin", name: item.name, content: item.content, html: "", line: item.line });
    } else if (item.type === "end") {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].type === "begin" && stack[i].name === item.name) {
          stack.splice(i, 1);
          break;
        }
      }
    }
  }
  return stack;
}

export function LatexEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const activePath = useEditorStore((s) => s.activePath);
  const activeKind = useEditorStore((s) => s.activeKind);
  const buffer = useEditorStore((s) => s.buffer);
  const activeDataUrl = useEditorStore((s) => s.activeDataUrl);
  const loading = useEditorStore((s) => s.loading);
  const setBuffer = useEditorStore((s) => s.setBuffer);

  const isTexFile = activeKind === "text";

  const [imageScale, setImageScale] = useState(0.5);
  const [currentLine, setCurrentLine] = useState(1);
  const [gutterWidth, setGutterWidth] = useState(0);
  const [lineHtmlCache, setLineHtmlCache] = useState<Record<number, string>>({});
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);

  const parsedLines = useMemo(() => parseLatexStructure(buffer), [buffer]);
  const stickyLines = useMemo(() => {
    const items = getStickyLines(parsedLines, currentLine);
    return items.map((item) => ({ ...item, html: lineHtmlCache[item.line] || "" }));
  }, [parsedLines, currentLine, lineHtmlCache]);

  const isSearchOpenRef = useRef(false);
  useEffect(() => { isSearchOpenRef.current = isSearchOpen; }, [isSearchOpen]);

  useEffect(() => {
    if (!searchQuery || !buffer) {
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }
    const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const matches = buffer.match(regex);
    setMatchCount(matches?.length ?? 0);
    setCurrentMatch(matches && matches.length > 0 ? 1 : 0);
  }, [searchQuery, buffer]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const query = new SearchQuery({ search: searchQuery, caseSensitive: false, literal: true });
    view.dispatch({ effects: setSearchQueryEffect.of(query) });
    if (searchQuery) findNext(view);
  }, [searchQuery]);

  const handleFindNext = () => {
    const view = viewRef.current;
    if (!view) return;
    findNext(view);
    view.focus();
  };
  const handleFindPrevious = () => {
    const view = viewRef.current;
    if (!view) return;
    findPrevious(view);
    view.focus();
  };

  useEffect(() => {
    if (!containerRef.current || !isTexFile) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        setBuffer(update.state.doc.toString());
      }
    });

    const scrollListener = EditorView.domEventHandlers({
      scroll: (_, view) => {
        const scrollTop = view.scrollDOM.scrollTop;
        const lineBlock = view.lineBlockAtHeight(scrollTop);
        const lineNumber = view.state.doc.lineAt(lineBlock.from).number;
        setCurrentLine(lineNumber);

        const gutter = view.dom.querySelector(".cm-gutters");
        if (gutter) setGutterWidth(gutter.getBoundingClientRect().width);

        const cmLines = view.dom.querySelectorAll(".cm-line");
        const newCache: Record<number, string> = {};
        cmLines.forEach((el) => {
          const lineInfo = view.lineBlockAt(view.posAtDOM(el as HTMLElement, 0));
          const ln = view.state.doc.lineAt(lineInfo.from).number;
          newCache[ln] = el.innerHTML;
        });
        setLineHtmlCache((prev) => ({ ...prev, ...newCache }));
      },
    });

    const editorKeymap = Prec.highest(
      keymap.of([
        {
          key: "Enter",
          run: (view) => {
            if (isSearchOpenRef.current) {
              findNext(view);
              return true;
            }
            return insertNewlineAndIndent(view);
          },
        },
        {
          key: "Shift-Enter",
          run: (view) => {
            if (isSearchOpenRef.current) {
              findPrevious(view);
              return true;
            }
            return false;
          },
        },
        {
          key: "Mod-f",
          run: () => { setIsSearchOpen(true); return true; },
        },
        {
          key: "Escape",
          run: () => {
            if (isSearchOpenRef.current) {
              setIsSearchOpen(false);
              return true;
            }
            return false;
          },
        },
      ]),
    );

    const state = EditorState.create({
      doc: buffer,
      extensions: [
        editorKeymap,
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        latex(),
        oneDark,
        syntaxHighlighting(oneDarkHighlightStyle),
        search(),
        highlightSelectionMatches(),
        updateListener,
        scrollListener,
        EditorView.lineWrapping,
        scrollPastEnd(),
        EditorView.theme({
          "&": { height: "100%", fontSize: "14px" },
          ".cm-scroller": { overflow: "auto" },
          ".cm-gutters": { paddingRight: "4px" },
          ".cm-lineNumbers .cm-gutterElement": { paddingLeft: "8px", paddingRight: "4px" },
          ".cm-content": { paddingLeft: "8px", paddingRight: "12px" },
          ".cm-searchMatch": {
            backgroundColor: "#facc15 !important",
            color: "#000 !important",
            borderRadius: "2px",
            boxShadow: "0 0 0 1px #eab308",
          },
          ".cm-searchMatch-selected": {
            backgroundColor: "#f97316 !important",
            color: "#fff !important",
            borderRadius: "2px",
            boxShadow: "0 0 0 2px #ea580c",
          },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            backgroundColor: "rgba(100, 150, 255, 0.3)",
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activePath, isTexFile, setBuffer]);

  // Sync external buffer changes (e.g. watcher-driven reload) into CodeMirror.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isTexFile) return;
    const currentContent = view.state.doc.toString();
    if (currentContent !== buffer) {
      const prevSelection = view.state.selection.main;
      const newLen = buffer.length;
      const clampedAnchor = Math.min(prevSelection.anchor, newLen);
      view.dispatch({
        changes: { from: 0, to: currentContent.length, insert: buffer },
        selection: { anchor: clampedAnchor },
      });
    }
  }, [buffer, isTexFile]);

  if (!activePath) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-background text-muted-foreground text-sm">
        Select a file from the sidebar to start editing.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-background text-muted-foreground text-sm">
        Loading {activePath}…
      </div>
    );
  }

  if (activeKind === "binary") {
    return (
      <div className="flex h-full flex-col bg-background">
        <EditorToolbar
          editorView={viewRef}
          fileType="image"
          imageScale={imageScale}
          onImageScaleChange={setImageScale}
        />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {activeDataUrl && (
            <ImagePreview
              file={{ id: activePath, name: activePath, type: "image", dataUrl: activeDataUrl }}
              scale={imageScale}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <EditorToolbar editorView={viewRef} />
      {isSearchOpen && (
        <SearchPanel
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onClose={() => {
            setIsSearchOpen(false);
            setSearchQuery("");
            viewRef.current?.focus();
          }}
          onFindNext={handleFindNext}
          onFindPrevious={handleFindPrevious}
          matchCount={matchCount}
          currentMatch={currentMatch}
        />
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {stickyLines.length > 0 && (
          <div className="absolute inset-x-0 top-0 z-10 border-border border-b bg-[#282c34] font-mono text-[14px] leading-[1.4] shadow-md">
            {stickyLines.map((section) => (
              <div
                key={section.line}
                className="flex cursor-pointer items-center hover:bg-white/5"
                onClick={() => {
                  const view = viewRef.current;
                  if (!view) return;
                  const line = view.state.doc.line(section.line);
                  view.dispatch({
                    selection: { anchor: line.from },
                    effects: EditorView.scrollIntoView(line.from, { y: "start" }),
                  });
                  view.focus();
                }}
              >
                <span
                  className="shrink-0 bg-[#282c34] py-px text-right text-[#636d83]"
                  style={{ width: gutterWidth ? gutterWidth - 8 : 32 }}
                >
                  {section.line}
                </span>
                {section.html ? (
                  <span className="py-px pl-5.5" dangerouslySetInnerHTML={{ __html: section.html }} />
                ) : (
                  <span className="py-px pl-5.5 text-[#abb2bf]">{section.content}</span>
                )}
              </div>
            ))}
          </div>
        )}
        <div ref={containerRef} className="absolute inset-0" />
      </div>
      <LatexTools />
    </div>
  );
}
```

Removed from the original: `ProjectFile` import, `compileLatex` import, `AIDrawer` import, `gatherResources` helper, `compileRef`, the Enter-triggered `compileRef.current()` call, the `Mod-s` fake save shortcut, `useDocumentStore` references, `jumpToPosition` wiring (no current caller; re-add later if needed), image-preview `ProjectFile` adapter (the new shape is derived on the fly).

- [ ] **Step 2: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: Errors remaining in `pdf-preview.tsx` and `workspace-layout.tsx`. The editor file should be clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/workspace/editor/latex-editor.tsx
git commit -m "refactor(editor): write-through to disk, drop Enter-to-compile"
```

---

### Task 23: Refactor `pdf-preview.tsx`

**Files:**
- Modify: `apps/web/components/workspace/preview/pdf-preview.tsx`

- [ ] **Step 1: Rewrite**

Overwrite `apps/web/components/workspace/preview/pdf-preview.tsx` with:

```tsx
"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import {
  FileTextIcon,
  AlertCircleIcon,
  LoaderIcon,
  RefreshCwIcon,
  MinusIcon,
  PlusIcon,
  DownloadIcon,
} from "lucide-react";
import { usePdfStore } from "@/stores/pdf-store";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { compileLatex } from "@/lib/latex-compiler";

const ZOOM_OPTIONS = [
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
  { value: "4", label: "400%" },
];

const PdfViewer = dynamic(() => import("./pdf-viewer").then((mod) => mod.PdfViewer), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <LoaderIcon className="size-6 animate-spin text-muted-foreground" />
    </div>
  ),
});

export function PdfPreview() {
  const pdfData = usePdfStore((s) => s.pdfData);
  const compileError = usePdfStore((s) => s.compileError);
  const isCompiling = usePdfStore((s) => s.isCompiling);
  const setPdfData = usePdfStore((s) => s.setPdfData);
  const setCompileError = usePdfStore((s) => s.setCompileError);
  const setIsCompiling = usePdfStore((s) => s.setIsCompiling);

  const [pdfError, setPdfError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [scale, setScale] = useState<number>(1.0);

  const zoomIn = () => setScale((s) => Math.min(4, s + 0.1));
  const zoomOut = () => setScale((s) => Math.max(0.25, s - 0.1));

  const handleDownload = () => {
    if (!pdfData) return;
    const blob = new Blob([new Uint8Array(pdfData)], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "document.pdf";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCompile = async () => {
    if (isCompiling) return;
    setIsCompiling(true);
    setPdfError(null);
    try {
      const data = await compileLatex();
      setPdfData(data);
    } catch (error) {
      setCompileError(error instanceof Error ? error.message : "Compilation failed");
    } finally {
      setIsCompiling(false);
    }
  };

  const renderContent = () => {
    if (compileError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <AlertCircleIcon className="mb-4 size-12 text-destructive" />
          <h2 className="mb-2 font-medium text-destructive text-lg">Compilation Error</h2>
          <pre className="max-w-xl whitespace-pre-wrap text-center text-muted-foreground text-xs">
            {compileError}
          </pre>
        </div>
      );
    }

    if (!pdfData) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <FileTextIcon className="mb-4 size-16 text-muted-foreground/50" />
          <h2 className="mb-2 font-medium text-lg text-muted-foreground">PDF Preview</h2>
          <p className="text-center text-muted-foreground text-sm">
            Edit a file or click Compile to build your document.
          </p>
        </div>
      );
    }

    if (pdfError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <AlertCircleIcon className="mb-4 size-12 text-destructive" />
          <h2 className="mb-2 font-medium text-destructive text-lg">PDF Load Error</h2>
          <p className="max-w-md text-center text-muted-foreground text-sm">{pdfError}</p>
        </div>
      );
    }

    return (
      <PdfViewer
        data={pdfData}
        scale={scale}
        onError={setPdfError}
        onLoadSuccess={setNumPages}
        onScaleChange={setScale}
        onTextClick={() => {}}
      />
    );
  };

  return (
    <div className="flex h-full flex-col bg-muted/50">
      <div className="flex h-9 items-center justify-between border-border border-b bg-background px-2">
        <div className="flex items-center gap-1.5">
          {isCompiling ? (
            <>
              <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground text-xs">Compiling…</span>
            </>
          ) : pdfData ? (
            <>
              <span className="text-muted-foreground text-xs">Ready</span>
              <Button variant="ghost" size="icon" className="size-6" onClick={handleCompile}>
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </>
          ) : compileError ? (
            <>
              <span className="text-destructive text-xs">Error</span>
              <Button variant="ghost" size="icon" className="size-6" onClick={handleCompile}>
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="icon" className="size-6" onClick={handleCompile}>
              <RefreshCwIcon className="size-3.5" />
            </Button>
          )}
        </div>

        {pdfData && (
          <div className="flex items-center gap-0.5">
            <span className="mr-2 text-muted-foreground text-xs">
              {numPages} {numPages === 1 ? "page" : "pages"}
            </span>
            <Button variant="ghost" size="icon" className="size-6" onClick={zoomOut} disabled={scale <= 0.25}>
              <MinusIcon className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="size-6" onClick={zoomIn} disabled={scale >= 4}>
              <PlusIcon className="size-3.5" />
            </Button>
            <Select value={scale.toString()} onValueChange={(v) => setScale(Number(v))}>
              <SelectTrigger size="sm" className="h-6! w-auto text-xs">
                <SelectValue>{Math.round(scale * 100)}%</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ZOOM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="mx-0.5 h-4 w-px bg-border" />
            <Button variant="ghost" size="icon" className="size-6" onClick={handleDownload} title="Download PDF">
              <DownloadIcon className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {renderContent()}
    </div>
  );
}
```

Removed: the `gatherResources` helper, all `useDocumentStore` references, the initial-compile effect (startup orchestration moves to `use-fs-startup.ts` in Task 26), the `onTextClick`→`requestJumpToPosition` wiring (re-add later if needed).

- [ ] **Step 2: Commit**

```bash
git add apps/web/components/workspace/preview/pdf-preview.tsx
git commit -m "refactor(preview): consume pdf-store and compile-from-disk api"
```

---

## Phase 6 — Compile pipeline rewire

### Task 24: Rewrite `/api/compile` to read from disk

**Files:**
- Modify: `apps/web/app/api/compile/route.ts`

- [ ] **Step 1: Overwrite**

Overwrite `apps/web/app/api/compile/route.ts` with:

```ts
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ALLOWED_EXTS,
  BUILD_DIR_NAME,
  EXCLUDED_DIRS,
  TEXT_EXTS,
  getProjectDir,
} from "@/lib/fs/project-dir";
import { echo } from "@/lib/fs/watcher";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

interface CompileResource {
  path: string;
  content?: string;
  file?: string;
  main?: boolean;
}

/** Walk PROJECT_DIR and return every .tex/.bib/.cls/.sty/image as a resource. */
async function gatherResources(projectDir: string): Promise<CompileResource[]> {
  const out: CompileResource[] = [];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const absPath = path.join(dir, entry.name);
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTS.has(ext)) continue;
        const relPath = path.relative(projectDir, absPath).replace(/\\/g, "/");

        if (TEXT_EXTS.has(ext)) {
          const content = await fs.readFile(absPath, "utf8");
          out.push({
            path: relPath,
            content,
            main: relPath === "main.tex",
          });
        } else {
          const buf = await fs.readFile(absPath);
          out.push({ path: relPath, file: buf.toString("base64") });
        }
      }
    }
  }

  await walk(projectDir);

  // If no file is named main.tex, mark the first .tex as main.
  if (!out.some((r) => r.main)) {
    const firstTex = out.find((r) => r.path.endsWith(".tex"));
    if (firstTex) firstTex.main = true;
  }

  return out;
}

export async function POST() {
  try {
    const projectDir = getProjectDir();
    const resources = await gatherResources(projectDir);

    if (resources.length === 0) {
      return NextResponse.json(
        { error: "No LaTeX sources found under PROJECT_DIR" },
        { status: 400 },
      );
    }

    const latexApiUrl = process.env.LATEX_API_URL || "http://localhost:3001";
    const response = await fetch(`${latexApiUrl}/builds/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ compiler: "pdflatex", resources }),
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || contentType.includes("application/json")) {
      const errorData = await response.json().catch(() => ({}));
      const logContent = errorData.log_files?.["__main_document__.log"] ?? "";
      const errorLines = logContent
        .split("\n")
        .filter((line: string) =>
          line.includes("Error") || line.includes("!") || line.includes("Missing"),
        )
        .slice(0, 10)
        .join("\n");
      return NextResponse.json(
        {
          error: `Compilation failed: ${errorData.error || response.statusText}`,
          details: errorLines || logContent.slice(-1000),
        },
        { status: 500 },
      );
    }

    const pdfBuffer = Buffer.from(await response.arrayBuffer());

    // Persist to .openprism/out.pdf so next startup can show it instantly.
    // Use path.posix.join so the path matches the POSIX-normalized keys the echo tracker uses.
    const outPath = path.posix.join(projectDir, BUILD_DIR_NAME, "out.pdf");
    echo.recordWrite(outPath); // prevent the watcher from forwarding our own write
    await fs.writeFile(outPath, pdfBuffer);

    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=document.pdf",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown compilation error";
    console.error("Compile error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/api/compile/route.ts
git commit -m "refactor(api): rewrite /api/compile to source from disk and cache pdf"
```

---

### Task 25: Update `lib/latex-compiler.ts` client helper

**Files:**
- Modify: `apps/web/lib/latex-compiler.ts`

- [ ] **Step 1: Overwrite**

Overwrite `apps/web/lib/latex-compiler.ts` with:

```ts
export async function compileLatex(): Promise<Uint8Array> {
  const response = await fetch("/api/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data.details
      ? `${data.error}\n\n${data.details}`
      : data.error || "Compilation failed";
    throw new Error(message);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/lib/latex-compiler.ts
git commit -m "refactor(compile): drop resources arg; server pulls from disk"
```

---

## Phase 7 — Startup & wiring

### Task 26: `hooks/use-fs-startup.ts` + cached-PDF route

This task implements the startup bootstrap that either loads the cached PDF from disk (if fresh) or triggers a compile, then connects the filesystem watcher and wires debounced auto-compile.

**Files:**
- Create: `apps/web/app/api/pdf/cached/route.ts`
- Create: `apps/web/hooks/use-fs-startup.ts`
- Delete: `apps/web/hooks/use-project-init.ts`

- [ ] **Step 1: Delete the old init hook**

```bash
rm apps/web/hooks/use-project-init.ts
```

- [ ] **Step 2: Implement the cached-PDF route**

Create `apps/web/app/api/pdf/cached/route.ts`:

```ts
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ALLOWED_EXTS,
  BUILD_DIR_NAME,
  EXCLUDED_DIRS,
  getProjectDir,
} from "@/lib/fs/project-dir";

export const dynamic = "force-dynamic";

async function maxSourceMtime(projectDir: string): Promise<number> {
  let max = 0;
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTS.has(ext)) continue;
        const stat = await fs.stat(path.join(dir, entry.name));
        if (stat.mtimeMs > max) max = stat.mtimeMs;
      }
    }
  }
  await walk(projectDir);
  return max;
}

/**
 * GET /api/pdf/cached
 * Returns the cached PDF if its mtime is >= every source file's mtime.
 * Returns 404 if no cache exists or the cache is stale.
 */
export async function GET() {
  try {
    const projectDir = getProjectDir();
    const pdfPath = path.posix.join(projectDir, BUILD_DIR_NAME, "out.pdf");

    let pdfStat;
    try {
      pdfStat = await fs.stat(pdfPath);
    } catch {
      return NextResponse.json({ error: "No cached PDF" }, { status: 404 });
    }

    const newestSource = await maxSourceMtime(projectDir);
    if (pdfStat.mtimeMs < newestSource) {
      return NextResponse.json({ error: "Cached PDF is stale" }, { status: 404 });
    }

    const buf = await fs.readFile(pdfPath);
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=document.pdf",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Implement the hook**

Create `apps/web/hooks/use-fs-startup.ts`:

```ts
"use client";

import { useEffect, useRef } from "react";
import { useFsStore, flattenFiles } from "@/stores/fs-store";
import { useEditorStore } from "@/stores/editor-store";
import { usePdfStore } from "@/stores/pdf-store";
import { startFsWatcher, type FsEvent } from "@/lib/fs/fs-watcher-client";
import { compileLatex } from "@/lib/latex-compiler";

const COMPILE_DEBOUNCE_MS = 500;

export function useFsStartup() {
  const loadTree = useFsStore((s) => s.loadTree);
  const applyEvent = useFsStore((s) => s.applyEvent);
  const openFile = useEditorStore((s) => s.openFile);
  const startedRef = useRef(false);
  const compileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const scheduleCompile = () => {
      if (compileTimerRef.current) clearTimeout(compileTimerRef.current);
      compileTimerRef.current = setTimeout(async () => {
        const pdf = usePdfStore.getState();
        if (pdf.isCompiling) return;
        pdf.setIsCompiling(true);
        try {
          const data = await compileLatex();
          pdf.setPdfData(data);
        } catch (error) {
          pdf.setCompileError(error instanceof Error ? error.message : "Compile failed");
        } finally {
          pdf.setIsCompiling(false);
        }
      }, COMPILE_DEBOUNCE_MS);
    };

    (async () => {
      await loadTree();
      const { tree } = useFsStore.getState();
      const files = flattenFiles(tree);

      // Auto-select main.tex if present, else the first .tex file we find.
      const main =
        files.find((p) => p === "main.tex") ?? files.find((p) => p.endsWith(".tex"));
      if (main) await openFile(main);

      // Try to load the cached PDF first. If fresh, show it immediately.
      // If 404 (stale or missing), fall back to a fresh compile.
      const pdf = usePdfStore.getState();
      try {
        const res = await fetch("/api/pdf/cached", { cache: "no-store" });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          pdf.setPdfData(new Uint8Array(buf));
          return;
        }
      } catch {
        // ignore — fall through to compile
      }
      scheduleCompile();
    })();

    const handler = (event: FsEvent) => {
      applyEvent(event);

      const editor = useEditorStore.getState();
      if (editor.activePath && event.path === editor.activePath) {
        if (event.type === "unlink") editor.handleExternalDelete();
        else if (event.type === "change" || event.type === "add") editor.reloadFromDisk();
      }

      // Any watched-file change → recompile.
      if (
        event.type === "add" ||
        event.type === "change" ||
        event.type === "unlink"
      ) {
        scheduleCompile();
      }
    };

    const handle = startFsWatcher(handler, (status) => {
      if (status === "connected") {
        // Resync tree after reconnect in case we missed events.
        loadTree();
      }
    });

    return () => {
      handle.close();
      if (compileTimerRef.current) clearTimeout(compileTimerRef.current);
    };
  }, [applyEvent, loadTree, openFile]);
}
```

- [ ] **Step 4: Also compile when the user's own buffer write lands**

The watcher will emit a `change` event for our own writes, but echo-suppression drops it — so the `scheduleCompile` call for external events won't fire for local typing.

To recompile after user edits, subscribe to editor-store changes. Add this effect at the bottom of `useFsStartup`, before the `return` cleanup:

Replace the final `return () => { ... }` block with:

```ts
    const unsubEditor = useEditorStore.subscribe((state, prev) => {
      if (state.writePending !== prev.writePending && prev.writePending && !state.writePending) {
        // write just flushed to disk → compile (echo-suppressed, so watcher won't)
        scheduleCompile();
      }
    });

    return () => {
      handle.close();
      unsubEditor();
      if (compileTimerRef.current) clearTimeout(compileTimerRef.current);
    };
  }, [applyEvent, loadTree, openFile]);
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/pdf/cached/route.ts apps/web/hooks/use-fs-startup.ts apps/web/hooks/use-project-init.ts
git commit -m "feat: add cached-pdf route and use-fs-startup bootstrap"
```

---

### Task 27: Wire `use-fs-startup` into `workspace-layout.tsx`

**Files:**
- Modify: `apps/web/components/workspace/workspace-layout.tsx`

- [ ] **Step 1: Overwrite**

Overwrite `apps/web/components/workspace/workspace-layout.tsx` with:

```tsx
"use client";

import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Sidebar } from "./sidebar/sidebar";
import { LatexEditor } from "./editor/latex-editor";
import { PdfPreview } from "./preview/pdf-preview";
import { useFsStartup } from "@/hooks/use-fs-startup";

export function WorkspaceLayout() {
  useFsStartup();

  return (
    <PanelGroup direction="horizontal" className="h-full">
      <Panel defaultSize={15} minSize={10} maxSize={25}>
        <Sidebar />
      </Panel>

      <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

      <Panel defaultSize={42.5} minSize={25}>
        <LatexEditor />
      </Panel>

      <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

      <Panel defaultSize={42.5} minSize={25}>
        <PdfPreview />
      </Panel>
    </PanelGroup>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Build**

Run: `cd apps/web && pnpm build`
Expected: Build succeeds. Any errors in this step are blockers — fix before proceeding.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/workspace/workspace-layout.tsx
git commit -m "feat(ui): wire filesystem startup into workspace layout"
```

---

### Task 28: Metadata, strings, and minor polish

**Files:**
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/page.tsx` (if needed)

- [ ] **Step 1: Update metadata strings**

In `apps/web/app/layout.tsx`, change the `metadata` export:

```tsx
export const metadata: Metadata = {
  title: "OpenPrism — Local LaTeX Editor",
  description: "Filesystem-backed LaTeX editor with live preview.",
};
```

No other changes needed in this file.

- [ ] **Step 2: Verify `app/page.tsx`**

Open `apps/web/app/page.tsx`. It should already be:

```tsx
"use client";

import { WorkspaceLayout } from "@/components/workspace/workspace-layout";

export default function Home() {
  return (
    <main className="h-full">
      <WorkspaceLayout />
    </main>
  );
}
```

No changes needed.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/layout.tsx
git commit -m "chore: update page metadata"
```

---

## Phase 8 — Documentation

### Task 29: Write the manual test plan

**Files:**
- Create: `docs/manual-test-plan.md`

- [ ] **Step 1: Create the document**

Create `docs/manual-test-plan.md`:

```markdown
# Manual Test Plan — Local LaTeX Editor

Run this checklist after any significant change. Takes ~10 minutes.

## Setup

1. Have a test LaTeX project at a known path with at least:
   - `main.tex` containing a `\documentclass{...}` + `\begin{document}...\end{document}`
   - `chapters/intro.tex` containing any LaTeX content (used via `\input{chapters/intro}`)
   - At least one image under `images/` referenced via `\includegraphics`
2. `apps/web/.env.local` sets `PROJECT_DIR` to that path.
3. `latex-api` is running on port 3001.
4. Start the editor: `pnpm dev:web`.

## Checklist

- [ ] **1. Tree renders.** Open http://localhost:3000. The sidebar shows `main.tex`, the `chapters/` folder, and the `images/` folder. Subdirectories expand on click.
- [ ] **2. Text file opens.** Click `main.tex`. Buffer loads in the editor within ~1s. No console errors.
- [ ] **3. Local edits write through.** Type a change in `main.tex`. Wait ~500ms. In a second terminal run `cat <PROJECT_DIR>/main.tex` — your change is on disk.
- [ ] **4. External edit auto-reloads.** In a second terminal, `echo '% hi' >> <PROJECT_DIR>/main.tex`. Within ~1s, the editor shows the appended line. Cursor stays on the same line number (approximately).
- [ ] **5. Claude-style multi-file edit.** In a second terminal, simultaneously modify `main.tex` and `chapters/intro.tex` with `sed -i 's/.*/&/' main.tex && sed -i 's/.*/&/' chapters/intro.tex`. The preview rebuilds once after both settle (not twice).
- [ ] **6. External create.** `echo '\\section{New}' > <PROJECT_DIR>/chapters/new.tex`. The file appears in the sidebar tree within ~1s.
- [ ] **7. External delete.** `rm <PROJECT_DIR>/chapters/new.tex`. The file disappears from the tree. If it was the active file, the editor switches to the "select a file" placeholder.
- [ ] **8. Syntax error.** Introduce a LaTeX syntax error (e.g. unclosed brace). The preview pane shows the previous successful PDF, and the compile-error indicator surfaces the pdflatex log.
- [ ] **9. latex-api down.** Stop the `latex-api` container. Edit a file. The preview shows a compile error with a message referencing the latex-api URL. Restart latex-api and re-compile via the refresh button; PDF returns.
- [ ] **10. Dev-server restart (fresh cache).** Kill `pnpm dev:web` and restart immediately. The tree re-populates, the cached `.openprism/out.pdf` loads instantly (no "Compiling…" spinner), the watcher reconnects.
- [ ] **10b. Dev-server restart (stale cache).** Kill `pnpm dev:web`, then `touch <PROJECT_DIR>/main.tex` to make a source newer than the cached PDF, restart. On load the preview shows "Compiling…" and rebuilds — confirming the staleness check works.
- [ ] **11. Git integration.** In VS Code with the same folder open, every edit done by the editor shows up in the Source Control panel. Discard-changes in VS Code triggers a watcher event, reloading the editor's buffer.

If any step fails, fix before merging.
```

- [ ] **Step 2: Commit**

```bash
git add docs/manual-test-plan.md
git commit -m "docs: add manual test plan"
```

---

### Task 30: Final smoke test & final commit

**Files:** none

- [ ] **Step 1: Run all unit tests**

Run: `cd apps/web && pnpm test`
Expected: 18 tests pass (12 sandbox + 6 echo).

- [ ] **Step 2: Run the type-checker**

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run the linter**

Run: `pnpm lint`
Expected: No errors. (Warnings are fine; fix if trivial.)

- [ ] **Step 4: Walk through the manual test plan**

Open `docs/manual-test-plan.md` and go through every checklist item. If any fail, create a follow-up task; don't claim done until all green.

- [ ] **Step 5: Review git log**

Run: `git log --oneline --no-merges`
Expected: ~30 focused commits. If any commits bundle unrelated changes, that's fine — no need to rewrite history.

---

## Post-plan considerations (out of scope here, for future)

- `renames` and `move` operations inside the editor UI
- Pausing auto-compile for large/slow projects
- Component tests for editor and sidebar (add if project becomes multi-user)
- `usePolling: true` chokidar fallback for network filesystems
- Restoring PDF text-click → editor jump-to-position (currently stubbed in `pdf-preview.tsx`)
- Restoring file-upload drag-and-drop into the sidebar (if desired)
