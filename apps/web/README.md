# OpenLaTex Web

The Next.js 16 frontend and API routes for OpenLaTex — the editor, PDF preview, AI research assistant, and Git UI. See the [root README](../../README.md) for the full feature list, architecture diagram, and quick start, and [CONTRIBUTING.md](../../CONTRIBUTING.md) for local development setup.

## Local Development

```bash
# From the workspace root
pnpm install
pnpm dev:web
```

Requires the `latex-api` service running for compilation (see [apps/latex-api](../latex-api)).

## Structure

```
app/api/     # File, Git, GitHub, Compile, PDF, SyncTeX, Project, and AI routes
components/  # UI: sidebar, editor, preview, AI panel, shadcn/ui primitives
hooks/       # use-fs-startup, use-keyboard-shortcuts, use-current-project
lib/         # fs (sandbox/watcher), git, ai (knowledge base, agent), project
stores/      # Zustand: fs, editor, pdf, git, ai, github
styles/      # Tailwind CSS v4
```

## Testing

```bash
pnpm test          # Run all tests once
pnpm test:watch    # Watch mode
```
