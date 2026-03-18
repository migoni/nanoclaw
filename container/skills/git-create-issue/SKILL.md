---
name: git-create-issue
description: Create a GitHub issue from a user request. Analyzes the request, adds technical context, and returns the issue number and URL.
---

# Create GitHub Issue

Create a GitHub issue based on a user's request. Analyze the request, add technical details, and file it.

## Steps

1. Analyze the user's request and determine:
   - What needs to change
   - Which files are likely affected
   - What the acceptance criteria are

2. Create the issue:
```bash
cd /workspace/extra/nanoclaw
gh issue create \
  --title "Short descriptive title" \
  --body "$(cat <<'BODY'
## Description
What the user requested (in their words).

## Technical Analysis
- Files likely affected: `src/...`
- Approach: brief technical plan
- Impact: what this changes for the user

## Acceptance Criteria
- [ ] Specific testable outcomes
- [ ] Build passes
- [ ] Tests pass
BODY
)"
```

3. Return the issue number and URL to the caller.

## Notes
- Keep titles under 70 characters
- Always include technical analysis in the body
- Tag with relevant context from the codebase
- The issue number is used for branch naming: `issue-<number>`
