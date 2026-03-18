#!/bin/bash
# Deploy latest main to the live NanoClaw instance.
# Called via IPC deploy command after a PR is merged.
set -e

# Load nvm so npm/node are available (IPC execSync doesn't inherit login shell)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

REPO="/root/nanoclaw"
WORKTREE="/root/nanoclaw-dev"

cd "$REPO"

echo "=== Pulling latest main ==="
git pull origin main

echo "=== Building ==="
npm run build

echo "=== Checking if container rebuild needed ==="
# Rebuild container if Dockerfile or entrypoint changed in the pull
CHANGED=$(git diff HEAD~1 --name-only 2>/dev/null || echo "")
if echo "$CHANGED" | grep -qE "container/|Dockerfile|entrypoint"; then
  echo "=== Container files changed, rebuilding ==="
  ./container/build.sh
else
  echo "=== No container changes, skipping rebuild ==="
fi

echo "=== Syncing worktree ==="
git config --global --add safe.directory "$WORKTREE" 2>/dev/null || true
cd "$WORKTREE"
git fetch origin
git checkout main 2>/dev/null || git checkout -b main origin/main
git merge origin/main --ff-only
cd "$REPO"

echo "=== Restarting service ==="
systemctl restart nanoclaw

echo "=== Deploy complete ==="
