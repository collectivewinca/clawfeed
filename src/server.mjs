import { createServer } from 'http';
import http from 'http';
import https from 'https';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { getDb, listDigests, getDigest, createDigest, listMarks, listMarkSources, createMark, deleteMark, updateMarkStatus, getConfig, setConfig, upsertUser, createSession, getSession, deleteSession, listSources, getSource, createSource, updateSource, deleteSource, getSourceByTypeConfig, getUserBySlug, listDigestsByUser, countDigestsByUser, createPack, getPack, getPackBySlug, listPacks, incrementPackInstall, deletePack, listSubscriptions, subscribe, unsubscribe, bulkSubscribe, isSubscribed, createFeedback, getUserFeedback, getAllFeedback, replyToFeedback, updateFeedbackStatus, markFeedbackRead, getUnreadFeedbackCount, addSubscriber, listSubscribers, countSubscribers, unsubscribeNewsletter, isStoplisted, upsertCandidate, listCandidates, setCandidateStatus, countCandidatesByStatus } from './db.mjs';
import { loadCatalog, classifyBatch, extractEntitiesFromNote, catalogStatus } from './companies.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load .env ──
const envPath = join(ROOT, '.env');
const env = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
}

const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET = env.SESSION_SECRET || process.env.SESSION_SECRET;
const API_KEY = env.API_KEY || process.env.API_KEY || '';
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || 'localhost').split(',').map(o => o.trim()).filter(Boolean);
const PORT = process.env.DIGEST_PORT || env.DIGEST_PORT || 8767;
const OAUTH_STATE_SECRET = env.OAUTH_STATE_SECRET || process.env.OAUTH_STATE_SECRET || SESSION_SECRET || API_KEY || 'dev-state-secret';
const CLOUDFLARE_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CLOUDFLARE_EMAIL_TOKEN = env.CLOUDFLARE_EMAIL_TOKEN || process.env.CLOUDFLARE_EMAIL_TOKEN || '';
const EMAIL_FROM = env.EMAIL_FROM || process.env.EMAIL_FROM || '';
const EMAIL_REPLY_TO = env.EMAIL_REPLY_TO || process.env.EMAIL_REPLY_TO || '';
const NEWSLETTER_BRAND = env.NEWSLETTER_BRAND || 'ChipMonk';
const PUBLIC_BASE_URL = env.PUBLIC_BASE_URL || 'https://chipmonk.tech';
const MAX_BODY_BYTES = 1024 * 1024;
const DB_PATH = process.env.DIGEST_DB || join(ROOT, 'data', 'digest.db');

mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = getDb(DB_PATH);

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      body += c;
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('payload too large'));
      try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); }
    });
  });
}

function parseUrl(url) {
  const [path, qs] = url.split('?');
  const params = new URLSearchParams(qs || '');
  return { path, params };
}

function parseCookies(req) {
  const obj = {};
  const header = req.headers.cookie || '';
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) obj[k] = decodeURIComponent(v.join('='));
  }
  return obj;
}

