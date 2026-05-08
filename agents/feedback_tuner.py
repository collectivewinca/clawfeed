#!/usr/bin/env python3
"""ChipMonk FeedbackTuner — turns approve/reject decisions into scorer bias.

For each source, computes a quality weight based on the last 90 days of
manual approve/reject decisions in the dashboard. Writes weights to the
config table as `feedback:source:<name>` with JSON value
{weight, approved, rejected, total, last_updated}.

The scorer (llm_relevance.py) reads these weights and multiplies the
final score by the source's weight (clamped 0.5-1.5). Sources that
consistently produce approved marks get up to +50% bias; sources that
get rejected get down to -50%. New / unjudged sources stay neutral (1.0).
"""

import argparse
import json
import logging
import math
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("feedback-tuner")

DB_PATH = os.environ.get("CHIPMONK_DB", "/root/clawfeed/data/digest.db")
WINDOW_DAYS = int(os.environ.get("FEEDBACK_WINDOW_DAYS", "90"))
MIN_TOTAL = int(os.environ.get("FEEDBACK_MIN_TOTAL", "3"))
WEIGHT_MIN = float(os.environ.get("FEEDBACK_WEIGHT_MIN", "0.5"))
WEIGHT_MAX = float(os.environ.get("FEEDBACK_WEIGHT_MAX", "1.5"))


def fetch_per_source(conn: sqlite3.Connection):
    sql = f"""
        SELECT source_name,
               SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
               SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
               COUNT(*) AS total
        FROM marks
        WHERE source_name IS NOT NULL
          AND status IN ('approved', 'rejected')
          AND created_at >= datetime('now', '-{WINDOW_DAYS} days')
        GROUP BY source_name
    """
    return conn.execute(sql).fetchall()


def compute_weight(approved: int, rejected: int) -> float:
    """Map (approved, rejected) → multiplier in [WEIGHT_MIN, WEIGHT_MAX].

    Beta-style smoothing with a +1 prior on each side, then a log scaling
    so weight tilts harder once you have real volume of decisions.
    """
    a, r = approved + 1, rejected + 1
    rate = a / (a + r)  # 0..1; 0.5 = neutral
    # Center on 1.0 and scale ±0.5 with a confidence factor based on volume
    confidence = min(1.0, math.log10(approved + rejected + 1) / 1.5)  # 0..1
    weight = 1.0 + (rate - 0.5) * 2 * 0.5 * confidence
    return round(max(WEIGHT_MIN, min(WEIGHT_MAX, weight)), 3)


def upsert_config(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO config (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    rows = fetch_per_source(conn)
    if not rows:
        logger.info("no labeled marks in window — nothing to tune")
        return 0

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    updated = 0
    skipped = 0

    logger.info(f"computing weights from last {WINDOW_DAYS}d ({len(rows)} sources)")
    for source, approved, rejected, total in rows:
        if total < MIN_TOTAL:
            logger.info(f"  {source:20s} skip (total={total} < {MIN_TOTAL})")
            skipped += 1
            continue

        weight = compute_weight(approved, rejected)
        payload = json.dumps({
            "source": source,
            "weight": weight,
            "approved": approved,
            "rejected": rejected,
            "total": total,
            "window_days": WINDOW_DAYS,
            "last_updated": now,
        })

        if args.dry_run:
            logger.info(f"  {source:20s} a={approved:3d} r={rejected:3d} → weight={weight}")
        else:
            upsert_config(conn, f"feedback:source:{source}", payload)
            logger.info(f"  {source:20s} a={approved:3d} r={rejected:3d} → weight={weight}")
            updated += 1

    if not args.dry_run:
        conn.commit()
    conn.close()
    logger.info(f"done: updated={updated} skipped={skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
