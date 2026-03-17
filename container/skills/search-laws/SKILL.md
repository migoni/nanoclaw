---
name: search-laws
description: Search Russian federal law codes (Кодексы РФ) using full-text search. Use when the user asks about Russian law, legal articles, or regulations.
---

# Search Russian Laws

Search the indexed Russian federal law codes database.

## Usage

```bash
bash /workspace/group/search-laws.sh "search query" [limit]
```

## Examples

```bash
# Search for property rights
bash /workspace/group/search-laws.sh "право собственности"

# Search for labor contract rules, more results
bash /workspace/group/search-laws.sh "трудовой договор" 20

# Search for inheritance
bash /workspace/group/search-laws.sh "наследование"

# Search for specific article
bash /workspace/group/search-laws.sh "статья 256"
```

## Tips

- Use Russian legal terminology for best results
- Search returns the most relevant text chunks ranked by relevance
- Each result shows the document name, law title, and text excerpt
- Default limit is 10 results; increase for broader searches
- The database contains all major Russian federal codes (Кодексы РФ)

## Reindexing

If the user says laws have been updated, run:
```bash
bash /workspace/group/sync-laws.sh --force
```
This pulls the latest documents from GitHub and re-indexes changed files.
