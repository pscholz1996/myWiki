FROM node:22-slim AS base

RUN corepack enable pnpm

# Install dependencies needed for TeX Live installer and runtime package downloads
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    perl \
    fontconfig \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install TeX Live from upstream with scheme-small (includes working tlmgr
# so missing LaTeX packages can be auto-installed at compile time)
ENV TEXLIVE_DIR=/usr/local/texlive
RUN mkdir -p /tmp/install-tl && \
    wget -qO- "https://mirror.ctan.org/systems/texlive/tlnet/install-tl-unx.tar.gz" | \
    tar xz -C /tmp/install-tl --strip-components=1 && \
    printf '%s\n' \
      "selected_scheme scheme-small" \
      "TEXDIR ${TEXLIVE_DIR}" \
      "TEXMFLOCAL ${TEXLIVE_DIR}/texmf-local" \
      "TEXMFSYSVAR ${TEXLIVE_DIR}/texmf-var" \
      "TEXMFSYSCONFIG ${TEXLIVE_DIR}/texmf-config" \
      "TEXMFHOME ~/texmf" \
      "TEXMFVAR ~/.texlive/texmf-var" \
      "TEXMFCONFIG ~/.texlive/texmf-config" \
      "tlpdbopt_install_docfiles 0" \
      "tlpdbopt_install_srcfiles 0" \
    > /tmp/install-tl/texlive.profile && \
    /tmp/install-tl/install-tl -profile /tmp/install-tl/texlive.profile && \
    rm -rf /tmp/install-tl

# Pre-install common extras not in scheme-small
RUN ${TEXLIVE_DIR}/bin/*/tlmgr install \
    collection-latexrecommended \
    collection-fontsrecommended \
    collection-pictures \
    collection-science

# Make TeX Live binaries available on PATH
ENV PATH="${TEXLIVE_DIR}/bin/x86_64-linux:${TEXLIVE_DIR}/bin/aarch64-linux:${PATH}"

WORKDIR /app

# Copy workspace root files needed by pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy the latex-api package.json for dependency resolution
COPY apps/latex-api/package.json apps/latex-api/

RUN pnpm install --frozen-lockfile --filter=@openlatex/latex-api

# Copy the latex-api source
COPY apps/latex-api/ apps/latex-api/
RUN pnpm --filter=@openlatex/latex-api build

WORKDIR /app/apps/latex-api

EXPOSE 3001

CMD ["node", "dist/index.js"]
