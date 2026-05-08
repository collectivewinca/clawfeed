#!/usr/bin/env python3
"""ChipMonk ArticleReader — per-mark URL fetch + 3-sentence summary.

Reads pending marks where note is empty and relevance_score >= threshold,
fetches the article, sends through Claude Haiku via the exe.dev LLM
gateway (no API key, free, metered), writes a 3-sentence summary back
into marks.note.

Runs as a PM2 cron job after each Sliver batch (~30 min lag so the
fetch isn't competing with the scorer for network).
"""

import argparse
import logging
import os
import re
import sqlite3
import sys
import time
from typing import Optional

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("article-reader")

DB_PATH = os.environ.get("CHIPMONK_DB", "/root/clawfeed/data/digest.db")

GATEWAY_URL = os.environ.get(
    "GATEWAY_URL", "http://169.254.169.254/gateway/llm/anthropic/v1/messages"
)
GATEWAY_MODEL = os.environ.get("GATEWAY_MODEL", "claude-haiku-4-5-20251001")
GATEWAY_TIMEOUT = float(os.environ.get("GATEWAY_TIMEOUT", "20"))

FETCH_TIMEOUT = float(os.environ.get("FETCH_TIMEOUT", "12"))
USER_AGENT = "ChipMonkBot/1.0 (+https://chipmonk.tech)"

# Only enrich marks above this score; cheap protection from spending tokens
# on borderline items.
MIN_SCORE = float(os.environ.get("ARTICLE_READER_MIN_SCORE", "0.40"))

# Cap items per run so a Sliver batch backlog doesn't run unbounded.
BATCH_LIMIT = int(os.environ.get("ARTICLE_READER_BATCH_LIMIT", "30"))

PROMPT_TEMPLATE = (
    "You are an editor for ChipMonk, a daily semiconductor industry brief.\n"
    "Read the article below and write exactly three short sentences:\n"
    "1. WHAT happened (one factual sentence).\n"
    "2. WHY IT MATTERS for the chip industry (one analytical sentence).\n"
    "3. KEY ENTITIES (companies, technologies, geographies — comma-separated).\n\n"
    "Headline: {title}\n\n"
    "Article text:\n{body}\n"
)


def _strip_html(html: str) -> str:
    """Lightweight HTML → text. Good enough for summarization input."""
    html = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.IGNORECASE)
    html = re.sub(r"<style[\s\S]*?</style>", " ", html, flags=re.IGNORECASE)
    html = re.sub(r"<[^>]+>", " ", html)
    html = re.sub(r"&nbsp;|&#160;", " ", html)
    html = re.sub(r"&amp;", "&", html)
    html = re.sub(r"&lt;", "<", html)
    html = re.sub(r"&gt;", ">", html)
    html = re.sub(r"\s+", " ", html)
    return html.strip()


def fetch_article(url: str) -> Optional[str]:
    """Fetch URL and return cleaned text, or None on failure.

    Caps body at 8000 chars (~2000 tokens) to keep summaries cheap.
    """
    try:
        r = requests.get(
            url,
            timeout=FETCH_TIMEOUT,
            headers={"User-Agent": USER_AGENT},
            allow_redirects=True,
        )
        r.raise_for_status()
    except Exception as e:
        logger.warning(f"fetch failed url={url[:80]}: {type(e).__name__}: {e}")
        return None

    ctype = r.headers.get("content-type", "").lower()
    if "text/html" not in ctype and "text/plain" not in ctype:
        logger.info(f"skip non-html content-type={ctype} url={url[:80]}")
        return None

    text = _strip_html(r.text)
    if len(text) < 200:
        logger.info(f"too-short body={len(text)}c url={url[:80]}")
        return None
    return text[:8000]


def summarize(title: str, body: str) -> Optional[str]:
    prompt = PROMPT_TEMPLATE.format(title=title[:300], body=body)
    try:
        r = requests.post(
            GATEWAY_URL,
            headers={
                "Content-Type": "application/json",
                "anthropic-version": "2023-06-01",
            },
            json={
                "model": GATEWAY_MODEL,
                "max_tokens": 400,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=GATEWAY_TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        logger.warning(f"gateway failed: {type(e).__name__}: {e}")
        return None

    text = ""
    for block in data.get("content", []):
        if block.get("type") == "text":
            text += block.get("text", "")
    text = text.strip()
    if len(text) < 30:
        return None
    return text


def select_pending(conn: sqlite3.Connection, limit: int, min_score: float):
    cur = conn.execute(
        """
        SELECT id, title, url, source_name, relevance_score
        FROM marks
        WHERE status = 'pending'
          AND (note IS NULL OR note = '')
          AND relevance_score >= ?
          AND url IS NOT NULL AND url <> ''
          AND url NOT LIKE 'https://www.google.com/search%'
        ORDER BY relevance_score DESC, id DESC
        LIMIT ?
        """,
        (min_score, limit),
    )
    return cur.fetchall()


def write_note(conn: sqlite3.Connection, mark_id: int, note: str) -> None:
    conn.execute("UPDATE marks SET note = ? WHERE id = ?", (note, mark_id))
    conn.commit()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="select but don't write")
    ap.add_argument("--limit", type=int, default=BATCH_LIMIT)
    ap.add_argument("--min-score", type=float, default=MIN_SCORE)
    args = ap.parse_args()

    if args.dry_run:
        logger.info("DRY RUN: no DB writes, no LLM calls")

    conn = sqlite3.connect(DB_PATH)
    rows = select_pending(conn, args.limit, args.min_score)
    if not rows:
        logger.info("no pending marks need enrichment")
        return 0

    logger.info(
        f"enriching {len(rows)} marks (min_score={args.min_score}, limit={args.limit})"
    )

    enriched = 0
    skipped_fetch = 0
    skipped_summary = 0
    t0 = time.time()

    for mark_id, title, url, source, score in rows:
        if args.dry_run:
            logger.info(f"  [{score:.2f}] {source:20s} #{mark_id} {title[:80]}")
            continue

        body = fetch_article(url)
        if not body:
            skipped_fetch += 1
            continue

        summary = summarize(title, body)
        if not summary:
            skipped_summary += 1
            continue

        write_note(conn, mark_id, summary)
        enriched += 1
        logger.info(
            f"enriched #{mark_id} score={score:.2f} {source:20s} {title[:60]}"
        )

    conn.close()
    logger.info(
        f"done: enriched={enriched} fetch_failed={skipped_fetch} "
        f"summary_failed={skipped_summary} elapsed={time.time()-t0:.1f}s"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
