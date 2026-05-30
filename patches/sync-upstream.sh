#!/bin/bash
# Sync with upstream and reapply patches
# Usage: ./patches/sync-upstream.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

cd "$REPO_DIR"

echo "=== Syncing with upstream ==="

# Fetch upstream
echo "[1/5] Fetching upstream..."
git fetch upstream main

# Save current patches
echo "[2/5] Saving current patches..."
bash "$SCRIPT_DIR/save.sh"

# Merge upstream with our strategy
echo "[3/5] Merging upstream..."
if git merge upstream/main --no-edit -X ours; then
    echo "  ✅ Merge successful"
else
    echo "  ❌ Merge failed, resolve conflicts manually"
    exit 1
fi

# Reapply patches
echo "[4/5] Reapplying patches..."
bash "$SCRIPT_DIR/apply.sh"

# Build to verify
echo "[5/5] Building to verify..."
npm run build

echo ""
echo "=== Done ==="
echo "Review changes, then commit and push"
