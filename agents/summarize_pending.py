#!/usr/bin/env python3
"""Backfill ChipMonk 'insights' (marks.note) for approved marks with empty notes.

Backend is env-configurable (defaults to local Ollama for safety):
  OLLAMA_GENERATE_URL   default http://127.0.0.1:11434/api/generate
  OLLAMA_SUMMARY_MODEL  default llama3.2:1b
  OLLAMA_API_KEY        if set, sent as 'Authorization: Bearer ...' (Ollama Cloud)

Usage: summarize_pending.py [--source SUBSTR] [--limit N] [--order recent|score]
"""
import sqlite3, sys, time, re, json, argparse, os, urllib.request

DB = "/root/clawfeed/data/digest.db"

def _load_env_file(path="/root/clawfeed/.env"):
    """Read OLLAMA_* from .env directly (the file has bash-unsafe lines, so we
    cannot rely on the shell sourcing it). os.environ wins if already set."""
    try:
        for line in open(path):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            if k.startswith("OLLAMA") and k not in os.environ:
                os.environ[k] = v.strip()
    except FileNotFoundError:
        pass

_load_env_file()
GEN_URL = os.environ.get("OLLAMA_GENERATE_URL", "http://127.0.0.1:11434/api/generate")
MODEL = os.environ.get("OLLAMA_SUMMARY_MODEL", "llama3.2:1b")
API_KEY = os.environ.get("OLLAMA_API_KEY", "")
UA = "ChipMonkBot/1.0 (+https://chipmonk.tech)"

REFUSAL = re.compile(
    r"behind a paywall|content is not accessible|subscription landing page|"
    r"unable to (?:provide|complete|summarize|access)|"
    r"cannot (?:summarize|complete this task|provide)", re.I)

def fetch_text(url):
    if not url:
        return ""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        html = urllib.request.urlopen(req, timeout=10).read().decode("utf-8", "ignore")
        t = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
        t = re.sub(r"<style[\s\S]*?</style>", " ", t, flags=re.I)
        t = re.sub(r"<[^>]+>", " ", t)
        t = t.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        t = re.sub(r"&#\d+;", " ", t)
        return re.sub(r"\s+", " ", t).strip()[:3500]
    except Exception:
        return ""

def clean_summary(raw, title):
    s = (raw or "").strip()
    if not s or REFUSAL.search(s[:400]):
        return ""
    if title and len(title) > 12 and s.lower().startswith(title.lower()[:min(40, len(title))]):
        s = s[len(title):].lstrip(" :.—-\n")
    s = re.sub(r"\n\s*(?:Note|Notes|Disclaimer)\s*[:.][\s\S]*$", "", s, flags=re.I).strip()
    return s if len(s) >= 60 else ""

def summarize(title, url):
    body = fetch_text(url)
    body_block = f"Source text:\n{body}" if body else ""
    prompt = (
        "Write a brief about this chip-industry article. Output ONLY the body of the brief - "
        "no preface, no addressing the reader, no notes about your reasoning.\n\n"
        "Hard rules:\n"
        "- DO NOT repeat the title. Do not start with the title; do not insert it as a heading.\n"
        "- DO NOT use headings, bold, or bullet lists. Plain paragraphs only.\n"
        "- 2-3 short paragraphs, ~200 words total\n"
        "- Lead with concrete facts: companies, dollar amounts, dates, deals, numbers\n"
        "- Drop hype language and filler\n"
        "- If the source genuinely has no relevant content, write a single one-paragraph factual digest, no meta-commentary\n\n"
        f"Title (for context only - do not repeat): {title or ''}\n{body_block}\n\nBrief:"
    )
    payload = json.dumps({
        "model": MODEL, "prompt": prompt, "stream": False,
        "options": {"temperature": 0.25, "num_predict": 700,
                    "stop": ["Note:", "Note that:", "Disclaimer:"]}
    }).encode()
    headers = {"Content-Type": "application/json"}
    if API_KEY:
        headers["Authorization"] = "Bearer " + API_KEY
    req = urllib.request.Request(GEN_URL, data=payload, headers=headers)
    data = json.loads(urllib.request.urlopen(req, timeout=180).read())
    return clean_summary(data.get("response", ""), title), bool(body)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="")
    ap.add_argument("--limit", type=int, default=25)
    ap.add_argument("--order", choices=["recent", "score"], default="recent")
    ap.add_argument("--shard", default="", help="i/N — process only marks where id %% N == i")
    a = ap.parse_args()

    c = sqlite3.connect(DB, timeout=60)
    c.execute("PRAGMA busy_timeout=60000")
    c.execute("PRAGMA journal_mode=WAL")
    q = "SELECT id, title, url FROM marks WHERE COALESCE(note,'')='' "
    p = []
    if a.source:
        q += "AND source_name LIKE ? "
        p.append(f"%{a.source}%")
    if a.shard:
        i, n = (int(x) for x in a.shard.split("/"))
        q += f"AND (id % {n}) = {i} "
    q += ("ORDER BY relevance_score DESC, created_at DESC " if a.order == "score"
          else "ORDER BY created_at DESC ") + "LIMIT ?"
    p.append(a.limit)
    rows = list(c.execute(q, p))
    print(f"[summarize] backend={GEN_URL} model={MODEL} key={'yes' if API_KEY else 'no'}", flush=True)
    print(f"[summarize] {len(rows)} pending (source={a.source!r}, order={a.order}, limit={a.limit})", flush=True)

    done = skip = 0
    for mid, title, url in rows:
        try:
            s, sourced = summarize(title, url)
            if not s:
                skip += 1
                print(f"  skip {mid} (empty/refusal)", flush=True)
                continue
            c.execute("UPDATE marks SET note=?, status='approved' WHERE id=?", (s, mid))
            c.commit()
            done += 1
            print(f"  ok {mid} ({len(s)}c sourced={sourced}) {str(title)[:50]}", flush=True)
        except Exception as e:
            skip += 1
            print(f"  err {mid}: {e}", flush=True)
        time.sleep(0.4)
    print(f"[summarize] DONE done={done} skip={skip} of {len(rows)}", flush=True)

if __name__ == "__main__":
    main()
