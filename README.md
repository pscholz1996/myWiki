# myWiki

A local, AI-driven knowledge wiki for systems engineering and AI research. All
knowledge stays on your own disk as plain files; Claude works on top of it as a
research assistant that searches your sources, answers with verified page-level
citations, and distills knowledge into living wiki pages.

Built on the foundation of [OpenLatex](https://github.com/pscholz1996/OpenLatex)
(UI shell, filesystem sync, git integration, Claude Agent SDK integration,
citation-verified knowledge base).

## Concept

- **Sources** (`sources/`) — drop PDFs, PPTX, and other originals here.
- **Library** (`library/`) — ingested, searchable markdown conversions with
  extracted figures, metadata, and AI digests.
- **Wiki** (`wiki/`) — living markdown pages with `[[wikilinks]]`, written by
  you and proposed/updated by the AI with citations back to sources.
- **AI panel** — agentic Q&A over the whole knowledge base: hybrid search,
  targeted deep reads, quote verification, text or visual answers.

## Status

Under active development:

- [x] Phase 0 — OpenLatex fork stripped of LaTeX, rebranded, markdown editor +
  source PDF viewer
- [ ] Phase 1 — ingestion pipeline (Docling/markitdown) + hybrid index
  (SQLite FTS5 + LanceDB)
- [ ] Phase 2 — agentic Q&A with retrieval tools and citation chips
- [ ] Phase 3 — living wiki pages (spaces, backlinks, AI page proposals)
- [ ] Phase 4 — visual answers (Mermaid, SVG, source figures)

## Development

```bash
pnpm install
pnpm dev        # starts the web app on http://localhost:3000
```

Requires Node 20+ and pnpm. Sign in with your Claude account from the sidebar
to enable the AI assistant.
