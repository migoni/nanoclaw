#!/usr/bin/env python3
"""
Index Russian law .doc (HTML) files into SQLite FTS5 for full-text search.
Tracks file hashes to skip unchanged files on re-index.

Usage: python3 index-laws.py <source-dir> <db-path>
"""

import hashlib
import html
import json
import os
import re
import sqlite3
import sys
from html.parser import HTMLParser


class HTMLTextExtractor(HTMLParser):
    """Extract text from HTML, preserving paragraph breaks."""

    def __init__(self):
        super().__init__()
        self.text_parts = []
        self.current = []
        self._skip = False

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self._skip = True
        if tag in ('p', 'div', 'br', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            if self.current:
                self.text_parts.append(' '.join(self.current))
                self.current = []

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self._skip = False
        if tag in ('p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table'):
            if self.current:
                self.text_parts.append(' '.join(self.current))
                self.current = []

    def handle_data(self, data):
        if not self._skip:
            text = data.strip()
            if text:
                self.current.append(text)

    def get_text(self):
        if self.current:
            self.text_parts.append(' '.join(self.current))
        return '\n'.join(self.text_parts)


def extract_text_from_html(filepath):
    """Extract plain text from an HTML .doc file."""
    with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()

    parser = HTMLTextExtractor()
    parser.feed(content)
    return parser.get_text()


def extract_doc_title(text, filename):
    """Try to extract the law title from the first few lines."""
    lines = [l.strip() for l in text.split('\n') if l.strip()][:10]
    # Look for a line that contains "КОДЕКС" or "ФЕДЕРАЛЬНЫЙ ЗАКОН" or similar
    for line in lines:
        if any(kw in line.upper() for kw in ['КОДЕКС', 'ЗАКОН', 'ФЕДЕРАЛЬН']):
            return line[:200]
    # Fallback: use filename
    name = os.path.splitext(os.path.basename(filename))[0]
    return name


def chunk_text(text, chunk_size=1500, overlap=200):
    """
    Split text into overlapping chunks by paragraph boundaries.
    Each chunk is ~chunk_size characters, split at paragraph breaks.
    """
    paragraphs = [p.strip() for p in text.split('\n') if p.strip()]
    chunks = []
    current_chunk = []
    current_size = 0

    for para in paragraphs:
        para_len = len(para)
        if current_size + para_len > chunk_size and current_chunk:
            chunks.append('\n'.join(current_chunk))
            # Keep last few paragraphs for overlap
            overlap_text = '\n'.join(current_chunk)
            overlap_parts = []
            overlap_size = 0
            for p in reversed(current_chunk):
                if overlap_size + len(p) > overlap:
                    break
                overlap_parts.insert(0, p)
                overlap_size += len(p)
            current_chunk = overlap_parts
            current_size = overlap_size

        current_chunk.append(para)
        current_size += para_len

    if current_chunk:
        chunks.append('\n'.join(current_chunk))

    return chunks


def file_hash(filepath):
    """Compute SHA-256 hash of a file."""
    h = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while True:
            block = f.read(65536)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def init_db(db_path):
    """Create the FTS5 database and metadata tables."""
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS file_hashes (
            filename TEXT PRIMARY KEY,
            hash TEXT NOT NULL,
            title TEXT,
            indexed_at TEXT
        )
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS law_chunks USING fts5(
            filename,
            title,
            chunk_index,
            content,
            tokenize='unicode61'
        )
    """)
    conn.commit()
    return conn


def index_file(conn, filepath, filename):
    """Extract, chunk, and index a single .doc file."""
    text = extract_text_from_html(filepath)
    if not text.strip():
        print(f"  WARNING: Empty text extracted from {filename}", file=sys.stderr)
        return 0

    title = extract_doc_title(text, filename)
    chunks = chunk_text(text)

    # Remove old chunks for this file
    conn.execute("DELETE FROM law_chunks WHERE filename = ?", (filename,))

    # Insert new chunks
    for i, chunk in enumerate(chunks):
        conn.execute(
            "INSERT INTO law_chunks (filename, title, chunk_index, content) VALUES (?, ?, ?, ?)",
            (filename, title, i, chunk)
        )

    # Update hash
    h = file_hash(filepath)
    conn.execute(
        "INSERT OR REPLACE INTO file_hashes (filename, hash, title, indexed_at) VALUES (?, ?, ?, datetime('now'))",
        (filename, h, title)
    )

    return len(chunks)


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <source-dir> <db-path>", file=sys.stderr)
        sys.exit(1)

    source_dir = sys.argv[1]
    db_path = sys.argv[2]

    conn = init_db(db_path)

    # Get current hashes
    existing = {}
    for row in conn.execute("SELECT filename, hash FROM file_hashes"):
        existing[row[0]] = row[1]

    # Find all .doc files
    doc_files = sorted([
        f for f in os.listdir(source_dir)
        if f.lower().endswith('.doc') or f.lower().endswith('.docx')
    ])

    stats = {'indexed': 0, 'skipped': 0, 'removed': 0, 'chunks': 0}

    # Index new/changed files
    for filename in doc_files:
        filepath = os.path.join(source_dir, filename)
        h = file_hash(filepath)

        if filename in existing and existing[filename] == h:
            stats['skipped'] += 1
            continue

        action = "Re-indexing" if filename in existing else "Indexing"
        print(f"  {action}: {filename}", file=sys.stderr)
        chunks = index_file(conn, filepath, filename)
        stats['indexed'] += 1
        stats['chunks'] += chunks

    # Remove deleted files
    current_files = set(doc_files)
    for filename in list(existing.keys()):
        if filename not in current_files:
            print(f"  Removing: {filename}", file=sys.stderr)
            conn.execute("DELETE FROM law_chunks WHERE filename = ?", (filename,))
            conn.execute("DELETE FROM file_hashes WHERE filename = ?", (filename,))
            stats['removed'] += 1

    conn.commit()

    # Report
    total_files = conn.execute("SELECT COUNT(DISTINCT filename) FROM file_hashes").fetchone()[0]
    total_chunks = conn.execute("SELECT COUNT(*) FROM law_chunks").fetchone()[0]

    print(json.dumps({
        'indexed': stats['indexed'],
        'skipped': stats['skipped'],
        'removed': stats['removed'],
        'new_chunks': stats['chunks'],
        'total_files': total_files,
        'total_chunks': total_chunks,
    }))

    conn.close()


if __name__ == '__main__':
    main()
