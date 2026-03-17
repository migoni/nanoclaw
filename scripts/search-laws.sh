#!/bin/bash
# Search the Russian law FTS5 index.
# Usage: search-laws "query terms" [limit]
# Called by the agent from inside the container.
set -e

QUERY="$1"
LIMIT="${2:-10}"

if [ -z "$QUERY" ]; then
  echo "Usage: search-laws \"query\" [limit]"
  echo "Examples:"
  echo "  search-laws \"право собственности\""
  echo "  search-laws \"трудовой договор\" 20"
  exit 1
fi

DB="/workspace/group/laws.db"
if [ ! -f "$DB" ]; then
  echo "ERROR: Laws database not found at $DB"
  exit 1
fi

python3 -c "
import sqlite3, sys, json
conn = sqlite3.connect('$DB')
query = '''$QUERY'''
limit = int('$LIMIT')
rows = conn.execute('''
    SELECT filename, title, chunk_index,
           snippet(law_chunks, 3, \">>>\", \"<<<\", \"...\", 40) as snippet,
           content
    FROM law_chunks
    WHERE law_chunks MATCH ?
    ORDER BY rank
    LIMIT ?
''', (query, limit)).fetchall()

if not rows:
    print('Ничего не найдено по запросу: ' + query)
    sys.exit(0)

print(f'Найдено результатов: {len(rows)}')
print()
for i, (fname, title, chunk_idx, snippet, content) in enumerate(rows, 1):
    print(f'=== Результат {i} ===')
    print(f'Документ: {title}')
    print(f'Файл: {fname} (часть {chunk_idx})')
    print(f'Фрагмент: {snippet}')
    print()
    # Print full content for context
    lines = content.strip().split('\n')
    if len(lines) > 20:
        print('\n'.join(lines[:20]))
        print(f'... (ещё {len(lines) - 20} строк)')
    else:
        print(content.strip())
    print()
"
