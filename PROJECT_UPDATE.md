# ChipMonk — Project Update

**Date:** 2026-05-05
**Branch:** `chipmonk-baseline`
**Live:** [https://chipmonk.tech](https://chipmonk.tech)

---

## Where we are

ChipMonk migrated from a static React/Vercel deployment to a single self-hosted exe.dev VM in late April / early May 2026. The site is now live, dynamic, and ingesting real chip-hardware articles automatically three times a day.

| | |
|---|---|
| Site status | 🟢 live (TLS via Let's Encrypt, served by exe.dev edge → Caddy → Node) |
| Marks in DB | 15 approved articles (all real chip-hardware URLs) |
| Ingest cadence | 3×/day at 06:00 / 14:00 / 22:00 UTC via PM2 cron |
| Newsletter | wired (CF Email Sending API), 0 subscribers yet |
| Repo | `collectivewinca/chipmonk` `chipmonk-baseline` branch — synced from VM |

## What landed in this session (chronological)

### 1. Audit + handover correction

The original handover described an automation pipeline that didn't actually exist:

- **Claim:** "Mac cron runs `trend-monitor.sh` every 6h → GitHub Actions → VM API."
- **Reality:** Mac cron was already retired (`crontab -l` returned a comment saying so), and there is no GitHub Actions workflow ingesting into ChipMonk. The data loop was a one-shot manual run of `run-batch-score.sh`.
- **Discovered:** `run-batch-score.sh` in Sliver is a misnomer — it calls `python -m sliver_batch.main`, which scores topics but **never pushes to ClawFeed**. Only `scripts/push_to_clawfeed.py` actually ingests. So even if the cron had been wired up, no marks would ever appear.

### 2. Repo separation (`feat: ChipMonk migration baseline`)

- The VM's `/root/clawfeed/` was a clone of upstream `clawfeed` with all chipmonk migration changes uncommitted on disk — a `git pull` would have nuked the work.
- Created `chipmonk-baseline` branch on top of upstream `38b43f0`, committed all drift as a single baseline (10 files, +528/-596).
- Renamed remote `origin` → `upstream`. Pushed to `collectivewinca/chipmonk` as a new branch alongside the legacy React `main`.

### 3. Critical security fix (`feat: kill public-admin bypass`)

`server.mjs` had:
```js
if (!GOOGLE_CLIENT_ID) {
  req.user = { id: 1, email: 'admin@chipmonk.tech', ... };
  return;
}
```
With no `GOOGLE_CLIENT_ID` configured, **every unauthenticated request became admin** — anyone on the internet could approve marks, trigger Ollama summaries, or POST new ingest data. Combined with `Access-Control-Allow-Origin: *`, this was a public CMS.

Replaced with API-key gating:
- `X-Admin-Key: <API_KEY>` header for server-to-server
- `cm_admin` cookie set via `GET /admin/login?key=<API_KEY>` for browsers
- Cookie value is `HMAC-SHA256(API_KEY, "cm_admin:v1")` — the raw key never leaves the server

### 4. Sliver URL bug fix (`fix: preserve real article URLs from RSS feeds`)

`push_to_clawfeed.py` was discarding the canonical article URLs from RSS feeds and synthesizing Google search URLs from titles:

```python
# old
url = f"https://www.google.com/search?q={topic}"
```

When ChipMonk's summarizer fetched `mark.url`, it grabbed Google's search results page instead of the real article — which is why every existing summary was hallucinated boilerplate.

Fix: added `GenericRSSTrendingSource.get_topics_with_links()` returning `(title, link)` pairs, refactored `_extract_titles → _extract_items` to also pull the `<link>` element from RSS 1.0 / 2.0 / Atom. `push_to_clawfeed.py` now uses the real RSS link when available.

Pushed to `collectivewinca/sliver` as `19919a3`.

### 5. Summarize prompt improvement (`feat(summarize): fetch article body, sharpen prompt`)

The original prompt fed the LLM only the title and URL. With the URL fix above, body-fetch is now meaningful. Endpoint now:
- SSRF-safe fetches `mark.url` (10s timeout)
- Strips HTML to text, truncates to 3500 chars
- Uses a chip-hardware-focused prompt (process nodes, fab partners, TFLOPS / dollars / watts) at temperature 0.3
- Returns `sourcedBody: bool` so the dashboard can flag low-confidence summaries

### 6. Sliver scheduling (PM2 cron)

Added `/root/sliver/run-clawfeed-push.sh` with the load-bearing `PYTHONPATH=/root/sliver/src` override (else `site-packages` wins and Sliver runs stale code without the URL fix). Registered as PM2 process `sliver-batch` with `cron_restart: 0 6,14,22 * * *` UTC, `autorestart: false`. `pm2 save` persists across reboot.

### 7. Mark cleanup

The 263 pre-fix marks (all with synthesized Google search URLs) were archived to `marks_synthesized_url_archive_20260504` and dropped from the active table. Backfilled with one fresh Sliver run → 15 industry-chip articles with real URLs. Bulk-summarized via the patched endpoint.

### 8. Light-theme redesign (`feat: light-theme redesign + remove upstream branding/i18n`)

Replaced the dark theme + squirrel emoji branding with a modern light aesthetic (Vercel/Linear feel, slate/blue palette, Inter + JetBrains Mono, generous whitespace, stylized chip-pin SVG mark). Removed:
- "AI NEWS DIGEST — POWERED BY Jessie@ZylosAI, Lisa@OpenClaw" attribution
- Bug-fix banner with `t.me/CocoAIxyz`
- GitHub link in More menu (`github.com/kevinho/clawfeed`)
- Entire zh i18n object + Chinese tab labels (`简报 / 日报 / 周报 / 月报`)
- `_digestTitle` Chinese strings in `server.mjs`

Added a "Silicon Sangha" community CTA — fusion of silicon (chip) + sangha (monastic community).

### 9. Newsletter feature (`feat: newsletter subscription`)

- Migration `012_subscribers.sql`: subscribers table (email UNIQUE NOCASE, source, status, ip_hash, created_at)
- 4 new endpoints: subscribe (public), count (public), list (admin), unsubscribe (public)
- Subscribe form on `/` (full section) and `/blog` (compact card), with live count
- Validates email, dedupes via UNIQUE constraint, stores HMAC-hashed IP

### 10. Cloudflare Email Sending integration (`feat(newsletter): send welcome email via CF`)

Reused the same Cloudflare Email Sending API that Zeus uses for digest highlights:

- `POST https://api.cloudflare.com/client/v4/accounts/<id>/email/sending/send`
- Sender domain: `digest@minyvinyl.com` (already verified for `*.minyvinyl.com`)
- From-display: "ChipMonk Newsletter" via RFC 5322 friendly-name format
- Reply-To: `hello@collectivewin.ca` (your Google Workspace inbox)
- Welcome email fires fire-and-forget on first subscribe; admin broadcast endpoint for weekly dispatch

CF accepts `reply_to` in snake_case but rejects `replyTo` (`code 10001 invalid_request_schema`).

### 11. Site live — TLS via exe.dev edge

Cloudflare in front of `chipmonk.tech` was originally proxied (orange cloud) which produced an infinite 301 loop on every URL (CF Flexible) or 525 SSL handshake fail (CF Full) — both because exe.dev's edge does hostname-aware routing only for registered domains, and CF replaces the CNAME target with CF IPs.

Fix: flip CF DNS to **grey cloud** (proxied=false). exe.dev's edge then sees the request directly, auto-issues a Let's Encrypt cert (~3 min provisioning), and routes correctly. Free CF plans must use grey cloud for any `*.exe.xyz`-backed origin; paid plans can keep the proxy with a Snippets/Worker to rewrite Host.

## Open items

| Status | Item | Owner |
|---|---|---|
| ⏸ blocked on dashboard | Cloudflare Email **Routing** for chipmonk.tech (forward `@chipmonk.tech` → `hello@collectivewin.ca`). Token lacks `Zone:Email Routing:Edit`. 30-second dashboard click. | user |
| ⏸ blocked on dashboard | Verify `chipmonk.tech` as a sender domain in CF Email Sending. Once verified, swap `EMAIL_FROM` to `newsletter@chipmonk.tech`. | user |
| 🟡 nice-to-have | Hand-curated intro blog post (e.g., "Introducing ChipMonk") so the feed has a non-news anchor entry | optional |
| 🟡 nice-to-have | "Marketplace" feature — currently a conceptual landing page only. No demand signal yet. | future |
| 🟡 cleanup | Honor PM2 startup persistence on reboot was missing — `pm2 save` ran 2026-05-04 to fix. Consider a startup smoke-test cron. | optional |

## How to verify

```sh
# Public
curl -sI https://chipmonk.tech/
curl -sI https://chipmonk.tech/api/health
curl -s  https://chipmonk.tech/api/showcase | jq 'length'

# Admin (replace <API_KEY>)
curl -s https://chipmonk.tech/api/subscribers/count
curl -sH "X-Admin-Key: <API_KEY>" https://chipmonk.tech/api/subscribers

# Verify Sliver schedule
ssh exedev@chipmonk.exe.xyz 'pm2 describe sliver-batch'

# DB state
ssh exedev@chipmonk.exe.xyz \
  '/bin/sqlite3 /root/clawfeed/data/digest.db \
    "SELECT status, COUNT(*) FROM marks GROUP BY status"'
```

## Commit log (this session)

```
db44f5c  feat: newsletter subscription (POST /api/subscribe + UI on showcase + blog)
ec2b6c8  feat(newsletter): send welcome email via Cloudflare Email Sending API
cc753ea  feat(newsletter): friendly From-name + Reply-To header
3c7e404  fix: point Silicon Sangha CTA to https://anything.network (drop Telegram)
5999752  feat: light-theme redesign + remove upstream branding/i18n
85bbe7a  feat(summarize): fetch article body, sharpen prompt for chip-hardware focus
946e5b8  feat: ChipMonk migration baseline
```

Plus on `collectivewinca/sliver` `sliver` branch:
```
19919a3  fix: preserve real article URLs from RSS feeds
```
