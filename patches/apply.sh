#!/bin/bash
# Apply custom patches after merging upstream
# Usage: ./patches/apply.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

cd "$REPO_DIR"

echo "=== Applying custom patches ==="

# Crush UI patches (tool rendering, sidebar, etc.)
if [ -f "$SCRIPT_DIR/crush-ui.patch" ]; then
    echo "[1/2] Applying crush-ui.patch..."
    git apply --check "$SCRIPT_DIR/crush-ui.patch" 2>/dev/null && \
        git apply "$SCRIPT_DIR/crush-ui.patch" && \
        echo "  ✅ crush-ui.patch applied" || \
        echo "  ⚠️ crush-ui.patch has conflicts, resolve manually"
fi

# Custom update mechanism patches
if [ -f "$SCRIPT_DIR/custom-update.patch" ]; then
    echo "[2/2] Applying custom-update.patch..."
    git apply --check "$SCRIPT_DIR/custom-update.patch" 2>/dev/null && \
        git apply "$SCRIPT_DIR/custom-update.patch" && \
        echo "  ✅ custom-update.patch applied" || \
        echo "  ⚠️ custom-update.patch has conflicts, resolve manually"
fi

echo ""
echo "=== Done ==="
echo "Run 'npm run build' to verify"
