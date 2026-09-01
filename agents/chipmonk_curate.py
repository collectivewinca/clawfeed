#!/usr/bin/env python3
"""chipmonk_curate.py — insert a VE Curator "★ Founder's Pick" mark.

DEPLOY TARGET: chipmonk.exe.xyz, `/root/clawfeed/agents/chipmonk_curate.py`
(version-controlled in the chipmonk repo alongside `stocknews_ingest.py`). Invoked
by the helper's local `chipmonk-curate` SSH wrapper, which pipes a single JSON
record on stdin.

Contract (pinned — the helper's parser depends on it):
  stdin : one JSON object {"url": str, "title": str, "note": str}
  stdout: EXACTLY one JSON object, one of:
            {"id": <int>}              inserted
            {"duplicate": true, "id": <int>}   already present (no-op)
          (all diagnostics go to STDERR so the helper's "last JSON on stdout"
           parser can't be fooled by a trailing log line)
  exit  : 0 on insert or duplicate; non-zero on error (helper -> {ok:false})

Invariants:
  - status='approved' and source_name='founders_pick' are HARDCODED here, never
    taken from input (the in-browser review is the approval gate).
  - Parameterized bindings only — never string-interpolated SQL.
  - Dedup on (url, source_name) — matches across user_id=NULL inserts (the
    documented stocknews dedup; createMark's (url, user_id) dedup breaks on NULL).
  - user_id IS NULL; relevance_score/external_id/created_at take schema defaults.
"""
import json
import os
import sqlite3
import sys

DB_PATH = os.environ.get("CM_DB", "/root/clawfeed/data/digest.db")
SOURCE_NAME = "founders_pick"
STATUS = "approved"
MAX_URL = 2048
MAX_TITLE = 300
MAX_NOTE = 4000


def _die(msg: str, code: int = 1) -> "None":
    sys.stderr.write(f"[chipmonk_curate] {msg}\n")
    sys.exit(code)


def _read_record() -> dict:
    raw = sys.stdin.read()
    try:
        rec = json.loads(raw)
    except json.JSONDecodeError as e:
        _die(f"stdin is not valid JSON: {e}")
    if not isinstance(rec, dict):
        _die("stdin JSON must be an object")
    url = (rec.get("url") or "").strip()
    title = (rec.get("title") or "").strip()
    note = (rec.get("note") or "").strip()
    if not url or not title:
        _die("record requires non-empty url and title")
    # Bound sizes before touching the DB (a compromised/buggy caller can't bloat
    # the marks table). Injection is already closed by parameterized bindings.
    if len(url) > MAX_URL or len(title) > MAX_TITLE or len(note) > MAX_NOTE:
        _die("record field exceeds size cap")
    return {"url": url, "title": title, "note": note}


def main() -> int:
    rec = _read_record()
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA busy_timeout = 5000;")
    try:
        existing = conn.execute(
            "SELECT id FROM marks WHERE url = ? AND source_name = ? LIMIT 1",
            (rec["url"], SOURCE_NAME),
        ).fetchone()
        if existing:
            # No-op: re-picking the same tweet. Editing/retracting a live pick is
            # done via chipmonk's own /dashboard, not by re-inserting here.
            print(json.dumps({"duplicate": True, "id": existing[0]}))
            return 0
        cur = conn.execute(
            """INSERT OR IGNORE INTO marks (url, title, note, status, source_name, user_id)
               VALUES (?, ?, ?, ?, ?, NULL)""",
            (rec["url"], rec["title"], rec["note"], STATUS, SOURCE_NAME),
        )
        conn.commit()
        if cur.rowcount == 0:
            # Lost a concurrent insert race under UNIQUE(url, source_name); the row
            # now exists — report it as a handled duplicate, not an error.
            row = conn.execute(
                "SELECT id FROM marks WHERE url = ? AND source_name = ? LIMIT 1",
                (rec["url"], SOURCE_NAME),
            ).fetchone()
            print(json.dumps({"duplicate": True, "id": row[0] if row else None}))
            return 0
        print(json.dumps({"id": cur.lastrowid}))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
