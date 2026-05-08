#!/usr/bin/env python3
"""ChipMonk Newsletter — weekly digest blast.

Composes a weekly newsletter from:
  1. The most recent daily Brief (digests table, type='daily')
  2. The current entity Trackers (config table, key like 'tracker:%')
  3. Top approved marks of the last 7 days
… and sends to active subscribers via Cloudflare Email Sending API.

Defaults to --dry-run. Pass --send to actually fire emails. Cron is
registered with --dry-run by default — flip when you trust it.
"""

import argparse
import json
import logging
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from email.utils import formataddr

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("newsletter")

DB_PATH = os.environ.get("CHIPMONK_DB", "/root/clawfeed/data/digest.db")

CF_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
CF_TOKEN = os.environ.get("CLOUDFLARE_EMAIL_TOKEN", "")
EMAIL_FROM = os.environ.get("EMAIL_FROM", "ChipMonk <hello@chipmonk.tech>")
EMAIL_REPLY_TO = os.environ.get("EMAIL_REPLY_TO", "")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://chipmonk.tech")

CF_API = (
    f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/email/sending/send"
)


def fetch_active_subscribers(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT email FROM subscribers WHERE status='active' ORDER BY created_at"
    ).fetchall()
    return [r[0] for r in rows]


def fetch_latest_brief(conn: sqlite3.Connection) -> dict | None:
    row = conn.execute(
        "SELECT id, content, created_at FROM digests "
        "WHERE type='daily' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if not row:
        return None
    return {"id": row[0], "content": row[1], "created_at": row[2]}


def fetch_trackers(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT key, value FROM config WHERE key LIKE 'tracker:%' ORDER BY key"
    ).fetchall()
    out = []
    for _key, val in rows:
        try:
            out.append(json.loads(val))
        except Exception:
            continue
    return out


def fetch_recent_approved(conn: sqlite3.Connection, limit: int = 10) -> list[tuple]:
    return conn.execute(
        """
        SELECT id, title, url, source_name, relevance_score, note, created_at
        FROM marks
        WHERE status='approved'
          AND created_at >= datetime('now', '-7 days')
        ORDER BY relevance_score DESC, created_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()


def md_to_html(md: str) -> str:
    """Tiny markdown → HTML for newsletter context. Headings, bold, lists, hr, p."""
    if not md:
        return ""

    def esc(s: str) -> str:
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def inline(s: str) -> str:
        s = esc(s)
        # Bold
        import re
        s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
        s = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", s)
        return s

    out_parts: list[str] = []
    in_list = False
    for raw in md.split("\n"):
        line = raw.strip()
        if not line:
            if in_list:
                out_parts.append("</ul>")
                in_list = False
            continue
        if line.startswith("---"):
            if in_list:
                out_parts.append("</ul>")
                in_list = False
            out_parts.append("<hr style='border:none;border-top:1px solid #ddd;margin:24px 0;'>")
            continue
        if line.startswith("### "):
            if in_list:
                out_parts.append("</ul>")
                in_list = False
            out_parts.append(f"<h3 style='font-size:16px;margin:20px 0 8px;'>{inline(line[4:])}</h3>")
            continue
        if line.startswith("## "):
            if in_list:
                out_parts.append("</ul>")
                in_list = False
            out_parts.append(f"<h2 style='font-size:20px;margin:24px 0 10px;'>{inline(line[3:])}</h2>")
            continue
        if line.startswith("# "):
            if in_list:
                out_parts.append("</ul>")
                in_list = False
            out_parts.append(f"<h1 style='font-size:24px;margin:24px 0 12px;'>{inline(line[2:])}</h1>")
            continue
        if line.startswith("- ") or line.startswith("* "):
            if not in_list:
                out_parts.append("<ul style='padding-left:20px;margin:8px 0;'>")
                in_list = True
            out_parts.append(f"<li style='margin:4px 0;'>{inline(line[2:])}</li>")
            continue
        if in_list:
            out_parts.append("</ul>")
            in_list = False
        out_parts.append(f"<p style='margin:10px 0;line-height:1.6;color:#333;'>{inline(line)}</p>")
    if in_list:
        out_parts.append("</ul>")
    return "".join(out_parts)


def build_newsletter(
    brief: dict | None,
    trackers: list[dict],
    approved: list[tuple],
    week_label: str,
) -> tuple[str, str, str]:
    """Return (subject, html, plaintext)."""
    subject = f"ChipMonk — Week of {week_label}"

    # --- HTML ---
    parts = [
        "<!doctype html><html><body style='font-family:-apple-system,Segoe UI,Inter,sans-serif;",
        "max-width:680px;margin:0 auto;padding:24px;color:#0f172a;'>",
        f"<div style='font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#64748b;'>ChipMonk — Silicon Intelligence Hub</div>",
        f"<h1 style='font-size:28px;margin:8px 0 24px;'>Week of {week_label}</h1>",
    ]
    if brief:
        parts.append("<div style='border-left:3px solid #0f172a;padding-left:16px;margin-bottom:32px;'>")
        parts.append(md_to_html(brief["content"]))
        parts.append("</div>")
    if trackers:
        parts.append("<h2 style='font-size:20px;margin:32px 0 12px;'>Entity trackers</h2>")
        for t in trackers:
            if not t.get("summary"):
                continue
            parts.append("<div style='background:#fafafa;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:8px 0;'>")
            parts.append(md_to_html(t["summary"]))
            parts.append(f"<div style='font-size:11px;color:#94a3b8;margin-top:8px;'>{t.get('mark_count',0)} stories · updated {t.get('last_updated','')[:10]}</div>")
            parts.append("</div>")
    if approved:
        parts.append("<h2 style='font-size:20px;margin:32px 0 12px;'>Approved this week</h2>")
        for (mid, title, url, source, score, note, created) in approved:
            parts.append("<div style='border-bottom:1px solid #e5e7eb;padding:12px 0;'>")
            parts.append(f"<div style='font-size:11px;color:#94a3b8;'>{source} · {created[:10]} · score {int(score*100)}%</div>")
            parts.append(f"<div style='font-weight:600;margin:4px 0;'><a href='{url}' style='color:#0f172a;text-decoration:none;'>{title}</a></div>")
            if note:
                first = note.split('\n\n')[0][:300]
                parts.append(f"<div style='font-size:13px;color:#475569;line-height:1.5;'>{md_to_html(first)}</div>")
            parts.append("</div>")
    parts.append("<div style='font-size:11px;color:#94a3b8;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:16px;'>")
    parts.append(f"You received this because you subscribed at {PUBLIC_BASE_URL}/blog. ")
    parts.append(f"<a href='{PUBLIC_BASE_URL}/unsubscribe?email={{EMAIL}}' style='color:#94a3b8;'>Unsubscribe</a>.")
    parts.append("</div>")
    parts.append("</body></html>")
    html = "".join(parts)

    # --- Plaintext (fallback) ---
    plain_parts = [f"ChipMonk — Week of {week_label}\n\n"]
    if brief:
        plain_parts.append(brief["content"] + "\n\n---\n\n")
    if trackers:
        plain_parts.append("ENTITY TRACKERS\n\n")
        for t in trackers:
            if t.get("summary"):
                plain_parts.append(t["summary"].replace("**", "") + "\n\n")
    if approved:
        plain_parts.append("\nAPPROVED THIS WEEK\n\n")
        for (mid, title, url, source, score, note, created) in approved:
            plain_parts.append(f"- {title}\n  {url}\n  {source} · {created[:10]} · score {int(score*100)}%\n\n")
    plain_parts.append(f"\n--\nUnsubscribe: {PUBLIC_BASE_URL}/unsubscribe\n")
    plain = "".join(plain_parts)
    return subject, html, plain


def cf_send(to: str, subject: str, html: str, plain: str) -> bool:
    if not CF_TOKEN or not CF_ACCOUNT_ID:
        logger.error("missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_EMAIL_TOKEN")
        return False
    # Gmail/Yahoo bulk-sender rules require List-Unsubscribe + one-click POST
    # support since Feb 2024. Without these, mail to >5K Gmail recipients per
    # day from the same domain gets rate-limited / spam-foldered. Even at
    # low volume, the headers significantly improve inbox placement.
    unsub_url = f"{PUBLIC_BASE_URL}/api/unsubscribe?email={to}"
    list_unsub = f"<mailto:{EMAIL_REPLY_TO or 'unsubscribe@minyvinyl.com'}?subject=unsubscribe>, <{unsub_url}>"
    payload = {
        "from": EMAIL_FROM,
        "to": to,
        "subject": subject,
        "html": html.replace("{EMAIL}", to),
        "text": plain,
        "headers": {
            "List-Unsubscribe": list_unsub,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            "List-Id": f"ChipMonk Newsletter <newsletter.{PUBLIC_BASE_URL.replace('https://','').replace('http://','')}>",
            "Precedence": "bulk",
        },
    }
    if EMAIL_REPLY_TO:
        payload["reply_to"] = EMAIL_REPLY_TO
    try:
        r = requests.post(
            CF_API,
            headers={
                "Authorization": f"Bearer {CF_TOKEN}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=20,
        )
        if not r.ok:
            logger.error(f"send to {to} failed: {r.status_code} {r.text[:300]}")
            return False
        # Cloudflare returns success:false even on HTTP 200 if validation rejects.
        try:
            data = r.json()
            if isinstance(data, dict) and data.get("success") is False:
                logger.error(f"send to {to} rejected: {data.get('errors')}")
                return False
        except Exception:
            pass
        return True
    except Exception as e:
        logger.error(f"send to {to} crashed: {type(e).__name__}: {e}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--send", action="store_true",
                    help="actually send emails (default: dry-run)")
    ap.add_argument("--limit", type=int, default=None,
                    help="cap number of recipients (testing)")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    subs = fetch_active_subscribers(conn)
    if args.limit:
        subs = subs[: args.limit]

    if not subs:
        logger.info("no active subscribers — nothing to send")
        return 0

    brief = fetch_latest_brief(conn)
    trackers = fetch_trackers(conn)
    approved = fetch_recent_approved(conn)

    week_label = datetime.now(timezone.utc).strftime("%b %d, %Y")
    subject, html, plain = build_newsletter(brief, trackers, approved, week_label)

    logger.info(
        f"composed newsletter — subject={subject!r}, html={len(html)}c, "
        f"plain={len(plain)}c, recipients={len(subs)}"
    )

    if not args.send:
        logger.info("DRY RUN: not sending. Pass --send to fire emails.")
        # Save preview to disk for inspection
        preview_path = "/tmp/newsletter_preview.html"
        with open(preview_path, "w") as f:
            f.write(html)
        logger.info(f"preview html written to {preview_path}")
        return 0

    sent = 0
    failed = 0
    for to in subs:
        if cf_send(to, subject, html, plain):
            sent += 1
            logger.info(f"sent → {to}")
        else:
            failed += 1
        time.sleep(0.5)  # gentle pacing
    logger.info(f"done: sent={sent} failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
