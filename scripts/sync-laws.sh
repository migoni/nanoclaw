#!/bin/bash
# Sync Russian law documents from GitHub and re-index if changed.
# Usage: bash sync-laws.sh [--force]
set -e

REPO_DIR="/root/nanoclaw/data/laws-source"
DB_PATH="/root/nanoclaw/groups/telegram_main-laws/laws.db"
SCRIPT_DIR="$(dirname "$0")"

# Ensure group folder exists
mkdir -p "$(dirname "$DB_PATH")"

# Clone if not exists
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "Cloning laws repository..."
  git clone https://github.com/migoni/russian-laws.git "$REPO_DIR"
fi

# Pull latest
cd "$REPO_DIR"
echo "Pulling latest changes..."
BEFORE=$(git rev-parse HEAD)
git pull --ff-only origin main 2>/dev/null || git pull origin main
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ] && [ "$1" != "--force" ] && [ -f "$DB_PATH" ]; then
  echo "No changes detected. Use --force to re-index anyway."
  exit 0
fi

# Re-index
echo "Indexing documents..."
python3 "$SCRIPT_DIR/index-laws.py" "$REPO_DIR" "$DB_PATH"
echo "Done."
