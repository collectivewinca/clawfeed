#!/usr/bin/env node
// /root/clawfeed/scripts/weekly-digest.mjs
// Weekly chip-industry digest for chipmonk.tech subscribers.
// Modes:
//   --dry-run         render preview HTML+text to /tmp, do not send
//   --to <email>      send only to that address, ignoring subscriber list
//   (no flags)        send to every status='active' subscriber

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = join(__dirname, '..');
const ENV_PATH   = join(ROOT, '.env');
const DB_PATH    = join(ROOT, 'data', 'digest.db');
const LOG_DIR    = join(ROOT, 'logs');

// ── arg parsing ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
let TO_OVERRIDE = null;
{
  const i = args.indexOf('--to');
  if (i !== -1 && args[i + 1]) TO_OVERRIDE = args[i + 1].trim().toLowerCase();
}

// ── manual .env parser ──────────────────────────────────────────────────────
function loadEnv(p) {
  const env = {};
  if (!existsSync(p)) return env;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}
const ENV = loadEnv(ENV_PATH);
const CF_ACCOUNT  = ENV.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN    = ENV.CLOUDFLARE_EMAIL_TOKEN;
const EMAIL_FROM  = ENV.EMAIL_FROM     || 'ChipMonk Newsletter <digest@minyvinyl.com>';
const REPLY_TO    = ENV.EMAIL_REPLY_TO || 'hello@collectivewin.ca';
const API_BASE    = `http://127.0.0.1:${ENV.DIGEST_PORT || 8767}`;

// CF Email Sending takes from/to as plain strings (may include "Name <addr>" form).
// Verified against /root/clawfeed/src/server.mjs sendCloudflareEmail() and the
// Zeus reference at /root/zeus-skills/miny-ven-feed/scripts/send-text-email.py.

// ── helpers ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function htmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtWeekOf(d = new Date()) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function ensureLogDir() {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

// ── data fetchers ───────────────────────────────────────────────────────────
function fetchInsights(db) {
  // 7-day window, status='approved' preferred. If <5 approved, fall back to
  // 50 most recent and pick by source diversity (max 1 per source until 5).
  const since = "datetime('now','-7 days')";
  const approved = db.prepare(
    `SELECT id, url, title, note, source_name, created_at
       FROM marks
      WHERE status = 'approved' AND created_at >= ${since}
      ORDER BY created_at DESC
      LIMIT 5`
  ).all();
  if (approved.length >= 5) return approved.slice(0, 5);

  const pool = db.prepare(
    `SELECT id, url, title, note, source_name, created_at
       FROM marks
      WHERE created_at >= ${since}
      ORDER BY created_at DESC
      LIMIT 50`
  ).all();
  const have = new Set(approved.map(r => r.id));
  const seen = new Set(approved.map(r => r.source_name || ''));
  const picks = [...approved];
  for (const r of pool) {
    if (picks.length >= 5) break;
    if (have.has(r.id)) continue;
    const src = r.source_name || '';
    if (seen.has(src)) continue;
    picks.push(r);
    seen.add(src);
  }
  // If still short, top up with most-recent regardless of source.
  for (const r of pool) {
    if (picks.length >= 5) break;
    if (picks.find(p => p.id === r.id)) continue;
    picks.push(r);
  }
  return picks.slice(0, 5);
}

async function fetchTopMovers() {
  try {
    const res = await fetch(`${API_BASE}/api/markets/chip-quotes`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const j = await res.json();
    const rows = Object.values(j.quotes || {})
      .filter(q => q && typeof q.yoy_pct === 'number')
      .sort((a, b) => b.yoy_pct - a.yoy_pct)
      .slice(0, 3);
    return rows;
  } catch {
    return [];
  }
}

// ── rendering ───────────────────────────────────────────────────────────────
function cleanLine(s, max = 200) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).replace(/[ ,;:.-]+$/, '') + '…' : t;
}

