# Contributing to myWiki

## Prerequisites

- Node.js 20+
- pnpm 10+
- Python 3.10–3.14, 64-bit (optional — only for the Docling conversion
  sidecar). On Windows the 32-bit build will not do: PyTorch publishes no
  32-bit wheels. `pnpm setup:docling` checks this before installing anything.

## Setup

```bash
git clone https://github.com/pscholz1996/myWiki.git
cd myWiki
pnpm install
pnpm dev            # web app on http://localhost:3000
```

On first launch the app asks you to pick a knowledge folder; the choice is
saved to `~/.mywiki/config.json`. All knowledge-base data (source copies,
extraction caches, the SQLite index, conversations, images) lives inside
that folder under `.mywiki/`.

Sign in with your Claude account from the header to enable the assistant —
authentication goes through the Claude CLI's own sign-in; myWiki never
sees or stores credentials.

## Optional: Docling sidecar

For markedly better PDF extraction (reading order, tables, section
structure — especially norms and multi-column papers):

```bash
pnpm setup:docling            # add a python path to override the autodetect
```

This creates a private venv (~1.3 GB including PyTorch) under
`tools/docling/.venv`. Without it, ingestion falls back to the built-in
pdfjs extraction automatically. Set `MYWIKI_DISABLE_DOCLING=1` to force
the fallback.

## Development

```bash
pnpm --filter @mywiki/web test        # vitest unit tests
pnpm --filter @mywiki/web exec tsc --noEmit
pnpm lint                             # biome
pnpm --filter @mywiki/web build
```

Unit tests never touch the network, the Docling sidecar, or a real
embedding model (all are mocked or disabled in the vitest config).
