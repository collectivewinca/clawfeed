#!/usr/bin/env python3
"""ChipMonk BriefWriter — drafts the daily ChipMonk Brief.

Pulls the top N highest-scoring marks from the last 24h, sends them
(with their auto-generated notes) through Claude Sonnet 4.6 via the
exe.dev LLM gateway, gets a publishable ~600-word brief back, writes
it to the `digests` table with `type='daily'`. The blog page already
queries that table.

Runs once a day after the 14:00 UTC Sliver+ArticleReader cycle so the
brief lands on the freshest enrichments.
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
logger = logging.getLogger("brief-writer")

DB_PATH = os.environ.get("CHIPMONK_DB", "/root/clawfeed/data/digest.db")

OLLAMA_CHAT_URL = os.environ.get("OLLAMA_CHAT_URL", "https://ollama.com/api/chat")
OLLAMA_API_KEY = os.environ.get("OLLAMA_API_KEY", "")
# deepseek-v4-flash is the current Ollama Cloud deepseek line (v3.1 was delisted
# from the cloud catalog 2026-06; still pullable but retirement-risk). It is a
# reasoning model: thinking goes to message.thinking, prose to message.content,
# so /api/chat (below) is clean. Do NOT reuse on /api/generate (returns empty).
GATEWAY_MODEL = os.environ.get("BRIEF_MODEL", "deepseek-v4-flash")
GATEWAY_TIMEOUT = float(os.environ.get("GATEWAY_TIMEOUT", "120"))

TOP_N = int(os.environ.get("BRIEF_TOP_N", "12"))
MIN_SCORE = float(os.environ.get("BRIEF_MIN_SCORE", "0.40"))


SYSTEM_PROMPT = (
    "You are the editor of ChipMonk, a daily semiconductor industry brief read "
    "by chip-industry analysts, foundry executives, and accelerator engineers. "
    "Your voice is precise, analytical, and assumes the reader is technically "
    "fluent. You're skeptical of hype but quick to recognize structural shifts."
)

USER_PROMPT_TEMPLATE = """Today's top stories from across the chip industry are below. \
Each entry has a headline, source, relevance score, and a pre-written WHAT/WHY/ENTITIES note.

Write a publishable daily brief titled "ChipMonk Brief — {date}".

Structure:
1. **Lede** (one paragraph, 60-90 words): The single most important development \
of the day and why it matters. Lead with the structural shift, not the company name.

2. **Three Threads** (three sections, each a heading + 80-120 words): Pick the three \
most consequential themes from today's stories. Group related items under each thread. \
Cite specific companies, technologies, and numbers from the source notes. Don't just \
summarize — explain implications for foundry capacity, accelerator roadmaps, supply chains, \
or competitive positioning.

3. **Watch Items** (3-5 bullet points): Short flags for analysts on what to watch next \
(earnings, conferences, regulatory milestones, capex announcements).

Total length: ~550-650 words. Use markdown. Do NOT include hedging language ("it remains \
to be seen", "only time will tell"). Do NOT recap what ChipMonk is. Just write the brief.

---

Today's stories:

{stories}
"""


def select_top_marks(conn: sqlite3.Connection, top_n: int, min_score: float):
    cur = conn.execute(
        """
        SELECT id, title, url, source_name, relevance_score, note, status, created_at
        FROM marks
        WHERE relevance_score >= ?
          AND created_at >= datetime('now', '-24 hours')
          AND (note IS NOT NULL AND note <> '')
        ORDER BY relevance_score DESC, created_at DESC
        LIMIT ?
        """,
        (min_score, top_n),
    )
    return cur.fetchall()


def format_stories(rows) -> str:
    lines = []
    for i, (mid, title, url, source, score, note, status, created_at) in enumerate(rows, 1):
        lines.append(
            f"### Story {i} — score {score:.2f} — source: {source}\n"
            f"**Headline:** {title}\n"
            f"**URL:** {url}\n"
            f"**Note:** {note}\n"
        )
    return "\n".join(lines)


def call_sonnet(stories: str, today: str) -> str | None:
    user_prompt = USER_PROMPT_TEMPLATE.format(date=today, stories=stories)
    if not OLLAMA_API_KEY:
        logger.error("OLLAMA_API_KEY not set; cannot generate brief")
        return None
    try:
        r = requests.post(
            OLLAMA_CHAT_URL,
            headers={
                "Authorization": f"Bearer {OLLAMA_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": GATEWAY_MODEL,
                "stream": False,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
            },
            timeout=GATEWAY_TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        logger.error(f"ollama failed: {type(e).__name__}: {e}")
        return None

    msg = data.get("message", {}) or {}
    text = (msg.get("content") or "").strip()
    return text or None


def write_digest(conn: sqlite3.Connection, brief_text: str, mark_ids: list[int]) -> int:
    metadata = json.dumps({"source_marks": mark_ids, "agent": "brief-writer"})
    cur = conn.execute(
        "INSERT INTO digests (type, content, metadata) VALUES (?, ?, ?)",
        ("daily", brief_text, metadata),
    )
    conn.commit()
    return cur.lastrowid


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--top-n", type=int, default=TOP_N)
    ap.add_argument("--min-score", type=float, default=MIN_SCORE)
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    rows = select_top_marks(conn, args.top_n, args.min_score)
    if len(rows) < 3:
        logger.info(f"only {len(rows)} eligible marks in last 24h — skipping")
        return 0

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    stories = format_stories(rows)
    mark_ids = [r[0] for r in rows]

    logger.info(
        f"writing brief for {today} from {len(rows)} marks "
        f"(min_score={args.min_score}, top_n={args.top_n})"
    )

    if args.dry_run:
        logger.info("DRY RUN: would send to Sonnet, not writing to DB")
        for r in rows:
            logger.info(f"  #{r[0]} score={r[4]:.2f} {r[3]:20s} {r[1][:60]}")
        return 0

    t0 = time.time()
    brief_text = call_sonnet(stories, today)
    if not brief_text:
        logger.error("Sonnet returned empty; not writing digest")
        return 1

    digest_id = write_digest(conn, brief_text, mark_ids)
    elapsed = time.time() - t0
    logger.info(
        f"wrote digest #{digest_id} ({len(brief_text)}c) elapsed={elapsed:.1f}s"
    )
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
