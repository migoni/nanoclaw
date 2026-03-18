---
name: git-merge-deploy
description: Merge a pull request and trigger deployment. Only use when the user explicitly approves.
---

# Merge PR and Deploy

Merge an approved pull request and trigger the deploy pipeline.

## Prerequisites
- User has explicitly approved the merge
- PR has been reviewed

## Steps

### 1. Merge the PR
```bash
cd /workspace/extra/nanoclaw
gh pr merge --squash --delete-branch
```

### 2. Trigger deploy
```bash
echo '{"type":"deploy","chatJid":"tg:-1003740826206:8"}' > /workspace/ipc/messages/deploy-$(date +%s).json
```

This triggers the host to:
- Pull latest main
- Build the project
- Rebuild container image (if Dockerfile/entrypoint changed)
- Restart the service

### 3. Sync local clone
After deploy completes, sync the local clone:
```bash
cd /workspace/extra/nanoclaw
git fetch origin
git checkout main
git merge origin/main --ff-only
```

### 4. Confirm to user
Tell the user the deploy is complete and the service is restarting.

## CRITICAL
- NEVER merge without explicit user approval
- NEVER skip the deploy step after merge
- ALWAYS sync the local clone after deploy
