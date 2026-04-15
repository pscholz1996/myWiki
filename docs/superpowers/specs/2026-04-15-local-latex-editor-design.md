# Local LaTeX Editor — Design Spec

**Date:** 2026-04-15
**Status:** Approved
**Fork base:** [open-prism](https://github.com/assistant-ui/open-prism) (MIT)

## Purpose

Convert the forked open-prism web app from an AI-assisted, browser-storage-backed LaTeX editor into a **local filesystem-backed LaTeX editor** that runs alongside VS Code on the same `.tex` project. The editor reads and writes real files on disk, auto-reloads when external tools (Claude CLI, VS Code) edit those files, and lets VS Code's built-in Git integration handle version control without the editor participating.

All AI integration is removed.

## Goals

1. Edit a multi-file LaTeX project whose files live on disk in a configured project directory.
2. Every change in the editor is written to disk within a short debounce window.
3. Every external change to a watched file is reflected in the editor automatically.
4. The PDF preview auto-rebuilds whenever any source file changes.
5. The compiled PDF lives on disk so other tools can open it.
6. VS Code's Git panel sees every edit the editor makes, with no special integration on our side.

## Non-goals

- AI features, chat UI, or any OpenAI/assistant-ui integration — removed entirely.
- Multi-project management. One project per dev-server instance.
- Rate limiting, hosted deployment concerns, Upstash/Redis.
- Rename/move/delete from inside the editor UI — do that in VS Code.
- Binary file editing. Images and PDFs are read-only.
- Concurrent-tab coordination. Opening the same project in two browser tabs is undefined behavior.
- Test coverage beyond the two modules where a bug would be genuinely painful.

## Architecture

Two processes are started by `pnpm dev`:

```
┌──────────────────────────────────────────────────────────┐
│ Browser (Next.js client)                                 │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │
│  │ File tree  │  │ CodeMirror │  │ PDF preview        │ │
│  └─────┬──────┘  └─────┬──────┘  └─────────▲──────────┘ │
│        │               │                   │            │
│        │     Zustand: fs-store (tree)      │            │
│        │             editor-store (buffer) │            │
│        │             pdf-store (bytes)     │            │
└────────┼───────────────┼───────────────────┼────────────┘
         │ fetch()       │ fetch() debounced │ fetch() after
         │               │ write-through     │ compile
         │          SSE stream               │
         │    ◄─────────────────────         │
         ▼               ▼                   ▼
┌──────────────────────────────────────────────────────────┐
│ Next.js server (apps/web) — rooted at PROJECT_DIR        │
│                                                          │
│  /api/fs/list   /api/fs/read   /api/fs/write             │
│  /api/fs/watch  (SSE; chokidar watching PROJECT_DIR)     │
│  /api/compile   (proxies to latex-api, writes PDF to     │
│                   PROJECT_DIR/.openprism/out.pdf)        │
└──────────────────┬───────────────────────────────────────┘
                   │ POST /compile (sources)
                   ▼
┌──────────────────────────────────────────────────────────┐
│ latex-api (apps/latex-api, Hono) — unchanged             │
│   spawns pdflatex, returns PDF bytes                     │
└──────────────────────────────────────────────────────────┘
```

### Invariants

1. **Disk is the source of truth.** The client never holds state that isn't on disk within ~300ms of being edited.
2. **`PROJECT_DIR` is a sandbox.** Every FS API route resolves paths against `PROJECT_DIR` and rejects anything that escapes.
3. **`.openprism/` is the build directory** inside `PROJECT_DIR`. The compiled PDF, pdflatex aux/log files, and a `.gitignore` containing `*` live there. Created on first run.
4. **latex-api is untouched.** No changes to `apps/latex-api/`.

### Configuration

- `PROJECT_DIR` env var — required, absolute or relative path to the LaTeX project root. Server refuses to start if unset or if the directory doesn't exist.
- Documented in `apps/web/.env.example` with a commented example (e.g. `PROJECT_DIR=../../my-latex-project`). User copies it to `apps/web/.env.local` and sets the value.
- No other user-facing configuration in this iteration.

## Components

### New — FS API routes in `apps/web/app/api/fs/`

- **`list/route.ts`** — `GET /api/fs/list`. Walks `PROJECT_DIR` recursively. Returns a tree of `{ path, type: "file"|"dir", mtime }`. Filters by extension allowlist: `.tex`, `.bib`, `.cls`, `.sty`, `.png`, `.jpg`, `.jpeg`, `.pdf`. Excludes directories: `.git/`, `node_modules/`, `.openprism/`.
- **`read/route.ts`** — `GET /api/fs/read?path=<relative>`. Returns file content: UTF-8 string for text files, base64 data URL for images and PDFs. Rejects paths outside `PROJECT_DIR`.
- **`write/route.ts`** — `PUT /api/fs/write?path=<relative>`. Writes the UTF-8 request body to disk. Creates parent directories if needed. Rejects paths outside `PROJECT_DIR`. Rejects binary file types.
- **`watch/route.ts`** — `GET /api/fs/watch`. Server-Sent Events stream of `{ type: "add"|"change"|"unlink", path }` events from a module-scoped chokidar watcher.

### New — Shared helper in `apps/web/lib/fs/`

- **`sandbox.ts`** — pure function `resolveInProject(userPath: string): string | Error`. Takes a user-supplied relative path, resolves against `PROJECT_DIR`, rejects traversal (`..`), absolute paths, and symlink escapes. Every FS API route uses it.
- **`echo-suppression.ts`** — pure module implementing a `Set<string>` of paths we just wrote, auto-cleared 100ms later. `recordWrite(path)` called by `write/route.ts`; `shouldSuppress(path)` called by `watch/route.ts` before emitting events.
- **`fs-client.ts`** — typed client-side wrappers around the four API routes.
- **`fs-watcher-client.ts`** — EventSource connection to `/api/fs/watch` with reconnect and backoff. Dispatches events to the stores.

### Replaced — Storage layer

- [apps/web/lib/storage/indexeddb-storage.ts](apps/web/lib/storage/indexeddb-storage.ts) — **deleted**.
- [apps/web/stores/document-store.ts](apps/web/stores/document-store.ts) — split into three focused Zustand stores in `apps/web/stores/`:
  - **`fs-store.ts`** — tree of files on disk (`path`, `type`, `mtime`). Populated from `/api/fs/list` on startup; mutated by watcher events.
  - **`editor-store.ts`** — active file path, CodeMirror buffer contents, debounced write-through to `/api/fs/write`.
  - **`pdf-store.ts`** — current PDF bytes in memory. Persistence handled by writing the PDF to disk after compile; re-loaded from disk on startup.
- `idb` dependency removed from `apps/web/package.json`.

### Modified — Compile route

- [apps/web/app/api/compile/route.ts](apps/web/app/api/compile/route.ts) — no longer accepts a resources payload from the client. Instead, reads the project files from `PROJECT_DIR`, forwards them to the unchanged latex-api, writes the returned PDF bytes to `PROJECT_DIR/.openprism/out.pdf`, streams them back in the response.

### Modified — Editor and preview

- [apps/web/components/workspace/editor/latex-editor.tsx](apps/web/components/workspace/editor/latex-editor.tsx) — remove the Enter-to-compile behavior. Every buffer change triggers a debounced (300ms) write to disk. Listens for watcher events on the active file; if the event is not an echo and there is no pending local write (debounce timer not armed), reloads the buffer from disk, preserving cursor `(line, col)`.
- [apps/web/components/workspace/preview/pdf-preview.tsx](apps/web/components/workspace/preview/pdf-preview.tsx) — consumes `pdf-store` instead of `document-store`. Otherwise unchanged.
- **New** `apps/web/components/workspace/sidebar/file-tree.tsx` — recursive `<TreeNode>` renderer backed by `fs-store`. Replaces the current flat-list sidebar component. No external tree library.

### Deleted — AI surface

- `apps/web/app/api/chat/route.ts`
- `apps/web/components/assistant-ui/` (entire directory)
- `apps/web/components/workspace/editor/ai-drawer.tsx`
- `apps/web/hooks/use-document-context.ts`
- `apps/web/lib/ratelimit.ts`
- [apps/web/app/provider.tsx](apps/web/app/provider.tsx) loses `AssistantRuntimeProvider`; becomes a thin pass-through or is deleted and `app/page.tsx` renders children directly.
- Dependencies removed from `apps/web/package.json`: `@ai-sdk/openai`, `@assistant-ui/react`, `@assistant-ui/react-ai-sdk`, `@assistant-ui/react-markdown`, `@assistant-ui/store`, `ai`, `@upstash/ratelimit`, `@upstash/redis`.
- Env vars removed from `apps/web/.env.example`: `OPENAI_API_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`.

### Unchanged

- `apps/latex-api/` — zero changes.
- CodeMirror configuration, PDF.js rendering setup, theming, routing.

## Data flow

### Scenario A — user types in the editor

1. CodeMirror fires `onChange`. `editor-store` stores the new buffer in memory immediately.
2. A 300ms debounce timer starts; additional keystrokes reset it.
3. Timer fires: `PUT /api/fs/write?path=<active>` with the buffer body.
4. Server calls `recordWrite(path)` before writing, then writes via `fs/promises.writeFile`.
5. Chokidar emits a `change` event. The SSE handler calls `shouldSuppress(path)`, sees the echo, and drops the event.
6. A separate 500ms **compile debounce** fires: the client calls `/api/compile`, receives PDF bytes, updates `pdf-store`. Preview re-renders.

### Scenario B — Claude CLI edits a `.tex` file

1. Claude writes `chapters/intro.tex`.
2. Chokidar emits `change` → SSE handler checks `shouldSuppress` → not suppressed → event reaches client.
3. `fs-store` updates the file's mtime.
4. If the changed file is the active editor file:
   - If editor buffer already matches disk: no-op.
   - If editor has an in-flight write (debounce timer armed): **skip reload**. Our pending write will land after Claude's. Last-write-wins.
   - Otherwise: reload CodeMirror buffer from `/api/fs/read`, preserve cursor `(line, col)`, clamp to EOF if file shrunk.
5. Compile debounce fires → recompile → PDF updates.

### Scenario C — Claude creates or deletes a file

1. Chokidar emits `add` or `unlink`.
2. `fs-store` adds or removes the tree node.
3. If a deleted file was active, editor switches to "no file open" state.
4. Compile debounce fires.

### Echo suppression

`lib/fs/echo-suppression.ts` maintains a `Set<string>` of paths we just wrote, cleared 100ms after insertion. 100ms is long enough to outlast the chokidar roundtrip, short enough that a real external edit immediately afterward is not lost. `/api/fs/write` calls `recordWrite`; `/api/fs/watch` calls `shouldSuppress`.

### Startup sequence

1. Server reads `PROJECT_DIR` from env. Fatal error if unset or directory missing.
2. Creates `PROJECT_DIR/.openprism/` and `.openprism/.gitignore` (`*`) if absent.
3. Starts chokidar watcher on `PROJECT_DIR` with the excludes from above.
4. Client calls `/api/fs/list`, populates `fs-store`.
5. Client checks `.openprism/out.pdf`: if mtime ≥ every source file's mtime, load into `pdf-store` for instant preview; otherwise trigger a compile.
6. Client opens SSE to `/api/fs/watch`.
7. If `editor-store` has no active file, show a "select a file" placeholder in the editor pane.

## Error handling

### Filesystem errors

- **Permission denied / file not found**: API route returns `404` or `403` with JSON error. Client shows a `sonner` toast. `fs-store` refreshes on next watcher event; tree self-heals.
- **Path escape attempt**: sandbox helper errors, route returns `400`, logged server-side.
- **Disk full on write**: `500` with OS error message, toast shown, editor buffer retained in memory for retry.

### Watcher errors

- **SSE disconnect**: client shows a small "reconnecting…" indicator, retries with 1s/2s/5s backoff. On reconnect, re-fetches `/api/fs/list` and diffs into `fs-store`.
- **Chokidar error** (e.g., `EMFILE`): server logs, emits an `error` SSE event. Client shows a persistent banner. User restarts dev server. No auto-recovery attempt.

### Compile errors

- **LaTeX compilation failure**: log surfaced in a collapsible "Build output" panel under the preview. Preview keeps showing the previous successful PDF. No toast — too noisy.
- **latex-api unreachable**: compile route returns `502`. Toast: "LaTeX compiler service is not running. Start it with `pnpm dev:latex-api`." Preview shows a "build failed" placeholder.
- **Compile timeout**: handled by latex-api's existing timeout. Surfaced as a compile failure.

### Startup errors

- **`PROJECT_DIR` unset or missing**: server refuses to start, prints actionable message naming the file to edit (`apps/web/.env.local`) and the key to set.
- **`.openprism/` cannot be created** (read-only FS): server errors clearly and exits.

### Editor state

- **Active file deleted externally**: editor switches to empty state. Any unsaved keystrokes are discarded — this is consistent with the "disk wins" policy.
- **Active file content reloaded mid-edit**: cursor restored by `(line, col)`; clamped to EOF if file shrunk. CodeMirror handles this gracefully.

## Testing

The codebase has no existing test infrastructure. We add minimal testing focused on the two modules where a bug would genuinely hurt.

### Unit tests (Vitest)

Add `vitest` as a dev dependency to `apps/web`. Minimal config. Two test files:

1. **`lib/fs/sandbox.test.ts`** — covers the security boundary. Test cases:
   - Legitimate nested paths resolve correctly.
   - `..` traversal rejected.
   - Absolute paths rejected.
   - Symlink that escapes `PROJECT_DIR` rejected.
   - Windows backslash paths handled.
   - Empty / whitespace / null paths rejected.
   (~15 assertions total)

2. **`lib/fs/echo-suppression.test.ts`** — covers the UX invariant. Uses Vitest fake timers. Test cases:
   - Write followed by event within 100ms → suppressed.
   - Event 101ms after write → not suppressed.
   - Real external event with no preceding write → not suppressed.
   - Concurrent writes to different paths → don't interfere.
   (~6 assertions total)

### Manual verification

A `docs/manual-test-plan.md` with a numbered checklist run before merging significant changes:

1. Start the app pointed at a test project. File tree renders.
2. Click a `.tex` file. Buffer loads. Edit. After 300ms, verify file changed on disk via a second shell.
3. Edit the file externally with `sed`. Editor auto-reloads within ~1s; cursor line preserved.
4. Have Claude CLI edit a chapter file while typing in a different file. Preview rebuilds after both settle.
5. Delete a file with `rm`. Tree updates; editor handles active-file-deleted case.
6. Introduce a LaTeX syntax error. Preview keeps previous PDF; build log surfaces the error.
7. Stop `latex-api`. Edit a file. Toast appears with the correct message.
8. Restart the dev server mid-session. SSE reconnects; tree stays in sync.

### What we deliberately don't test

- Component tests for the editor — mocking CodeMirror, chokidar, SSE, and Zustand has high setup cost for modest value in a single-user tool.
- End-to-end tests with Playwright — overkill for this scope.
- API route wiring tests — the sandbox test covers the security-critical path; the remaining wiring is thin over `fs/promises`.

If this ever becomes a shared tool, component tests are the first thing to add.
