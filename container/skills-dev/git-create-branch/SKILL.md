---
name: git-create-branch
description: Create a feature branch from latest main, named after a GitHub issue number (issue-<number>).
---

# Create Feature Branch

Create a branch from latest main, named after the GitHub issue.

## Steps

```bash
cd /workspace/extra/nanoclaw
git fetch origin
git checkout main
git merge origin/main --ff-only
git checkout -b issue-<NUMBER>
```

Replace `<NUMBER>` with the actual GitHub issue number.

## Notes
- ALWAYS start from latest main
- Branch name format: `issue-<number>` (e.g. `issue-42`)
- One branch per issue, one issue per feature/fix
- If branch already exists, delete and recreate: `git branch -D issue-<NUMBER>`