function buildEmail({ insights, movers, recipient }) {
  const subject = `ChipMonk · Week of ${fmtWeekOf()}`;

  // Unsubscribe link — no token column on subscribers table; server accepts
  // ?email=<urlencoded> only (verified in src/server.mjs /api/unsubscribe).
  const unsubUrl = `https://chipmonk.tech/api/unsubscribe?email=${encodeURIComponent(recipient)}`;

  // ── HTML body (inline CSS, single column, 600px max) ──
  const insightsHtml = insights.map((r, i) => {
    const title = htmlEscape(cleanLine(r.title || r.url || '(untitled)', 140));
    const note  = htmlEscape(cleanLine(r.note  || '', 220));
    const url   = htmlEscape(r.url || '#');
    const src   = htmlEscape(cleanLine(r.source_name || '', 60));
    return `
      <tr><td style="padding:18px 0;border-top:1px solid #e5e7eb;">
        <div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.08em;color:#64748b;text-transform:uppercase;margin-bottom:6px;">${String(i+1).padStart(2,'0')}${src ? ' · ' + src : ''}</div>
        <h3 style="font-family:Georgia,'Times New Roman',serif;font-size:18px;line-height:1.35;margin:0 0 6px 0;color:#0f172a;font-weight:600;">${title}</h3>
        ${note ? `<p style="font-family:Georgia,'Times New Roman',serif;font-size:14px;line-height:1.55;color:#334155;margin:0 0 8px 0;">${note}</p>` : ''}
        <a href="${url}" style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#0f172a;text-decoration:underline;">Read &rarr;</a>
      </td></tr>`;
  }).join('');

  const moversRows = movers.map(m => {
    const sym  = htmlEscape(m.symbol || '');
    const px   = typeof m.price === 'number' ? `$${m.price.toFixed(2)}` : '—';
    const yoy  = typeof m.yoy_pct === 'number'
      ? (m.yoy_pct >= 0 ? '+' : '') + m.yoy_pct.toFixed(1) + '%'
      : '—';
    return `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#0f172a;">${sym}</td>
      <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#334155;text-align:right;">${px}</td>
      <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#0f172a;text-align:right;">${yoy}</td>
    </tr>`;
  }).join('');

  const moversBlock = movers.length ? `
    <tr><td style="padding:24px 0 8px 0;">
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.08em;color:#64748b;text-transform:uppercase;margin-bottom:10px;">Top movers · 1Y</div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <thead><tr>
          <th style="padding:6px 0;border-bottom:1px solid #cbd5e1;text-align:left;font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.08em;color:#64748b;text-transform:uppercase;font-weight:500;">Symbol</th>
          <th style="padding:6px 0;border-bottom:1px solid #cbd5e1;text-align:right;font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.08em;color:#64748b;text-transform:uppercase;font-weight:500;">Price</th>
          <th style="padding:6px 0;border-bottom:1px solid #cbd5e1;text-align:right;font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.08em;color:#64748b;text-transform:uppercase;font-weight:500;">YoY</th>
        </tr></thead>
        <tbody>${moversRows}</tbody>
      </table>
    </td></tr>` : '';

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(subject)}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8fafc;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;">
      <tr><td style="padding:20px 24px;border-bottom:2px solid #0f172a;">
        <div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.18em;color:#0f172a;text-transform:uppercase;">CHIPMONK &middot; Silicon Intelligence Hub</div>
      </td></tr>
      <tr><td style="padding:24px 24px 8px 24px;">
        <div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.08em;color:#64748b;text-transform:uppercase;margin-bottom:8px;">Week of ${htmlEscape(fmtWeekOf())}</div>
        <p style="font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.55;color:#334155;margin:0 0 6px 0;">A weekly read on what shifted in chip supply, design, and capital.</p>
      </td></tr>
      <tr><td style="padding:8px 24px 0 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${insightsHtml}</table>
      </td></tr>
      <tr><td style="padding:0 24px;">${moversBlock}</td></tr>
      <tr><td style="padding:28px 24px;border-top:1px solid #e5e7eb;">
        <a href="https://chipmonk.tech/blog" style="font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#0f172a;text-decoration:underline;">More insights at chipmonk.tech/blog &rarr;</a>
      </td></tr>
      <tr><td style="padding:18px 24px 24px 24px;background:#f8fafc;border-top:1px solid #e5e7eb;">
        <div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.6;color:#64748b;">
          You receive this because you subscribed at chipmonk.tech.<br>
          <a href="${htmlEscape(unsubUrl)}" style="color:#64748b;text-decoration:underline;">Unsubscribe</a>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  // ── text/plain ──
  const txtInsights = insights.map((r, i) => {
    const n = String(i+1).padStart(2,'0');
    const t = cleanLine(r.title || r.url || '(untitled)', 140);
    const note = cleanLine(r.note || '', 220);
    const src = cleanLine(r.source_name || '', 60);
    return `${n}${src ? ' · ' + src : ''}\n${t}\n${note ? note + '\n' : ''}${r.url || ''}`;
  }).join('\n\n');

  const txtMovers = movers.length
    ? '\n\nTOP MOVERS · 1Y\n' + movers.map(m => {
        const px = typeof m.price === 'number' ? `$${m.price.toFixed(2)}` : '—';
        const yoy = typeof m.yoy_pct === 'number'
          ? (m.yoy_pct >= 0 ? '+' : '') + m.yoy_pct.toFixed(1) + '%'
          : '—';
        return `  ${(m.symbol||'').padEnd(6)} ${px.padStart(10)}   ${yoy.padStart(8)}`;
      }).join('\n')
    : '';

  const text = `CHIPMONK · Silicon Intelligence Hub
Week of ${fmtWeekOf()}

A weekly read on what shifted in chip supply, design, and capital.

${txtInsights}${txtMovers}

More insights at chipmonk.tech/blog

—
You receive this because you subscribed at chipmonk.tech.
Unsubscribe: ${unsubUrl}
`;

  return { subject, html, text };
}

