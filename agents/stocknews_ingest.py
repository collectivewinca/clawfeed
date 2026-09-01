#!/usr/bin/env python3
"""ChipMonk Stock News Ingest — pulls Google News RSS per tracked ticker
and writes new headlines straight into the marks table.

Tracker rollups (agents/tracker_updater.py) then auto-aggregate them into
entity briefs. Dedupe is by URL (unique check against marks).

Run via PM2 cron. Idempotent.
"""

import os
import sys
import time
import sqlite3
import logging
import urllib.parse
from xml.etree import ElementTree as ET

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("stocknews-ingest")

DB_PATH = os.environ.get("CHIPMONK_DB", "/root/clawfeed/data/digest.db")

# (ticker, company_name, group)
TICKERS = [
    # Aschenbrenner Q1 2026 — new put positions
    ("NVDA", "NVIDIA", "ascn_put"),
    ("ORCL", "Oracle", "ascn_put"),
    ("AVGO", "Broadcom", "ascn_put"),
    ("AMD", "AMD", "ascn_put"),
    ("MU", "Micron", "ascn_put"),
    ("TSM", "Taiwan Semiconductor", "ascn_put"),
    ("ASML", "ASML", "ascn_put"),
    ("INTC", "Intel", "ascn_put"),
    # Aschenbrenner Q1 2026 — long stock book
    ("BE", "Bloom Energy", "ascn_long"),
    ("SNDK", "SanDisk", "ascn_long"),
    ("CRWV", "CoreWeave", "ascn_long"),
    ("IREN", "Iris Energy", "ascn_long"),
    ("CORZ", "Core Scientific", "ascn_long"),
    ("APLD", "Applied Digital", "ascn_long"),
    ("RIOT", "Riot Platforms", "ascn_long"),
    ("CLSK", "CleanSpark", "ascn_long"),
    ("SEI", "Solaris Energy Infrastructure", "ascn_long"),
    ("BITF", "Bitfarms", "ascn_long"),
    ("BTDR", "Bitdeer", "ascn_long"),
    ("PSIX", "Power Solutions International", "ascn_long"),
    ("BW", "Babcock Wilcox", "ascn_long"),
    ("PUMP", "ProPetro", "ascn_long"),
    ("HIVE", "Hive Digital", "ascn_long"),
    ("SHAZ", "Sharon AI", "ascn_long"),
    ("WYFI", "WhiteFiber", "ascn_long"),
    # ChipMonk picks (2026-06-08) - ChipMonk's own watch additions (surfaced via /last30days research)
    ("GEV",  "GE Vernova", "chipmonk_pick"),
    ("NBIS", "Nebius",     "chipmonk_pick"),
    ("WOLF", "Wolfspeed",  "chipmonk_pick"),
    # ChipMonk picks — hyperscaler power-deal counterparties + SMR/infra (2026-06-08)
    ("CEG",  "Constellation Energy", "chipmonk_pick"),
    ("TLN",  "Talen Energy",         "chipmonk_pick"),
    ("VST",  "Vistra",               "chipmonk_pick"),
    ("OKLO", "Oklo",                 "chipmonk_pick"),
    ("VRT",  "Vertiv",               "chipmonk_pick"),
]

PER_TICKER_LIMIT = int(os.environ.get("STOCKNEWS_PER_TICKER_LIMIT", "5"))
USER_AGENT = "ChipMonkBot/1.0 (+https://chipmonk.tech)"
SLEEP_BETWEEN = float(os.environ.get("STOCKNEWS_SLEEP", "0.8"))


def google_news_rss_url(company: str, ticker: str) -> str:
    q = f'"{company}" OR {ticker} stock'
    return (
        "https://news.google.com/rss/search?"
        + urllib.parse.urlencode({"q": q, "hl": "en-US", "gl": "US", "ceid": "US:en"})
    )


def parse_rss(xml_bytes: bytes) -> list[dict]:
    items = []
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        log.warning("parse error: %s", e)
        return items
    for it in root.iterfind(".//item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        if not title or not link:
            continue
        items.append({"title": title, "url": link})
    return items


def clean_google_title(title: str) -> str:
    # Google News titles are "Headline - Outlet". Drop the outlet.
    if " - " in title:
        head, _, _ = title.rpartition(" - ")
        return head.strip()
    return title


def upsert(conn: sqlite3.Connection, payload: dict) -> str:
    # Dedupe by url+source_name (matches across user_id=NULL inserts).
    existing = conn.execute(
        "SELECT id FROM marks WHERE url = ? AND source_name = ? LIMIT 1",
        (payload["url"], payload["source_name"]),
    ).fetchone()
    if existing:
        return "duplicate"
    cur = conn.execute(
        """INSERT OR IGNORE INTO marks (url, title, note, status, source_name, external_id, relevance_score, user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)""",
        (
            payload["url"],
            payload["title"],
            payload["note"],
            payload["status"],
            payload["source_name"],
            payload["external_id"],
            payload["relevance_score"],
        ),
    )
    # rowcount==0 => existing (url, source_name) under the unique index; handled duplicate.
    return "duplicate" if cur.rowcount == 0 else "inserted"


def main() -> int:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA busy_timeout = 5000;")
    inserted = duplicates = errors = 0
    try:
        for ticker, company, group in TICKERS:
            url = google_news_rss_url(company, ticker)
            try:
                r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=12)
                r.raise_for_status()
            except requests.RequestException as e:
                log.warning("%s fetch failed: %s", ticker, e)
                errors += 1
                continue
            items = parse_rss(r.content)[:PER_TICKER_LIMIT]
            source_name = f"stocknews_{group}_{ticker.lower()}"
            for it in items:
                title = clean_google_title(it["title"])
                # Tracker_updater matches by case-insensitive substring of company name in title.
                # Inject company name where Google News dropped it.
                if company.lower() not in title.lower() and ticker.lower() not in title.lower():
                    title = f"{company} — {title}"
                payload = {
                    "url": it["url"],
                    "title": title[:300],
                    "note": "",
                    "status": "approved",
                    "source_name": source_name,
                    "external_id": f"gnews:{ticker}:{abs(hash(it['url'])) % (10**12)}",
                    "relevance_score": 0.5,
                }
                try:
                    outcome = upsert(conn, payload)
                except sqlite3.Error as e:
                    log.warning("db error on %s: %s", payload["url"][:80], e)
                    errors += 1
                    continue
                if outcome == "duplicate":
                    duplicates += 1
                else:
                    inserted += 1
            conn.commit()
            time.sleep(SLEEP_BETWEEN)
    finally:
        conn.close()
    log.info("done: inserted=%d duplicates=%d errors=%d", inserted, duplicates, errors)
    return 0


if __name__ == "__main__":
    sys.exit(main())
