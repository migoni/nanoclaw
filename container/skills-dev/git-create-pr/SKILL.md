---
name: git-create-pr
description: Build, test, commit, push, and create a pull request linked to a GitHub issue.
---

# Create Pull Request

After making code changes, build, test, commit, push, and create a PR.

## Steps

### 1. Format, build and test
```bash
cd /workspace/extra/nanoclaw
npx prettier --write .
npm run build
npx vitest run
```
Run Prettier **before** building — GitHub Actions checks formatting and will fail the PR if code is not formatted.
If build or tests fail, fix the issues before continuing.

### 2. Commit
```bash
cd /workspace/extra/nanoclaw
git add -A
git commit -m "fix: short description

Closes #<ISSUE_NUMBER>"
```
Include `Closes #<NUMBER>` to auto-close the issue when PR merges.

### 3. Push
```bash
cd /workspace/extra/nanoclaw
git push origin HEAD
```

### 4. Create PR
```bash
cd /workspace/extra/nanoclaw
gh pr create \
  --title "Short title (#<ISSUE_NUMBER>)" \
  --body "$(cat <<'BODY'
## Summary
- What changed and why

Closes #<ISSUE_NUMBER>

## Changes
- List of specific changes made

## Test Plan
- How it was tested
- Build: ✅
- Tests: ✅
BODY
)"
```

### 5. Report to user
Send the user:
- What was changed (brief summary)
- Link to the PR
- Ask them to review

## Notes
- PR title should reference the issue number
- Body must include `Closes #<NUMBER>` to link the issue
- Always confirm build and tests pass before creating PR
- Always run Prettier before committing — CI enforces formatting