// ── send ────────────────────────────────────────────────────────────────────
async function sendCF({ to, subject, html, text }) {
  if (!CF_ACCOUNT || !CF_TOKEN) {
    return { ok: false, status: 0, error: 'missing CF credentials' };
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/email/sending/send`;
  const payload = {
    from: EMAIL_FROM,
    ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
    to,
    subject,
    html,
    text,
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    return { ok: r.ok && parsed?.success !== false, status: r.status, body: parsed || body };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const startedAt = new Date();
  const db = new Database(DB_PATH, { readonly: false });

  const insights = fetchInsights(db);
  const movers   = await fetchTopMovers();

  // Recipient list
  let recipients = [];
  if (TO_OVERRIDE) {
    recipients = [TO_OVERRIDE];
  } else {
    const rows = db.prepare("SELECT email FROM subscribers WHERE status='active' ORDER BY id ASC").all();
    recipients = rows.map(r => r.email);
  }

  if (DRY_RUN) {
    const sample = recipients[0] || 'preview@example.com';
    const { subject, html, text } = buildEmail({ insights, movers, recipient: sample });
    writeFileSync('/tmp/weekly-digest-preview.html', html);
    writeFileSync('/tmp/weekly-digest-preview.txt',  text);
    console.log(`[dry-run] subject       : ${subject}`);
    console.log(`[dry-run] insights      : ${insights.length}`);
    console.log(`[dry-run] movers        : ${movers.length}`);
    console.log(`[dry-run] subscribers   : ${recipients.length}`);
    console.log(`[dry-run] preview html  : /tmp/weekly-digest-preview.html`);
    console.log(`[dry-run] preview text  : /tmp/weekly-digest-preview.txt`);
    db.close();
    process.exit(0);
  }

  if (recipients.length === 0) {
    console.log('[weekly-digest] no recipients, exiting.');
    db.close();
    process.exit(0);
  }

  ensureLogDir();
  const logPath = join(LOG_DIR, `weekly-digest-${startedAt.toISOString().replace(/[:.]/g, '-')}.log`);
  const logLines = [];
  const log = m => { console.log(m); logLines.push(m); };

  log(`[weekly-digest] started ${startedAt.toISOString()}`);
  log(`[weekly-digest] insights=${insights.length} movers=${movers.length} recipients=${recipients.length}`);
  log(`[weekly-digest] from="${EMAIL_FROM}" reply_to=${REPLY_TO}`);

  let sent = 0, failed = 0;
  for (const to of recipients) {
    const { subject, html, text } = buildEmail({ insights, movers, recipient: to });
    const r = await sendCF({ to, subject, html, text });
    if (r.ok) {
      sent++;
      log(`[ok ${r.status}] ${to}`);
    } else {
      failed++;
      const errSnippet = typeof r.body === 'object'
        ? JSON.stringify(r.body).slice(0, 300)
        : String(r.body || r.error || '').slice(0, 300);
      log(`[err ${r.status}] ${to} :: ${errSnippet}`);
    }
    await sleep(200); // ~5 req/s
  }

  const finishedAt = new Date();
  log('');
  log('── summary ──');
  log(`started   : ${startedAt.toISOString()}`);
  log(`finished  : ${finishedAt.toISOString()}`);
  log(`recipients: ${recipients.length}`);
  log(`sent      : ${sent}`);
  log(`failed    : ${failed}`);

  try { writeFileSync(logPath, logLines.join('\n') + '\n'); } catch {}
  db.close();
  process.exit(failed > 0 && sent === 0 ? 1 : 0);
})().catch(err => {
  console.error('[weekly-digest] fatal:', err);
  process.exit(2);
});
