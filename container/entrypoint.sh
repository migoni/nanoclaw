#!/bin/bash
set -e

# Compile agent-runner TypeScript
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Set up git credentials from .claude/ session dir or additionalMounts
for DIR in /home/node/.claude /workspace/extra; do
  if [ -f "$DIR/gitconfig" ]; then
    ln -sf "$DIR/gitconfig" /home/node/.gitconfig
    break
  fi
done
for DIR in /home/node/.claude /workspace/extra; do
  if [ -f "$DIR/gitcredentials" ]; then
    ln -sf "$DIR/gitcredentials" /home/node/.git-credentials
    # Also authenticate gh CLI using the PAT
    TOKEN=$(grep 'github.com' "$DIR/gitcredentials" 2>/dev/null | sed 's|.*://[^:]*:\([^@]*\)@.*|\1|' | head -1)
    if [ -n "$TOKEN" ]; then
      echo "$TOKEN" | gh auth login --with-token 2>&1 >&2 || true
    fi
    break
  fi
done

# Install plugins if plugins.txt exists in .claude directory
PLUGINS_FILE="/home/node/.claude/plugins.txt"
if [ -f "$PLUGINS_FILE" ]; then
  while IFS= read -r plugin; do
    # Skip empty lines and comments
    [ -z "$plugin" ] && continue
    [[ "$plugin" =~ ^# ]] && continue
    echo "[entrypoint] Installing plugin: $plugin" >&2
    claude plugin install "$plugin" --scope user 2>&1 >&2 || echo "[entrypoint] Warning: failed to install plugin $plugin" >&2
  done < "$PLUGINS_FILE"
fi

# Read input and run agent
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
