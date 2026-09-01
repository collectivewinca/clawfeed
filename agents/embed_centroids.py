#!/usr/bin/env python3
"""ChipMonk Embedding Centroid Builder.

For each approved mark in the last 180 days, compute its title embedding
via the exe.dev OpenAI gateway. Average them into an "approved centroid"
that represents the user's chip-relevance taste. Same for rejected marks.

Save both centroids + metadata to /root/clawfeed/data/centroids.json.
The scorer (llm_relevance.py) loads this file and adds an embedding-
similarity term to each new item's score.

Runs daily after FeedbackTuner. Approved-only mode works fine until the
user accumulates rejections — the rejected_centroid is optional.
"""

import argparse
import json
import logging
import os
import sqlite3
import sys
import time
from typing import List

import numpy as np
import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("embed-centroids")

DB_PATH = os.environ.get("CHIPMONK_DB", "/root/clawfeed/data/digest.db")
OUT_PATH = os.environ.get("CHIPMONK_CENTROIDS", "/root/clawfeed/data/centroids.json")

GATEWAY_URL = os.environ.get(
    "EMBED_URL", "http://127.0.0.1:11434/v1/embeddings"
)
EMBED_MODEL = os.environ.get("EMBED_MODEL", "embeddinggemma")
EMBED_TIMEOUT = float(os.environ.get("EMBED_TIMEOUT", "20"))

WINDOW_DAYS = int(os.environ.get("CENTROID_WINDOW_DAYS", "180"))
BATCH_SIZE = 32  # OpenAI accepts an array; do 32 titles per request

# Don't use a single mark to define a centroid — too noisy. Need at least
# this many on each side before the scorer trusts the signal.
MIN_APPROVED = int(os.environ.get("MIN_APPROVED", "5"))
MIN_REJECTED = int(os.environ.get("MIN_REJECTED", "5"))


def fetch_titles(conn: sqlite3.Connection, status: str) -> list[tuple[int, str]]:
    rows = conn.execute(
        f"""
        SELECT id, title FROM marks
        WHERE status = ?
          AND title IS NOT NULL AND title <> ''
          AND created_at >= datetime('now', '-{WINDOW_DAYS} days')
        ORDER BY id DESC
        LIMIT 500
        """,
        (status,),
    ).fetchall()
    return [(r[0], r[1]) for r in rows]


def embed_batch(texts: List[str]) -> List[List[float]] | None:
    try:
        r = requests.post(
            GATEWAY_URL,
            headers={"Content-Type": "application/json"},
            json={"model": EMBED_MODEL, "input": texts},
            timeout=EMBED_TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        return [d["embedding"] for d in data.get("data", [])]
    except Exception as e:
        logger.error(f"embed batch failed: {type(e).__name__}: {e}")
        return None


def embed_all(titles: list[str]) -> np.ndarray | None:
    if not titles:
        return None
    vecs: list[list[float]] = []
    for i in range(0, len(titles), BATCH_SIZE):
        batch = titles[i : i + BATCH_SIZE]
        result = embed_batch(batch)
        if result is None:
            logger.warning(f"batch starting at {i} failed; skipping")
            continue
        if len(result) != len(batch):
            logger.warning(f"batch returned {len(result)} != {len(batch)} embeddings")
        vecs.extend(result)
        time.sleep(0.2)  # gentle pacing
    if not vecs:
        return None
    return np.array(vecs, dtype=np.float32)


def centroid(arr: np.ndarray) -> np.ndarray:
    """L2-normalized mean vector."""
    mean = arr.mean(axis=0)
    norm = np.linalg.norm(mean)
    if norm == 0:
        return mean
    return mean / norm


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    approved = fetch_titles(conn, "approved")
    rejected = fetch_titles(conn, "rejected")
    conn.close()

    logger.info(
        f"window {WINDOW_DAYS}d: approved={len(approved)} rejected={len(rejected)}"
    )

    out = {
        "model": EMBED_MODEL,
        "window_days": WINDOW_DAYS,
        "computed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "approved_count": len(approved),
        "rejected_count": len(rejected),
        "approved_centroid": None,
        "rejected_centroid": None,
        "min_approved": MIN_APPROVED,
        "min_rejected": MIN_REJECTED,
    }

    if len(approved) < MIN_APPROVED:
        logger.info(f"approved < {MIN_APPROVED}, skipping approved centroid")
    elif args.dry_run:
        logger.info(f"DRY RUN: would embed {len(approved)} approved titles")
    else:
        t0 = time.time()
        a_vecs = embed_all([t for _, t in approved])
        if a_vecs is not None and len(a_vecs) >= MIN_APPROVED:
            cent = centroid(a_vecs)
            out["approved_centroid"] = cent.tolist()
            out["approved_embedded"] = len(a_vecs)
            logger.info(
                f"approved centroid built from {len(a_vecs)} titles in {time.time()-t0:.1f}s"
            )
        else:
            logger.warning("approved embedding failed or empty")

    if len(rejected) < MIN_REJECTED:
        logger.info(f"rejected < {MIN_REJECTED}, skipping rejected centroid")
    elif args.dry_run:
        logger.info(f"DRY RUN: would embed {len(rejected)} rejected titles")
    else:
        t0 = time.time()
        r_vecs = embed_all([t for _, t in rejected])
        if r_vecs is not None and len(r_vecs) >= MIN_REJECTED:
            cent = centroid(r_vecs)
            out["rejected_centroid"] = cent.tolist()
            out["rejected_embedded"] = len(r_vecs)
            logger.info(
                f"rejected centroid built from {len(r_vecs)} titles in {time.time()-t0:.1f}s"
            )
        else:
            logger.warning("rejected embedding failed or empty")

    if not args.dry_run:
        os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
        with open(OUT_PATH, "w") as f:
            json.dump(out, f)
        logger.info(f"wrote {OUT_PATH}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
