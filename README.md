# myWiki

A local, AI-driven knowledge system for systems engineering and AI research —
a very specialized Claude over your own library. The main page is a single
chat window: ask a question, and Claude answers from your sources (papers,
books, norms, slides) plus clearly-marked general knowledge, choosing the
best form for the answer — prose, tables, LaTeX equations, or rendered
Mermaid diagrams.

Knowledge management stays in the background: a Sources dialog handles
add/remove/metadata, and everything (source copies, index, conversation) is
stored as plain files in a local knowledge folder you choose.

Built on the foundation of [OpenLatex](https://github.com/pscholz1996/OpenLatex)
(Claude Agent SDK integration, citation-verified knowledge base, UI stack) —
with the entire LaTeX/editor/writing layer removed.

## What it does

- **Chat-first UI** — a clean, Claude-like page; no editor, no projects.
- **Grounded answers** — hybrid semantic + keyword search over your indexed
  sources; broad multi-angle retrieval before synthesizing.
- **Visible knowledge boundary** — parts answered from general knowledge are
  explicitly marked; source-backed claims can carry verified, clickable
  source chips (source + page, opens the PDF).
- **Visual answers** — GFM tables, KaTeX math, and Mermaid diagrams rendered
  inline whenever a picture beats a paragraph.
- **Background source management** — upload PDFs/markdown/text, automatic
  metadata lookup (CrossRef), search/sort/fix metadata, scope chat to
  selected sources.

## Status

- [x] Chat-first UI pivot (no editor, sources in background, visual answers)
- [ ] Ingestion upgrade: Docling conversion, figure extraction, digests
- [ ] Index upgrade: SQLite FTS5 + LanceDB for 500–5,000 sources
- [ ] Source figures as visual answers (return actual diagrams from PDFs)

## Development

```bash
pnpm install
pnpm dev        # web app on http://localhost:3000
```

Requires Node 20+ and pnpm. Sign in with your Claude account from the header
to enable the assistant.
