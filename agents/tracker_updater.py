#!/usr/bin/env python3
"""ChipMonk TrackerUpdater — per-entity rolling briefs.

For each tracked entity (TSMC, NVIDIA, AMD, Intel, Samsung, SK Hynix,
ASML, Broadcom), pulls all marks of the last 7 days where the title
contains the entity name (case-insensitive substring) AND has a
relevance_score >= MIN_SCORE, sends them through Haiku via the gateway,
gets a one-paragraph "what's new this week" rollup, writes it to the
config table under key `tracker:<slug>` with JSON value
{summary, mark_ids, last_updated}.

Server route /api/trackers reads the config keys and serves them.
"""

import argparse
import json
import logging
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("tracker-updater")

DB_PATH = os.environ.get("CHIPMONK_DB", "/root/clawfeed/data/digest.db")

GATEWAY_URL = os.environ.get(
    "GATEWAY_URL", "http://169.254.169.254/gateway/llm/anthropic/v1/messages"
)
GATEWAY_MODEL = os.environ.get("TRACKER_MODEL", "claude-haiku-4-5-20251001")
GATEWAY_TIMEOUT = float(os.environ.get("GATEWAY_TIMEOUT", "30"))

MIN_SCORE = float(os.environ.get("TRACKER_MIN_SCORE", "0.30"))
WINDOW_DAYS = int(os.environ.get("TRACKER_WINDOW_DAYS", "7"))

# Entity → list of substrings to match (case-insensitive). First slug is canonical.
ENTITIES: dict[str, list[str]] = {
    "tsmc": ["tsmc", "taiwan semiconductor"],
    "nvidia": ["nvidia", "nvda"],
    "amd": ["amd ", "advanced micro devices"],
    "intel": ["intel"],
    "samsung": ["samsung"],
    "sk-hynix": ["sk hynix", "sk-hynix", "skhynix"],
    "asml": ["asml"],
    "broadcom": ["broadcom", "avgo"],
    "micron": ["micron"],
    "qualcomm": ["qualcomm"],
}


def select_marks_for_entity(conn: sqlite3.Connection, terms: list[str]) -> list[tuple]:
    placeholders = " OR ".join(["LOWER(title) LIKE ?"] * len(terms))
    params: list = [f"%{t}%" for t in terms]
    sql = f"""
        SELECT id, title, url, source_name, relevance_score, note, created_at
        FROM marks
        WHERE relevance_score >= ?
          AND created_at >= datetime('now', '-{WINDOW_DAYS} days')
          AND ({placeholders})
        ORDER BY relevance_score DESC, created_at DESC
        LIMIT 20
    """
    return conn.execute(sql, [MIN_SCORE, *params]).fetchall()


def summarize_entity(slug: str, rows: list[tuple]) -> str | None:
    bullets = []
    for r in rows:
        mid, title, url, source, score, note, created = r
        first_line = (note.split("\n")[0] if note else title)[:200]
        bullets.append(f"- [{score:.2f}] {title} ({source}, {created[:10]}) — {first_line}")

    user_prompt = (
        f"Below are the past {WINDOW_DAYS} days of news about {slug.upper()} "
        f"from the ChipMonk industry feed. Write a single dense paragraph "
        f"(80-120 words) titled 'This Week in {slug.upper()}' that synthesizes "
        f"the key developments. Focus on structural moves: capex, tech roadmap, "
        f"customer wins/losses, regulatory, supply chain. No fluff, no hedging, "
        f"no recap of who they are. Markdown bold for the heading.\n\n"
        + "\n".join(bullets)
    )
    try:
        r = requests.post(
            GATEWAY_URL,
            headers={
                "Content-Type": "application/json",
                "anthropic-version": "2023-06-01",
            },
            json={
                "model": GATEWAY_MODEL,
                "max_tokens": 500,
                "messages": [{"role": "user", "content": user_prompt}],
            },
            timeout=GATEWAY_TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        logger.warning(f"gateway failed for {slug}: {type(e).__name__}: {e}")
        return None

    text = ""
    for block in data.get("content", []):
        if block.get("type") == "text":
            text += block.get("text", "")
    return text.strip() or None


def upsert_config(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO config (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", help="comma-separated slugs to update; default: all")
    args = ap.parse_args()

    only = set(s.strip() for s in args.only.split(",")) if args.only else None
    conn = sqlite3.connect(DB_PATH)

    updated = 0
    skipped = 0
    failed = 0
    t0 = time.time()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    for slug, terms in ENTITIES.items():
        if only and slug not in only:
            continue
        rows = select_marks_for_entity(conn, terms)
        if len(rows) < 2:
            logger.info(f"  {slug:12s} skipped — only {len(rows)} marks in last {WINDOW_DAYS}d")
            skipped += 1
            continue

        if args.dry_run:
            logger.info(f"  {slug:12s} would summarize {len(rows)} marks")
            for r in rows[:3]:
                logger.info(f"    #{r[0]} {r[3]:18s} {r[1][:60]}")
            continue

        summary = summarize_entity(slug, rows)
        if not summary:
            failed += 1
            continue

        payload = json.dumps({
            "slug": slug,
            "terms": terms,
            "summary": summary,
            "mark_ids": [r[0] for r in rows],
            "mark_count": len(rows),
            "last_updated": now,
        })
        upsert_config(conn, f"tracker:{slug}", payload)
        updated += 1
        logger.info(f"  {slug:12s} updated ({len(rows)} marks, {len(summary)}c)")

    elapsed = time.time() - t0
    logger.info(
        f"done: updated={updated} skipped={skipped} failed={failed} elapsed={elapsed:.1f}s"
    )
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
