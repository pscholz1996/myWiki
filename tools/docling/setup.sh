#!/usr/bin/env bash
# Sets up the Docling conversion sidecar used by myWiki's ingestion pipeline.
# Creates a private venv next to this script and installs docling into it
# (~1-2 GB including PyTorch; the first conversion additionally downloads
# layout models from Hugging Face, ~500 MB).
#
# Usage: bash tools/docling/setup.sh [python-binary]
set -euo pipefail

cd "$(dirname "$0")"

PYTHON="${1:-}"
if [[ -z "$PYTHON" ]]; then
  # docling depends on PyTorch, whose wheels typically lag the newest
  # CPython — prefer an older, known-good interpreter over `python3`.
  for candidate in python3.12 python3.13 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PYTHON="$candidate"
      break
    fi
  done
fi

echo "Using $($PYTHON --version) ($(command -v $PYTHON))"
"$PYTHON" -m venv .venv
./.venv/bin/pip install --upgrade pip >/dev/null
./.venv/bin/pip install docling

echo
echo "Docling installed. Verifying import…"
./.venv/bin/python -c "import docling; print('docling', docling.__version__ if hasattr(docling, '__version__') else 'ok')"
echo "Done. myWiki will now use Docling automatically for new PDF uploads."