const COOKIE_NAME = process.env.COOKIE_NAME || env.COOKIE_NAME || 'session';
function setSessionCookie(res, value, maxAge = 30 * 86400) {
  const cookie = `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  setSessionCookie(res, '', 0);
}

function normalizeOrigin(input) {
  try {
    const u = new URL(input);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function isAllowedOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (!ALLOWED_ORIGINS.length) return false;
  return ALLOWED_ORIGINS.some((allowed) => {
    if (allowed.includes('://')) return normalizeOrigin(allowed) === normalized;
    try { return new URL(normalized).hostname === allowed; } catch { return false; }
  });
}

function signOAuthState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', OAUTH_STATE_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyOAuthState(state) {
  if (!state || !state.includes('.')) return null;
  const [body, sig] = state.split('.', 2);
  const expected = createHmac('sha256', OAUTH_STATE_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
}

function isPrivateOrSpecialIp(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    const n = ip.toLowerCase();
    return n === '::1' || n.startsWith('fc') || n.startsWith('fd') || n.startsWith('fe80:') || n.startsWith('::ffff:127.');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

async function assertSafeFetchUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('invalid url scheme');
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('blocked host');
  if (isIP(host) && isPrivateOrSpecialIp(host)) throw new Error('blocked host');
  const resolved = await lookup(host, { all: true });
  if (!resolved.length || resolved.some((r) => isPrivateOrSpecialIp(r.address))) {
    throw new Error('blocked host');
  }
}

// ── Google OAuth helpers ──
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function httpsPost(url, body) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const postData = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function constantTimeKeyMatch(provided, expected) {
  if (!provided || !expected || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function adminCookieToken() {
  return createHmac('sha256', API_KEY).update('cm_admin:v1').digest('hex');
}

// ── Cloudflare Email Sending ──
// POSTs to api.cloudflare.com/.../email/sending/send. Returns {ok, status, body}.
// Same endpoint Zeus uses for digest highlights — token has Account · Email Sending · Send scope.
async function sendCloudflareEmail({ to, subject, html, text }) {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_EMAIL_TOKEN || !EMAIL_FROM) {
    return { ok: false, error: 'cf_email_not_configured' };
  }
  if (!to || !subject) return { ok: false, error: 'missing_to_or_subject' };
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/email/sending/send`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_EMAIL_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        ...(EMAIL_REPLY_TO ? { reply_to: EMAIL_REPLY_TO } : {}),
        to, subject, html: html || '', text: text || ''
      })
    });
    let body = null;
    try { body = await r.json(); } catch {}
    return { ok: r.ok && body && body.success !== false, status: r.status, body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Strip llama3.2:1b's chronic preface/meta-commentary patterns from a summary.
// Conservative: only removes leading boilerplate lines and trailing meta notes,
// never touches paragraph content. Idempotent.
function cleanSummary(s, title = '') {
  if (!s) return s;
  let out = s.trim();

  // Strip lines that are just the title (the model loves to repeat it as a heading).
  if (title) {
    const norm = (x) => x.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const t = norm(title);
    if (t.length >= 8) {
      out = out.split('\n').filter(line => {
        const l = norm(line);
        if (!l) return true; // keep blank lines for paragraph breaks
        // drop the line if it IS the title or contains the title as ≥80% of its content
        if (l === t) return false;
        if (l.length < t.length * 1.3 && l.includes(t)) return false;
        return true;
      }).join('\n');
    }
  }

  // Patterns the model leaks at the START of its response.
  const leadingJunk = [
    /^Here (?:are|is)[^\n]*(?:paragraphs?|brief|summary|breakdown|analysis|outline)[^\n]*[:.]?\s*/i,
    /^Below (?:are|is)[^\n]*[:.]?\s*/i,
    /^I'?ll (?:provide|write|give|share|prepare|outline)[^\n]*[:.]?\s*/i,
    /^Sure[,!.][^\n]*[:.]?\s*/i,
    /^Certainly[,!.][^\n]*[:.]?\s*/i,
    /^Of course[,!.][^\n]*[:.]?\s*/i,
    /^As (?:chip designers|AI hardware|engineers|professionals|investors|requested)[^\n]*[,.][^\n]*\s*/i,
    /^For (?:chip designers|AI hardware|the technical audience)[^\n]*[,.][^\n]*\s*/i,
    /^This (?:brief|summary|article|piece) (?:is|will|aims|focuses)[^\n]*\s*/i,
    /^The following[^\n]*[:.]?\s*/i,
    /^Begin the brief now[:.]?\s*/i,
  ];
  // Run multiple passes — model sometimes stacks two prefaces.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const re of leadingJunk) {
      const next = out.replace(re, '');
      if (next !== out) { out = next.trimStart(); changed = true; }
    }
    if (!changed) break;
  }

  // Trailing meta blocks the model adds about its own output.
  const trailingJunk = [
    /\n\s*(?:Note|Notes|Disclaimer)\s*[:.][\s\S]*$/i,
    /\n\s*(?:I (?:have|will) (?:stopped|stop|paused|ended|finished|concluded))[^\n]*[\s\S]*$/i,
    /\n\s*This (?:summary|brief|article) (?:is|was) (?:based on|generated|produced|written)[^\n]*[\s\S]*$/i,
    /\n\s*\*?\s*The article does not (?:mention|cover|discuss)[^\n]*[\s\S]*$/i,
    /\n\s*Let me know if[^\n]*[\s\S]*$/i,
    /\n\s*Hope this helps[^\n]*[\s\S]*$/i,
  ];
  for (const re of trailingJunk) out = out.replace(re, '');

  out = out.trim();

  // If the model produced an incomplete trailing sentence (no terminal
  // punctuation in the last line), trim back to the last finished sentence
  // so we don't display half-thoughts.
  if (out.length > 80) {
    const lastChar = out.slice(-1);
    if (!/[.!?")\]]/.test(lastChar)) {
      const lastTerminator = out.search(/[.!?][")\]]?\s*[A-Z][^.!?]*$/);
      if (lastTerminator > 80) {
        // Cut back to the last complete sentence terminator before the dangling fragment.
        const m = out.match(/^([\s\S]*[.!?][")\]]?)(?:\s+[^.!?]*)?$/);
        if (m && m[1].length > 80) out = m[1].trim();
      }
    }
  }
  return out;
}

function welcomeEmail() {
  const subject = `Welcome to ${NEWSLETTER_BRAND}`;
  const text = `You're on the list.

${NEWSLETTER_BRAND} sends one weekly silicon dispatch — primary-source pieces on AI accelerators, fab capacity, and packaging.

Latest insights: ${PUBLIC_BASE_URL}/blog
Market overview: ${PUBLIC_BASE_URL}/about

If this wasn't you, just ignore this email and you'll be unsubscribed automatically next time.

— ${NEWSLETTER_BRAND}`;
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;background:#FAFAFA;color:#0F172A;margin:0;padding:32px 16px;">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:32px;">
  <div style="font-weight:700;font-size:18px;letter-spacing:-0.01em;margin-bottom:24px;">${NEWSLETTER_BRAND}</div>
  <h1 style="font-size:24px;font-weight:700;letter-spacing:-0.02em;margin:0 0 16px;">You're on the list.</h1>
  <p style="font-size:15px;line-height:1.6;color:#334155;margin:0 0 16px;">
    ${NEWSLETTER_BRAND} sends one weekly silicon dispatch — primary-source pieces on AI accelerators, fab capacity, and packaging, with our notes.
  </p>
  <p style="font-size:15px;line-height:1.6;color:#334155;margin:0 0 24px;">
    While you wait, here's what's already brewing:
  </p>
  <p style="margin:0 0 12px;"><a href="${PUBLIC_BASE_URL}/blog" style="color:#2563EB;text-decoration:none;font-weight:600;">→ Latest insights</a></p>
  <p style="margin:0 0 32px;"><a href="${PUBLIC_BASE_URL}/about" style="color:#2563EB;text-decoration:none;font-weight:600;">→ Market overview</a></p>
  <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0;">
  <p style="font-size:12px;color:#94A3B8;line-height:1.6;margin:0;">
    Didn't sign up? Ignore this email — you'll be unsubscribed automatically.
  </p>
</div>
</body></html>`;
  return { subject, text, html };
}

// Auth middleware: attach req.user if valid session.
// When GOOGLE_CLIENT_ID is unset, admin is gated behind API_KEY: clients
// present it as either an `X-Admin-Key` header (raw key, server-to-server)
// or a `cm_admin` cookie holding a derived token from /admin/login (browser).
// Cookie holds HMAC(API_KEY, "cm_admin:v1") — never the raw key.
function attachUser(req) {
  const cookies = parseCookies(req);
  if (!GOOGLE_CLIENT_ID) {
    if (!API_KEY) return;
    let authed = false;
    const headerKey = req.headers['x-admin-key'] || '';
    if (headerKey && constantTimeKeyMatch(headerKey, API_KEY)) authed = true;
    const cookieTok = cookies['cm_admin'] || '';
    if (!authed && cookieTok && constantTimeKeyMatch(cookieTok, adminCookieToken())) authed = true;
    if (authed) {
      req.user = { id: 1, email: 'admin@chipmonk.tech', name: 'ChipMonk Admin', avatar: 'https://github.com/identicons/admin.png', slug: 'admin' };
    }
    return;
  }
  const sessionVal = cookies[COOKIE_NAME];
  if (sessionVal) {
    const sess = getSession(db, sessionVal);
    if (sess) {
      req.user = { id: sess.uid, email: sess.email, name: sess.name, avatar: sess.avatar, slug: sess.slug };
      req.sessionId = sessionVal;
    }
  }
}

function _digestTitle(d, ca) {
  const dt = new Date(ca.includes('+') ? ca : ca.replace(' ', 'T') + 'Z');
  const timeStr = dt.toLocaleString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const labels = { '4h': '4H Brief', daily: 'Daily Brief', weekly: 'Weekly Brief', monthly: 'Monthly Brief' };
  return `${labels[d.type] || 'ChipMonk'} · ${timeStr} UTC`;
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // HEAD: route as GET, but suppress the response body (per RFC 7231 §4.3.2).
  if (req.method === 'HEAD') {
    req.method = 'GET';
    const _end = res.end.bind(res);
    res.write = () => true;
    res.end = function (chunk, ...rest) {
      // Drop the body chunk; preserve status and headers.
      return _end();
    };
  }

  let { path, params } = parseUrl(req.url);
  console.log('[request]', req.method, req.url, '-> path:', path);

  // ── Health check ──
  if (req.method === 'GET' && (path === '/api/health' || path === '/health')) {
    return json(res, { status: 'ok' });
  }

  // ── Candidate companies (admin) ──
  // Pull from extracted KEY ENTITIES, classify against ve-stock catalog via embeddings.
  if (req.method === 'GET' && path === '/api/candidates') {
    if (!req.user) { attachUser(req); }
    if (!req.user) return json(res, { error: 'not authenticated' }, 401);
    const status = (params.get('status') || 'pending').toLowerCase();
    return json(res, {
      counts: countCandidatesByStatus(db),
      catalog: catalogStatus(),
      candidates: listCandidates(db, { status }),
    });
  }
  if (req.method === 'PUT' && path.startsWith('/api/candidates/')) {
    if (!req.user) { attachUser(req); }
    if (!req.user) return json(res, { error: 'not authenticated' }, 401);
    const id = parseInt(path.slice('/api/candidates/'.length), 10);
    if (!id) return json(res, { error: 'invalid_id' }, 400);
    const body = await parseBody(req);
    const r = setCandidateStatus(db, id, body.status, body.notes);
    if (!r.ok) return json(res, r, 400);
    return json(res, { ok: true });
  }
  if (req.method === 'POST' && path === '/api/candidates/extract') {
    if (!req.user) { attachUser(req); }
    if (!req.user) return json(res, { error: 'not authenticated' }, 401);
    const body = await parseBody(req).catch(() => ({}));
    const lookbackDays = Math.min(parseInt(body.lookbackDays, 10) || 30, 365);
    try {
      await loadCatalog(); // warm if not loaded
    } catch (e) {
      return json(res, { error: 'catalog_unavailable', detail: e.message }, 502);
    }
    // Pull recent marks with KEY ENTITIES
    const since = new Date(Date.now() - lookbackDays * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const marks = db.prepare(`SELECT id, note FROM marks WHERE created_at >= ? AND note LIKE '%KEY ENTITIES%'`).all(since);
    const seen = new Set();
    const candidates = [];
    for (const m of marks) {
      for (const ent of extractEntitiesFromNote(m.note)) {
        const key = ent.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (isStoplisted(db, ent)) continue;
        candidates.push(ent);
      }
    }
    if (!candidates.length) {
      return json(res, { ok: true, scanned_marks: marks.length, extracted: 0, classifications: { known: 0, candidate: 0, not_a_company: 0 } });
    }
    // Batch-classify (one HTTP call)
    let results;
    try {
      results = await classifyBatch(candidates);
    } catch (e) {
      return json(res, { error: 'classify_failed', detail: e.message }, 502);
    }
    const tally = { known: 0, candidate: 0, not_a_company: 0 };
    let inserted = 0, incremented = 0;
    for (const r of results) {
      tally[r.verdict] = (tally[r.verdict] || 0) + 1;
      if (r.verdict !== 'candidate') continue; // only queue middle-band entries
      const u = upsertCandidate(db, {
        name: r.name,
        classifierVerdict: r.verdict,
        bestKnownMatch: r.bestMatch,
        bestKnownScore: r.score,
      });
      if (u && u.action === 'inserted') inserted++;
      else if (u) incremented++;
    }
    return json(res, {
      ok: true,
      scanned_marks: marks.length,
      extracted_unique: candidates.length,
      classifications: tally,
      queue_inserted: inserted,
      queue_incremented: incremented,
    });
  }
  if (req.method === 'GET' && path === '/api/candidates/export.json') {
    if (!req.user) { attachUser(req); }
    if (!req.user) return json(res, { error: 'not authenticated' }, 401);
    const approved = listCandidates(db, { status: 'approved', limit: 1000 });
    const payload = {
      generatedAt: new Date().toISOString(),
      count: approved.length,
      candidates: approved.map(c => ({
        name: c.name,
        nearest_known: c.best_known_match,
        nearest_score: c.best_known_score,
        first_seen_at: c.first_seen_at,
        source_count: c.source_count,
        notes: c.notes,
      })),
    };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="chipmonk-approved-companies-${new Date().toISOString().slice(0,10)}.json"`,
    });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  // ── Catalog proxy — bypasses ve-stock's missing CORS header ──
  if (req.method === 'GET' && path === '/api/catalog/companies') {
    const include = (params.get('include') || '').toLowerCase();
    const limit = Math.min(parseInt(params.get('limit') || '50', 10) || 50, 50);
    const upstream = new URL('https://ve-stock.exe.xyz/api/chipmonk/companies');
    if (include) upstream.searchParams.set('include', include);
    upstream.searchParams.set('limit', String(limit));
    try {
      const r = await fetch(upstream.toString(), { signal: AbortSignal.timeout(8000) });
      const body = await r.text();
      res.writeHead(r.status, {
        'Content-Type': r.headers.get('content-type') || 'application/json',
        'Cache-Control': 'public, max-age=300',
      });
      res.end(body);
    } catch (e) {
      return json(res, { error: 'upstream_unreachable', detail: e.message }, 502);
    }
    return;
  }

  // ── robots.txt ──
  if (req.method === 'GET' && path === '/robots.txt') {
    const body = `User-agent: *
Allow: /
Disallow: /dashboard
Disallow: /admin/
Disallow: /api/

Sitemap: ${PUBLIC_BASE_URL}/sitemap.xml
`;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
    return;
  }

  // ── sitemap.xml (public pages + each tracker) ──
  if (req.method === 'GET' && path === '/sitemap.xml') {
    const today = new Date().toISOString().slice(0, 10);
    const trackers = db.prepare("SELECT key FROM config WHERE key LIKE 'tracker:%'").all();
    const trackerSlugs = trackers.map(r => r.key.slice(8));
    const recentDigests = db.prepare("SELECT id FROM digests WHERE type = 'daily' ORDER BY id DESC LIMIT 30").all();
    const urls = [
      { loc: `${PUBLIC_BASE_URL}/`, priority: '1.0', changefreq: 'daily' },
      { loc: `${PUBLIC_BASE_URL}/blog`, priority: '0.9', changefreq: 'daily' },
      { loc: `${PUBLIC_BASE_URL}/briefs`, priority: '0.8', changefreq: 'daily' },
      { loc: `${PUBLIC_BASE_URL}/companies`, priority: '0.7', changefreq: 'weekly' },
      { loc: `${PUBLIC_BASE_URL}/about`, priority: '0.5', changefreq: 'monthly' },
      ...recentDigests.map(d => ({
        loc: `${PUBLIC_BASE_URL}/brief/${d.id}`,
        priority: '0.6',
        changefreq: 'monthly'
      })),
      ...trackerSlugs.map(slug => ({
        loc: `${PUBLIC_BASE_URL}/tracker/${slug}`,
        priority: '0.7',
        changefreq: 'weekly'
      })),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(xml);
    return;
  }

  // ── RSS Feed (daily Briefs) ──
  if (req.method === 'GET' && (path === '/blog.rss' || path === '/rss' || path === '/feed.xml')) {
    const digests = listDigests(db, { type: 'daily', limit: 30 });
    const escape = s => String(s || '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
    const items = digests.map(d => {
      const created = new Date(d.created_at + 'Z');
      const pubDate = created.toUTCString();
      const dateLabel = created.toISOString().slice(0, 10);
      const link = `${PUBLIC_BASE_URL}/blog#brief-${d.id}`;
      return `    <item>
      <title>ChipMonk Brief — ${dateLabel}</title>
      <link>${link}</link>
      <guid isPermaLink="false">chipmonk-brief-${d.id}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[${d.content}]]></description>
    </item>`;
    }).join('\n');
    const lastBuild = digests[0] ? new Date(digests[0].created_at + 'Z').toUTCString() : new Date().toUTCString();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>ChipMonk — Silicon Intelligence Brief</title>
    <link>${PUBLIC_BASE_URL}/blog</link>
    <atom:link href="${PUBLIC_BASE_URL}/blog.rss" rel="self" type="application/rss+xml" />
    <description>Daily semiconductor industry brief: AI accelerators, foundries, packaging, architecture. Sourced and synthesized from primary feeds.</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
${items}
  </channel>
</rss>`;
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    res.end(xml);
    return;
  }

  // ── SPA Routes ──
  if (req.method === 'GET' && (path === '/' || path === '/dashboard' || path === '/blog' || path === '/about' || path === '/companies' || path === '/briefs' || path.startsWith('/brief/') || path.startsWith('/tracker/') || path === '/tracker')) {
    try {
      let file = 'showcase.html';
      if (path === '/blog') file = 'blog.html';
      else if (path === '/about') file = 'about.html';
      else if (path === '/companies') file = 'companies.html';
      else if (path === '/dashboard') file = 'dashboard.html';
      else if (path === '/briefs') file = 'briefs.html';
      else if (path.startsWith('/brief/')) file = 'brief.html';
      else if (path === '/tracker' || path.startsWith('/tracker/')) file = 'tracker.html';
      const html = readFileSync(join(ROOT, 'web', file), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch (e) {
      res.writeHead(500); res.end('Internal error'); return;
    }
  }

  // ── Admin login (no-OAuth fallback): sets cm_admin cookie ──
  if (req.method === 'GET' && path === '/admin/login') {
    const provided = params.get('key') || '';
    if (!API_KEY) { res.writeHead(503); res.end('admin disabled: API_KEY not configured'); return; }
    if (!constantTimeKeyMatch(provided, API_KEY)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('invalid key'); return;
    }
    const cookie = `cm_admin=${adminCookieToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`;
    res.writeHead(302, { 'Set-Cookie': cookie, Location: '/dashboard' });
    res.end();
    return;
  }
  if (req.method === 'POST' && path === '/admin/logout') {
    res.writeHead(200, { 'Set-Cookie': 'cm_admin=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0', 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  if (!path.startsWith('/api/') && path !== '/mark' && path !== '/marks') {
    path = '/api' + path;
  }

  attachUser(req);

  try {
    // ── Auth Endpoints ──
    if (req.method === 'GET' && path === '/api/auth/config') {
      return json(res, { authEnabled: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) });
    }

    if (req.method === 'GET' && path === '/api/auth/me') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      return json(res, { user: req.user });
    }

    // ── Digest Endpoints ──
    if (req.method === 'GET' && path === '/api/digests') {
      const type = params.get('type') || undefined;
      const limit = parseInt(params.get('limit') || '20');
      const offset = parseInt(params.get('offset') || '0');
      return json(res, listDigests(db, { type, limit, offset }));
    }
    const digestMatch = path.match(/^\/api\/digests\/(\d+)$/);
    if (req.method === 'GET' && digestMatch) {
      const id = parseInt(digestMatch[1], 10);
      const d = getDigest(db, id);
      if (!d) return json(res, { error: 'not_found' }, 404);
      // Compute prev/next of same type for archive navigation
      const t = d.type || 'daily';
      const prev = db.prepare("SELECT id, created_at FROM digests WHERE type = ? AND id < ? ORDER BY id DESC LIMIT 1").get(t, id);
      const next = db.prepare("SELECT id, created_at FROM digests WHERE type = ? AND id > ? ORDER BY id ASC LIMIT 1").get(t, id);
      return json(res, { ...d, prev: prev || null, next: next || null });
    }

    // ── Tracker Endpoints (entity rollups written by tracker_updater.py) ──
    if (req.method === 'GET' && path === '/api/trackers') {
      const rows = db.prepare("SELECT key, value FROM config WHERE key LIKE 'tracker:%' ORDER BY key").all();
      const out = rows.map(r => {
        try { return JSON.parse(r.value); } catch { return { slug: r.key.slice(8), error: 'parse-failed' }; }
      });
      return json(res, out);
    }

    const trackerMatch = path.match(/^\/api\/trackers\/([a-z0-9-]+)$/i);
    if (req.method === 'GET' && trackerMatch) {
      const slug = trackerMatch[1].toLowerCase();
      const row = db.prepare("SELECT value FROM config WHERE key = ?").get(`tracker:${slug}`);
      if (!row) return json(res, { error: 'not found' }, 404);
      try { return json(res, JSON.parse(row.value)); }
      catch { return json(res, { error: 'parse-failed' }, 500); }
    }

    // ── Accelerator Share (sidebar widget on /) ──
    const ACCEL_SHARE_DEFAULT = { segments: [{ label: 'NVIDIA', share: 80 }, { label: 'Other', share: 20 }] };
    if (req.method === 'GET' && path === '/api/config/accelerator-share') {
      const row = db.prepare("SELECT value FROM config WHERE key = ?").get('accelerator-share');
      if (!row) return json(res, ACCEL_SHARE_DEFAULT);
      try { return json(res, JSON.parse(row.value)); }
      catch { return json(res, ACCEL_SHARE_DEFAULT); }
    }
    if (req.method === 'PUT' && path === '/api/config/accelerator-share') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const body = await parseBody(req);
      const segs = Array.isArray(body && body.segments) ? body.segments : null;
      if (!segs || segs.length < 1 || segs.length > 5) {
        return json(res, { error: 'segments must be an array of 1–5 entries' }, 400);
      }
      const cleaned = [];
      let total = 0;
      for (const s of segs) {
        const label = String((s && s.label) || '').trim();
        const share = Number(s && s.share);
        if (!label || label.length > 30) return json(res, { error: 'each segment needs a label (1–30 chars)' }, 400);
        if (!Number.isFinite(share) || share < 0 || share > 100) return json(res, { error: 'share must be a number 0–100' }, 400);
        cleaned.push({ label, share: Math.round(share) });
        total += Math.round(share);
      }
      if (total !== 100) return json(res, { error: `shares must sum to 100 (got ${total})` }, 400);
      setConfig(db, 'accelerator-share', { segments: cleaned });
      return json(res, { segments: cleaned });
    }

    // ── Marks Endpoints ──
    if (req.method === 'GET' && path === '/api/showcase') {
      return json(res, listMarks(db, { status: 'approved', publicOnly: true }));
    }

    if (req.method === 'GET' && path === '/api/marks') {
      const status = params.get('status') || undefined;
      const since = params.get('since') || undefined;
      const minScoreRaw = params.get('min_score');
      const minScore = minScoreRaw != null && minScoreRaw !== '' ? parseFloat(minScoreRaw) : undefined;
      const source = params.get('source') || undefined;
      const sort = params.get('sort') || undefined;
      const limitRaw = params.get('limit');
      const limit = limitRaw != null && limitRaw !== '' ? Math.max(1, Math.min(500, parseInt(limitRaw, 10))) : 100;
      const userId = req.user ? req.user.id : undefined;
      return json(res, listMarks(db, { status, userId, since, minScore, source, sort, limit }));
    }

    if (req.method === 'GET' && path === '/api/marks/sources') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      return json(res, listMarkSources(db, { userId: req.user.id }));
    }

    if (req.method === 'POST' && path === '/api/marks') {
      const body = await parseBody(req);
      if (body.update && body.id) {
        db.prepare('UPDATE marks SET note = ? WHERE id = ?').run(body.note || '', body.id);
        return json(res, { ok: true });
      }
      const result = createMark(db, { ...body, userId: req.user ? req.user.id : null });
      return json(res, { ok: true, ...result });
    }

    const markStatusMatch = path.match(/^\/api\/marks\/(\d+)\/status$/);
    if (req.method === 'PUT' && markStatusMatch) {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const body = await parseBody(req);
      updateMarkStatus(db, parseInt(markStatusMatch[1]), body.status);
      return json(res, { ok: true });
    }

    // ── AI Summarize Endpoint ──
    const summarizeMatch = path.match(/^\/api\/marks\/(\d+)\/summarize$/);
    if (req.method === 'POST' && summarizeMatch) {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const markId = parseInt(summarizeMatch[1]);
      const mark = db.prepare('SELECT * FROM marks WHERE id = ?').get(markId);
      if (!mark) return json(res, { error: 'not found' }, 404);

      let articleText = '';
      if (mark.url) {
        try {
          await assertSafeFetchUrl(mark.url);
          const r = await fetch(mark.url, {
            signal: AbortSignal.timeout(10000),
            redirect: 'follow',
            headers: { 'User-Agent': 'ChipMonkBot/1.0 (+https://chipmonk.tech)' }
          });
          if (r.ok) {
            const html = await r.text();
            articleText = html
              .replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
              .replace(/&#\d+;/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 3500);
          }
        } catch (e) {
          console.warn('[summarize] body fetch failed for', mark.url, e.message);
        }
      }

      const bodyBlock = articleText ? `Source text:\n${articleText}` : '';
      const prompt = `Write a brief about this chip-industry article. Output ONLY the body of the brief — no preface, no "here are three paragraphs", no addressing the reader, no notes about your reasoning.

Hard rules:
- DO NOT repeat the title. The reader sees the title separately above your text. Do not start with the title; do not insert it as a heading or paragraph break.
- DO NOT use headings, bold, or bullet lists. Plain paragraphs only.
- 2-3 short paragraphs, ~200 words total
- Lead with concrete facts: specific chips, process nodes, fab partners, architecture choices, dollar amounts, TFLOPS, share percentages, dates
- Drop hype language and filler ("a major step", "groundbreaking", "the future of AI")
- If the source genuinely contains no chip-hardware content, write a single one-paragraph factual digest of whatever it does cover, still no meta-commentary

Title (for context only — do not repeat): ${mark.title || ''}
${bodyBlock}

Brief:`;

      try {
        const ollamaResp = await fetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST',
          signal: AbortSignal.timeout(180000),
          body: JSON.stringify({
            model: 'llama3.2:1b',
            prompt,
            stream: false,
            options: { temperature: 0.25, num_predict: 700, stop: ['Note:', 'Note that:', 'Disclaimer:', 'I have stopped', 'I will stop'] }
          })
        });
        const data = await ollamaResp.json();
        const raw = (data.response || '').trim();
        const summary = cleanSummary(raw, mark.title);
        if (!summary) return json(res, { error: 'empty summary from Ollama' }, 502);
        db.prepare('UPDATE marks SET note = ?, status = \'approved\' WHERE id = ?').run(summary, markId);
        return json(res, { ok: true, summary, sourcedBody: !!articleText });
      } catch (e) {
        return json(res, { error: 'Ollama failed: ' + e.message }, 500);
      }
    }

    // ── Newsletter subscribers ──
    if (req.method === 'POST' && path === '/api/subscribe') {
      const body = await parseBody(req);
      const email = (body.email || '').slice(0, 254);
      const source = (body.source || '').slice(0, 64) || null;
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
      const ipHash = ip ? createHmac('sha256', SESSION_SECRET || API_KEY || 'fallback').update(ip).digest('hex').slice(0, 32) : null;
      const r = addSubscriber(db, { email, source, ipHash });
      if (!r.ok) return json(res, r, 400);
      // Fire-and-forget welcome email (only on first subscribe; don't re-spam dupes).
      if (r.status === 'created' && CLOUDFLARE_EMAIL_TOKEN) {
        const w = welcomeEmail();
        sendCloudflareEmail({ to: email, subject: w.subject, html: w.html, text: w.text })
          .then(send => { if (!send.ok) console.warn('[subscribe] welcome email failed:', send.error || send.status, send.body); })
          .catch(e => console.warn('[subscribe] welcome email threw:', e.message));
      }
      return json(res, { ok: true, status: r.status });
    }

    // Admin: broadcast to all active subscribers
    if (req.method === 'POST' && path === '/api/newsletter/send') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const body = await parseBody(req);
      if (!body.subject) return json(res, { error: 'missing subject' }, 400);
      if (!body.html && !body.text) return json(res, { error: 'missing html or text' }, 400);
      if (body.dryRun) {
        return json(res, { ok: true, dryRun: true, wouldSendTo: countSubscribers(db) });
      }
      const subs = listSubscribers(db, { limit: 5000 });
      let sent = 0, failed = 0;
      const errors = [];
      for (const s of subs) {
        const r = await sendCloudflareEmail({ to: s.email, subject: body.subject, html: body.html, text: body.text });
        if (r.ok) sent++;
        else { failed++; if (errors.length < 5) errors.push({ email: s.email, err: r.error || r.status }); }
      }
      return json(res, { ok: true, total: subs.length, sent, failed, errors });
    }

    if (req.method === 'GET' && path === '/api/subscribers/count') {
      return json(res, { count: countSubscribers(db) });
    }

    if (req.method === 'GET' && path === '/api/subscribers') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const limit = Math.min(parseInt(params.get('limit') || '200'), 1000);
      const offset = parseInt(params.get('offset') || '0');
      return json(res, listSubscribers(db, { limit, offset }));
    }

    // One-click unsubscribe per RFC 8058 — Gmail's bulk-sender requirement.
    // Clients POST to the URL in List-Unsubscribe with an email-as-query and
    // form body 'List-Unsubscribe=One-Click'. Also handle GET (browser link).
    if ((req.method === 'POST' || req.method === 'GET') && path === '/api/unsubscribe' && params.get('email')) {
      const email = params.get('email');
      try { unsubscribeNewsletter(db, email); } catch {}
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>Unsubscribed</title><body style="font-family:system-ui;max-width:560px;margin:64px auto;padding:24px;color:#0f172a;"><h1 style="font-size:22px;">Unsubscribed.</h1><p style="color:#64748b;">${email} has been removed from the ChipMonk newsletter list.</p></body>`);
      }
      return json(res, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/unsubscribe') {
      const body = await parseBody(req);
      unsubscribeNewsletter(db, body.email || '');
      return json(res, { ok: true });
    }

    json(res, { error: 'not found' }, 404);
  } catch (e) {
    console.error(e);
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ClawFeed API running on http://0.0.0.0:${PORT}`);
  // Warm the company-embedding catalog so the first /api/candidates/extract is fast.
  // Failure here is non-fatal — classify() will retry on demand.
  loadCatalog().then(c => {
    console.log(`[catalog] loaded ${c.length} company embeddings via gateway`);
  }).catch(e => {
    console.warn(`[catalog] warm-up failed (will retry on demand):`, e.message);
  });
});
