#!/bin/bash
# Save current customizations as patches
# Usage: ./patches/save.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

cd "$REPO_DIR"

echo "=== Saving custom patches ==="

# Crush UI patches
echo "[1/2] Saving crush-ui.patch..."
git diff upstream/main HEAD -- \
    packages/coding-agent/src/core/tools/bash.ts \
    packages/coding-agent/src/core/tools/edit.ts \
    packages/coding-agent/src/core/tools/read.ts \
    packages/coding-agent/src/core/tools/write.ts \
    packages/coding-agent/src/modes/interactive/components/tool-execution.ts \
    packages/coding-agent/src/core/extensions/types.ts \
    packages/coding-agent/src/core/extensions/runner.ts \
    packages/coding-agent/src/modes/interactive/interactive-mode.ts \
    packages/tui/src/tui.ts \
    packages/coding-agent/src/modes/rpc/rpc-mode.ts \
    > "$SCRIPT_DIR/crush-ui.patch"
echo "  ✅ crush-ui.patch saved ($(wc -l < "$SCRIPT_DIR/crush-ui.patch") lines)"

# Custom update mechanism patches
echo "[2/2] Saving custom-update.patch..."
git diff upstream/main HEAD -- \
    packages/coding-agent/src/config.ts \
    packages/coding-agent/src/utils/version-check.ts \
    packages/coding-agent/src/package-manager-cli.ts \
    > "$SCRIPT_DIR/custom-update.patch"
echo "  ✅ custom-update.patch saved ($(wc -l < "$SCRIPT_DIR/custom-update.patch") lines)"

echo ""
echo "=== Done ==="
echo "Commit patches: git add patches/ && git commit -m 'chore: update patches'"
