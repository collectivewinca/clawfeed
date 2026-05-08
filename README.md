# ChipMonk

> **Where the silicon signal lives.**

A focused intelligence brief on AI accelerators, semiconductor industry, fab capacity, and chip architecture. Distilled from primary sources, summarized by a local language model, and surfaced as a public feed at **[chipmonk.tech](https://chipmonk.tech)**.

ChipMonk is a hard fork of the [ClawFeed](https://github.com/collectivewinca/clawfeed) engine, adapted from a generic news digest into a Silicon-focused product.

---

## Live

| | |
|---|---|
| Public site | [https://chipmonk.tech](https://chipmonk.tech) |
| Origin | [https://chipmonk.exe.xyz](https://chipmonk.exe.xyz) (exe.dev VM) |
| Repo | `collectivewinca/chipmonk` (this) — track `chipmonk-baseline` branch |
| Engine upstream | `collectivewinca/clawfeed` (track `upstream/main`) |

## Stack

```
[ Sliver (Python) ─ scheduled 06/14/22 UTC ─ scrapes RSS feeds, scores, posts to API ]
                                            │
                                            ▼
[ Caddy :80 ] ──reverse-proxy──► [ Node :8767 ] ◄── SQLite (digest.db)
                                       │
                                       ├─ /                landing
                                       ├─ /blog            insights feed
                                       ├─ /about           market overview
                                       ├─ /dashboard       admin console
                                       ├─ /api/showcase    public approved marks
                                       ├─ /api/subscribe   newsletter (CF Email)
                                       └─ /api/marks/:id/summarize  Ollama
                                                                          │
                                                                          ▼
                                                            [ Ollama llama3.2:1b ]
```

- **Frontend:** Tailwind via CDN, Inter + JetBrains Mono, light theme
- **Backend:** Node 20, no framework, raw `http` module — `src/server.mjs`
- **Database:** SQLite via `better-sqlite3` — `data/digest.db`
- **AI:** Local Ollama on `127.0.0.1:11434`, model `llama3.2:1b`
- **Ingest:** Sliver topic aggregator (RSS feeds: semiwiki, EE Times, DigiTimes, SemiAnalysis, The Robot Report)
- **Email:** Cloudflare Email Sending API (welcome + admin broadcast)
- **Process:** PM2 on the VM (no systemd as PID 1)

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | public | Landing page (showcase) |
| GET | `/blog` | public | Insights feed (renders approved marks) |
| GET | `/about` | public | Market overview |
| GET | `/dashboard` | public HTML; API needs admin | Admin console |
| GET | `/admin/login?key=<API_KEY>` | API key | Sets `cm_admin` cookie |
| GET | `/api/health` | public | `{"status":"ok"}` |
| GET | `/api/showcase` | public | Approved marks |
| POST | `/api/subscribe` | public | Newsletter signup (sends welcome email) |
| GET | `/api/subscribers/count` | public | Total active subscribers |
| GET | `/api/subscribers` | admin | List subscribers |
| POST | `/api/newsletter/send` | admin | Broadcast to all subscribers |
| POST | `/api/marks/:id/summarize` | admin | Ollama summarize + auto-approve |
| PUT | `/api/marks/:id/status` | admin | Approve/reject mark |

## Auth model

**No `GOOGLE_CLIENT_ID` is configured.** Admin access is gated by a shared `API_KEY`:

- **Server-to-server:** send `X-Admin-Key: <API_KEY>` header
- **Browser:** visit `/admin/login?key=<API_KEY>` once; sets `cm_admin` cookie that holds `HMAC-SHA256(API_KEY, "cm_admin:v1")` (HttpOnly, Secure, SameSite=Lax, 30-day max-age). The raw API_KEY is never sent in the cookie.

To enable Google OAuth instead, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.

## Environment

`/root/clawfeed/.env` on the VM (gitignored):

```sh
SESSION_SECRET=<random>
API_KEY=<random>
DIGEST_PORT=8767
ALLOWED_ORIGINS=chipmonk.tech,chipmonk.exe.xyz

# Cloudflare Email Sending (welcome + broadcast)
CLOUDFLARE_ACCOUNT_ID=<from CF dashboard>
CLOUDFLARE_EMAIL_TOKEN=<scoped: Account · Email Sending · Send>
EMAIL_FROM=ChipMonk Newsletter <digest@minyvinyl.com>
EMAIL_REPLY_TO=hello@collectivewin.ca

NEWSLETTER_BRAND=ChipMonk
PUBLIC_BASE_URL=https://chipmonk.tech
```

See `.env.example` for the full template.

## Deployment

This is a single-VM deployment on exe.dev:

```sh
ssh exedev@chipmonk.exe.xyz
# /root/clawfeed/  is the working tree (canonical source)
# /root/sliver/    is the topic aggregator
pm2 status                  # show clawfeed + sliver-batch
pm2 logs clawfeed --lines 50
pm2 restart clawfeed --update-env
```

The VM's `/root/clawfeed` is **canonical** — git pushes from this repo to the VM is not how we deploy. Instead, we edit on the VM, commit on the `chipmonk-baseline` branch, and push to GitHub from the VM clone for backup/audit.

Cloudflare DNS is set so `chipmonk.tech` is a CNAME → `chipmonk.exe.xyz` with **proxied = false (grey cloud)**. exe.dev's edge auto-issues an LE cert for the custom domain on first request. Don't enable CF proxy on the apex — it breaks exe.dev's hostname routing.

## Sliver ingest

```sh
# Manual run (rare):
ssh exedev@chipmonk.exe.xyz '/root/sliver/run-clawfeed-push.sh'

# Scheduled (PM2 cron):
pm2 describe sliver-batch    # cron: 0 6,14,22 * * * UTC, no autorestart
```

The wrapper script at `/root/sliver/run-clawfeed-push.sh` exports `PYTHONPATH=/root/sliver/src` before invoking `scripts/push_to_clawfeed.py`. **This is load-bearing** — `pip install -e .` puts a stale copy in `site-packages/` that wins on `sys.path` without the override.

## Ollama summarization

`POST /api/marks/:id/summarize` does:
1. SSRF-safe fetch of `mark.url` with 10s timeout
2. Strip HTML to plain text, truncate to 3500 chars
3. Send to local Ollama `llama3.2:1b` with a chip-hardware-focused prompt (low temperature, 350 tokens cap)
4. Persist as `note`, mark `status='approved'`
5. Return `{ ok, summary, sourcedBody: bool }`

Roughly 50–60s per mark on this VM's CPU.

## Newsletter

The `/api/subscribe` endpoint:
- Validates email + dedupes via `UNIQUE COLLATE NOCASE`
- Stores hashed source IP for abuse traceability
- Fires a fire-and-forget welcome email via the Cloudflare Email Sending API (only on first subscribe)

Admin broadcast:

```sh
curl -X POST https://chipmonk.tech/api/newsletter/send \
  -H "X-Admin-Key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"subject":"Silicon dispatch — ...","html":"<p>...</p>","text":"...","dryRun":true}'
```

## Repo conventions

```
.
├── README.md              ← you are here
├── CHIPMONK.md            ← what's chipmonk-specific vs upstream clawfeed
├── PROJECT_UPDATE.md      ← session-by-session status notes
├── migrations/            ← SQL migrations 001-012 (012 = subscribers)
├── src/
│   ├── server.mjs         ← request router, all routes, CF email helpers
│   └── db.mjs             ← SQLite wrapper + migration runner
├── web/
│   ├── showcase.html      ← /
│   ├── blog.html          ← /blog
│   ├── about.html         ← /about
│   └── index.html         ← /dashboard (upstream-derived, light-themed)
└── data/                  ← SQLite db, gitignored
```

**Branch policy:**
- `chipmonk-baseline` is the working branch (deploys here)
- `main` is the legacy React/Vercel/StackBlitz version (kept for archive)
- Sync upstream engine fixes via `git fetch upstream && git cherry-pick <sha>`

## License

MIT, inherited from upstream ClawFeed. See `LICENSE`.
