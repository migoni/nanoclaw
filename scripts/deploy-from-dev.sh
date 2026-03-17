#!/bin/bash
# Deploy changes from dev-tomas branch to the live NanoClaw instance.
# Called by the agent from inside the container via the host mount.
set -e

REPO="/root/nanoclaw"
WORKTREE="/root/nanoclaw-dev"

cd "$REPO"

echo "=== Merging dev-tomas into main ==="
git merge dev-tomas --no-edit

echo "=== Building ==="
npm run build

echo "=== Rebuilding container ==="
./container/build.sh

echo "=== Restarting service ==="
systemctl restart nanoclaw

echo "=== Deploy complete ==="
