#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$SKILL_DIR/.venv"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required for this skill setup." >&2
  echo "Install it with: brew install uv" >&2
  exit 1
fi

PYTHON_BIN="${PYTHON:-}"
if [ -z "$PYTHON_BIN" ]; then
  for candidate in python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$PYTHON_BIN" ]; then
  echo "Python 3.10+ is required." >&2
  echo "Install one, for example: brew install python@3.12" >&2
  echo "Then rerun: PYTHON=/opt/homebrew/bin/python3.12 scripts/setup-crawl4ai.sh" >&2
  exit 1
fi

"$PYTHON_BIN" - <<'PY'
import sys
if sys.version_info < (3, 10):
    print(f"Python {sys.version.split()[0]} detected. Crawl4AI requires Python 3.10+.")
    print("Install Python 3.10+ and rerun with: PYTHON=/path/to/python3.12 scripts/setup-crawl4ai.sh")
    raise SystemExit(1)
PY

uv venv "$VENV_DIR" --python "$PYTHON_BIN" --allow-existing
uv pip install --python "$VENV_DIR/bin/python" --upgrade crawl4ai

# Install/download browser dependencies.
if [ -x "$VENV_DIR/bin/crawl4ai-setup" ]; then
  "$VENV_DIR/bin/crawl4ai-setup"
else
  uv run --python "$VENV_DIR/bin/python" python -m crawl4ai setup
fi

echo "Crawl4AI installed in $VENV_DIR using uv"
