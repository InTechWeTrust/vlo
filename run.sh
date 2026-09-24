#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${VLO_HOST:-127.0.0.1}"
PORT="${VLO_PORT:-6332}"
NO_BROWSER=false
PYTHON_BIN="$SCRIPT_DIR/backend/.venv/bin/python"

for arg in "$@"; do
    case "$arg" in
        --no-browser) NO_BROWSER=true ;;
        --host=*) HOST="${arg#*=}" ;;
        --port=*) PORT="${arg#*=}" ;;
    esac
done

# Verify installation. Launched from a file manager, the terminal closes the
# moment we exit, so hold it open long enough to read why.
if [ ! -x "$PYTHON_BIN" ]; then
    echo ""
    echo "Error: VLO is not installed yet."
    echo "Run ./install.sh first, then start VLO with ./run.sh."
    echo ""
    if [ -t 0 ]; then
        read -r -p "Press Enter to close..." _ || true
    fi
    exit 1
fi
if [ ! -f "$SCRIPT_DIR/frontend/dist/index.html" ]; then
    echo "Warning: Frontend not built. Run ./install.sh or npm run build."
fi

# A wildcard bind address is not something a browser can connect to.
BROWSER_HOST="$HOST"
if [ "$BROWSER_HOST" = "0.0.0.0" ]; then
    BROWSER_HOST="127.0.0.1"
fi

# Open the browser once the server answers, not on a fixed delay.
if [ "$NO_BROWSER" = false ]; then
    "$PYTHON_BIN" "$SCRIPT_DIR/scripts/open-browser-when-ready.py" \
        "http://${BROWSER_HOST}:${PORT}" >/dev/null 2>&1 &
fi

echo "Starting VLO at http://${HOST}:${PORT}"
echo "Press Ctrl+C to stop."
echo ""

cd "$SCRIPT_DIR/backend"
"$PYTHON_BIN" -m uvicorn main:app --host "$HOST" --port "$PORT"
