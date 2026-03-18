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

### 1. Get PR info
```bash
cd /workspace/extra/nanoclaw
gh pr view <PR_NUMBER> --json number,headRefName --jq '{number: .number, branch: .headRefName}'
```

### 2. Merge via GitHub API
Use the API directly — avoids local git permission issues:
```bash
gh api repos/migoni/nanoclaw/pulls/<PR_NUMBER>/merge \
  --method PUT \
  --field merge_method="squash" \
  --field commit_title="<commit title from PR title + (#PR_NUMBER)>" \
  --jq '.message'
```

### 3. Delete the branch (MANDATORY)
Always delete the branch after merge — no exceptions:
```bash
gh api repos/migoni/nanoclaw/git/refs/heads/<BRANCH_NAME> --method DELETE && echo "Branch deleted"
```

### 4. Trigger deploy
```bash
echo '{"type":"deploy","chatJid":"tg:942175938"}' > /workspace/ipc/messages/deploy-$(date +%s).json
```

This triggers the host to:
- Pull latest main
- Build the project
- Rebuild container image (if Dockerfile/entrypoint changed)
- Restart the service

### 5. Sync local clone
```bash
cd /workspace/extra/nanoclaw
git fetch origin
git checkout main
git merge origin/main --ff-only
```

### 6. Confirm to user
Tell the user the deploy is triggered and the service is restarting.

## CRITICAL
- NEVER merge without explicit user approval
- NEVER skip the deploy step after merge
- ALWAYS delete the branch after merge (step 3 is mandatory)
- ALWAYS sync the local clone after deploy
- Use chatJid tg:942175938 (owner DM) for deploy notifications — NOT the group thread
