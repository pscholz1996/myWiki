# Contributing to OpenLaTex

## Development Environment

### Requirements

- Node.js 20+
- pnpm 10+
- Git (for git integration features)
- TeX Live **or** Docker (for the latex-api compiler service)

### Setup

```bash
# Clone the repository
git clone https://github.com/xTazah/OpenLatex.git
cd OpenLaTex

# Install dependencies
pnpm install

Open http://localhost:3000 after starting the editor. On first run, the welcome screen
lets you paste or browse to a LaTeX project folder. Your choice is saved to
`~/.openlatex/config.json` and remembered across restarts.

(Optional) To pre-configure a project directory without using the UI, copy the
environment file and set `PROJECT_DIR`:

```bash
cp apps/web/.env.example apps/web/.env.local
# Set PROJECT_DIR=C:/path/to/your/latex-project in .env.local
```

This bootstraps the config on first run only; once `~/.openlatex/config.json` exists,
`PROJECT_DIR` is ignored.
```

### Running the LaTeX compiler

**Option A — Docker (recommended):**

```bash
cd apps/latex-api
docker build -t latex-api .
docker run -p 3001:3001 latex-api
```

**Option B — Local TeX Live:**

```bash
cd apps/latex-api
pnpm dev
```

Requires `pdflatex` on your PATH.

### Starting the editor

```bash
pnpm dev:web
```

Open [http://localhost:3000](http://localhost:3000).

## Project Architecture

```
apps/web/
├── app/api/              # Next.js API routes
│   ├── fs/               #   File operations (list, read, write, watch SSE)
│   ├── git/              #   Git operations (info, status, stage, unstage, commit, pull, push)
│   ├── compile/          #   LaTeX compilation (reads from disk, proxies to latex-api)
│   ├── pdf/cached/       #   Serves cached PDF if still fresh
│   └── project/          #   Project picker API (current, set, browse)
├── components/
│   ├── ui/               #   shadcn/ui primitives (button, dialog, tooltip, etc.)
│   ├── project/          #     Welcome screen, directory browser, project switcher
│   └── workspace/        #   App-specific components
│       ├── sidebar/      #     File tree, Source Control panel, Table of Contents
│       ├── editor/       #     CodeMirror editor, toolbar, search, image preview
│       └── preview/      #     PDF viewer with zoom, scroll sync, error log
├── hooks/                #   use-fs-startup, use-keyboard-shortcuts, use-current-project
├── lib/
│   ├── fs/               #   Sandbox, echo suppression, watcher, project-dir, clients
│   ├── git/              #   Git runner (server-side execFile), Git client (browser fetch)
│   └── project/          #   Config module (~/openlatex/config.json), path utils
├── stores/               #   Zustand stores: fs, editor, pdf, git
└── styles/               #   Tailwind CSS v4 globals
```

### Key patterns

- **Disk is source of truth.** The browser never holds state that isn't on disk within ~300ms.
- **Path sandboxing.** Every filesystem route validates paths via `resolveInProject()` from `lib/fs/sandbox.ts`. Always use it for any new FS route.
- **Echo suppression.** When the server writes a file, it records the write so the chokidar watcher can drop the resulting event. See `lib/fs/echo-suppression.ts`.
- **No shell injection.** Git commands use `execFile` (args as array). Never use `exec` or template strings for command construction.
- **Zustand for state.** Four stores: `fs-store` (file tree), `editor-store` (active file + buffer), `pdf-store` (PDF bytes + compile status), `git-store` (branch, statuses, actions).

### Testing

```bash
cd apps/web
pnpm test          # Run all tests once
pnpm test:watch    # Watch mode
```

Unit tests cover the security-critical modules:
- `lib/fs/sandbox.test.ts` — Path resolution and traversal rejection
- `lib/fs/echo-suppression.test.ts` — Write-echo tracking with fake timers

A manual test checklist lives at `docs/manual-test-plan.md`.

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting.

```bash
# Check code
pnpm lint

# Auto-fix issues
pnpm lint:fix
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run `pnpm lint` to ensure code quality
5. Run `cd apps/web && pnpm test` to verify tests pass
6. Commit with a descriptive message
7. Push to your fork and open a PR

### Commit Convention

Use conventional commits:
- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation
- `refactor:` code refactoring
- `chore:` maintenance tasks
