# ChipMonk

ChipMonk is a Silicon-focused intelligence hub built on top of the
[ClawFeed](https://github.com/collectivewinca/clawfeed) engine. This repository
is a hard fork of ClawFeed at commit `38b43f0` and diverges from there.

## What is chipmonk-specific

- `web/showcase.html` - landing page (Silicon Gold Rush)
- `web/blog.html` - dynamic Insights feed reading `/api/showcase`
- `web/about.html` - Marketplace/About page
- `migrations/011_chipmonk_source_meta.sql` - adds `marks.source_name` and
  `marks.external_id` for cross-source dedup
- `src/server.mjs` - request router with SPA route handling, `/admin/login`
  API-key gate, and `/api/marks/:id/summarize` Ollama endpoint
- `src/db.mjs` - source-meta column writes

## What stays upstream

ClawFeed remains the engine: ingest helpers, mark/digest schema, packs,
subscriptions, feedback. We track upstream at `upstream/main`.

## Auth model (no GOOGLE_CLIENT_ID configured)

Public: `/`, `/blog`, `/about`, `/dashboard` HTML, `/api/health`,
`/api/showcase`.

Admin: every other API requires either:

- `X-Admin-Key: <API_KEY>` header (server-to-server, e.g. Sliver pushing
  topics), or
- `cm_admin` cookie set via `GET /admin/login?key=<API_KEY>`. The cookie
  value is `HMAC-SHA256(API_KEY, "cm_admin:v1")` - never the raw key.

Set `GOOGLE_CLIENT_ID` (and `GOOGLE_CLIENT_SECRET`) in `.env` to enable the
upstream Google OAuth path instead.

## Pulling upstream changes

```sh
git fetch upstream
git cherry-pick <upstream-sha>   # surgical, preferred
git merge upstream/main          # accepts engine drift wholesale
```

Do not blindly merge `upstream/main` - review for clawfeed features that do
not apply to a Silicon news site (zh-CN newsletter formatting, packs, etc.).

## Deployment

- VM: `chipmonk.exe.xyz` (`/root/clawfeed` working tree)
- Process manager: PM2 (`pm2 status`, `pm2 logs clawfeed`)
- Caddy on `:80` reverse-proxies to Node `:8767`
- Public hostname: `chipmonk.tech` via Cloudflare CNAME -> `chipmonk.exe.xyz`
- Cloudflare SSL/TLS mode must be **Full** (Flexible causes a 301 loop
  because exe.dev edge redirects HTTP -> HTTPS before Caddy is reached).
