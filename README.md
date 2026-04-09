# Open-Prism

Open-source AI-powered LaTeX writing workspace with live preview.

![Open-Prism Screenshot](./assets/OpenPrism.png)

## Features

- **Live PDF Preview** - Real-time compilation and preview of your documents
- **CodeMirror Editor** - Syntax highlighting and LaTeX language support
- **Local Storage** - Documents saved in browser IndexedDB
- **Dark/Light Theme** - Automatic theme switching support

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

## Project Structure

```
open-prism/
├── apps/
│   ├── web/          # Next.js frontend application
│   └── latex-api/    # LaTeX compilation API (Hono + TeX Live)
├── packages/         # Shared packages (if any)
├── biome.json        # Biome linter configuration
└── turbo.json        # Turborepo configuration
```

### apps/web

Next.js 16 application with:
- assistant-ui for AI chat interface
- CodeMirror for LaTeX editing
- react-pdf for PDF preview
- Upstash Redis for rate limiting

### apps/latex-api

Hono-based API for LaTeX compilation:
- Accepts LaTeX source code
- Compiles using TeX Live (pdflatex)
- Returns compiled PDF

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and contribution guidelines.

## License

[MIT](./LICENSE)
