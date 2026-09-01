// Company catalog ↔ candidate classification.
//
// On boot, fetch the 15 ve-stock company embeddings (text + metadata),
// embed each text via the exe.dev LLM gateway, and cache the vectors in memory.
//
// During extraction, embed each candidate name and compute cosine similarity
// against the catalog. Verdict thresholds:
//   ≥ KNOWN_THRESHOLD       → known (it IS one of our catalog companies, skip)
//   ≥ CANDIDATE_THRESHOLD   → candidate (semantic neighbor, queue for review)
//   <  CANDIDATE_THRESHOLD  → not_a_company (ignored)

const GATEWAY_URL = 'http://127.0.0.1:11434/v1/embeddings';
const EMBED_MODEL = 'embeddinggemma';
const VESTOCK_EMBEDDINGS_URL = 'https://ve-stock.exe.xyz/api/chipmonk/embeddings?limit=50';

const KNOWN_THRESHOLD = 0.50;      // embeddinggemma: known 0.52-0.62, candidates <=0.45
const CANDIDATE_THRESHOLD = 0.38;  // embeddinggemma: real off-catalog chip cos ~0.39-0.45, noise below

let CATALOG = null;  // [{ symbol, name, vector: Float32Array }]
let CATALOG_LOADED_AT = null;

const EMBED_BATCH = 48;            // keep each call well under the timeout
const EMBED_TIMEOUT_MS = 60000;   // local embeddinggemma is ~165ms/text

export async function embedTexts(inputs) {
  if (!Array.isArray(inputs)) inputs = [inputs];
  if (!inputs.length) return [];
  const out = [];
  for (let i = 0; i < inputs.length; i += EMBED_BATCH) {
    const batch = inputs.slice(i, i + EMBED_BATCH);
    const r = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`embed failed: HTTP ${r.status} ${body.slice(0, 200)}`);
    }
    const d = await r.json();
    for (const e of d.data.sort((a, b) => a.index - b.index)) out.push(Float32Array.from(e.embedding));
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function loadCatalog({ force = false } = {}) {
  if (CATALOG && !force) return CATALOG;
  const r = await fetch(VESTOCK_EMBEDDINGS_URL, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`ve-stock embeddings fetch failed: ${r.status}`);
  const d = await r.json();
  const records = Array.isArray(d.records) ? d.records : [];
  if (!records.length) throw new Error('ve-stock returned no embeddings records');
  const texts = records.map(r => r.text);
  const vectors = await embedTexts(texts);
  CATALOG = records.map((r, i) => ({
    symbol: r.id || r.metadata?.symbol,
    name: r.metadata?.name || r.id,
    vector: vectors[i],
  }));
  CATALOG_LOADED_AT = new Date().toISOString();
  return CATALOG;
}

export function catalogStatus() {
  return {
    loaded: !!CATALOG,
    count: CATALOG ? CATALOG.length : 0,
    loadedAt: CATALOG_LOADED_AT,
  };
}

export async function classify(name) {
  if (!CATALOG) {
    try { await loadCatalog(); } catch (e) {
      return { verdict: 'unknown', error: 'catalog_unavailable', detail: e.message };
    }
  }
  const [vec] = await embedTexts([name]);
  let best = { symbol: null, name: null, score: -1 };
  for (const c of CATALOG) {
    const s = cosine(vec, c.vector);
    if (s > best.score) best = { symbol: c.symbol, name: c.name, score: s };
  }
  let verdict;
  if (best.score >= KNOWN_THRESHOLD) verdict = 'known';
  else if (best.score >= CANDIDATE_THRESHOLD) verdict = 'candidate';
  else verdict = 'not_a_company';
  return { verdict, bestMatch: best.symbol, bestName: best.name, score: best.score };
}

// Batch-embed many candidate strings and classify each. More efficient than
// per-string for the extraction job — one HTTP call instead of N.
export async function classifyBatch(names) {
  if (!CATALOG) await loadCatalog();
  if (!names.length) return [];
  const vecs = await embedTexts(names);
  return names.map((name, i) => {
    const v = vecs[i];
    let best = { symbol: null, name: null, score: -1 };
    for (const c of CATALOG) {
      const s = cosine(v, c.vector);
      if (s > best.score) best = { symbol: c.symbol, name: c.name, score: s };
    }
    let verdict;
    if (best.score >= KNOWN_THRESHOLD) verdict = 'known';
    else if (best.score >= CANDIDATE_THRESHOLD) verdict = 'candidate';
    else verdict = 'not_a_company';
    return { name, verdict, bestMatch: best.symbol, bestName: best.name, score: best.score };
  });
}

// Generic terms, sectors, and geographies that are NOT companies — never emit as
// candidates (embeddings score some of these high against a chip catalog, so the
// stop-list is the precision floor regardless of isLikelyCompany()).
const ENTITY_STOPLIST = new Set([
  'ai', 'a.i.', 'artificial intelligence', 'machine learning', 'deep learning', 'generative ai',
  'data center', 'data centers', 'datacenter', 'cloud', 'inference', 'training', 'compute',
  'gpu', 'gpus', 'cpu', 'chip', 'chips', 'semiconductor', 'semiconductors', 'foundry', 'wafer',
  'hbm', 'hbm memory', 'euv', 'euv lithography', 'memory', 'dram', 'nand', 'lithography',
  'supply chain', 'capex', 'revenue', 'gross margin', 'earnings', 'quarterly earnings', 'guidance',
  'wall street', 'nasdaq', 'nyse', 's&p 500', 'the fed', 'federal reserve', 'the white house',
  'united states', 'u.s.', 'us', 'china', 'taiwan', 'south korea', 'korea', 'japan', 'europe',
  'asia', 'india', 'the company', 'the market', 'this week', 'the deal',
  // bare corp-suffix tokens, units, and finance abbreviations (extraction artifacts)
  'inc', 'co', 'corp', 'llc', 'ltd', 'plc', 'sa', 'nv', 'ag', 'group', 'holdings',
  'mw', 'gw', 'kw', 'eps', 'ebitda', 'etf', 'ipo', 'ceo', 'cfo', 'cto',
  'q1', 'q2', 'q3', 'q4', 'yoy', 'gaap', 'traders', 'trading', 'recent', 'american', 'bitcoin',
]);

// High-precision company-name tail tokens (useful inside isLikelyCompany).
const COMPANY_SUFFIX = /\b(Inc|Incorporated|Corp|Corporation|Co|Ltd|LLC|PLC|NV|AG|Technologies|Technology|Systems|Labs|Laboratories|Energy|Semiconductor|Semiconductors|Holdings|Platforms|Group|Solutions|Micro|Microelectronics|Devices|Materials|Networks|Digital|Power|Industries|Partners|Capital|Dynamics)\b/;

// Common sentence-initial / filler words that are Capitalized but not companies.
const COMMON_WORDS = new Set([
  'this', 'that', 'these', 'those', 'it', 'its', 'their', 'they', 'we', 'he', 'she',
  'despite', 'however', 'while', 'although', 'meanwhile', 'additionally', 'furthermore',
  'moreover', 'overall', 'recently', 'earlier', 'according', 'both', 'new', 'more', 'other',
  'several', 'many', 'some', 'analysts', 'investors', 'markets', 'shares', 'management',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
]);

// Multi-word Capitalized phrases that are roles / publications / places, not companies.
const ROLE_PHRASES = new Set([
  'chief executive', 'chief executive officer', 'wall street journal', 'new york',
  'new york times', 'european union', 'south korea', 'hong kong', 'silicon valley',
]);

// Decide whether a Capitalized prose phrase (1-5 words) is a company-name candidate.
// Recall-leaning on purpose: classifyBatch (embeddinggemma, 0.50/0.38) is the precision
// second stage, and the candidate queue is human-reviewed. push() still applies the
// ENTITY_STOPLIST + dedup + length floor after this returns.
function isLikelyCompany(phrase) {
  if (COMPANY_SUFFIX.test(phrase)) return true;                     // explicit corp suffix, any length
  if (/^[A-Z]{2,5}$/.test(phrase)) return true;                    // ticker-like: AMD, TSMC, ASML
  if (/[0-9&]/.test(phrase) && /^[A-Z]/.test(phrase)) return true; // T1, AT&T, 3M
  const words = phrase.split(/\s+/);
  if (words.length >= 2) return !ROLE_PHRASES.has(phrase.toLowerCase());
  return phrase.length >= 3 && !COMMON_WORDS.has(phrase.toLowerCase());
}

// Extract company-name candidates from a mark's note body. Model-agnostic: works on
// deepseek prose AND still honors the legacy "**KEY ENTITIES:**" marker from old
// haiku-era notes. Returns a deduped list of candidate strings for classifyBatch().
export function extractEntitiesFromNote(note) {
  if (!note) return [];
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const name = String(raw).trim()
      .replace(/['’]s?$/i, '')            // possessive: Vistra's -> Vistra
      .replace(/^(?:The|A|An)\s+/i, '')
      .replace(/[.,;:&'’\-\s]+$/, '')     // trailing punctuation / connector
      .trim();
    if (name.length < 2 || name.length > 60) return;
    const key = name.toLowerCase();
    if (ENTITY_STOPLIST.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };

  // 1) Legacy structured marker (old haiku-era notes) — honor it if present.
  let matched = false;
  const reMarker = /\*\*KEY ENTITIES:?\*\*\s*([^\n]+)/gi;
  let m;
  while ((m = reMarker.exec(note))) {
    matched = true;
    for (const raw of m[1].split(',')) push(raw);
  }
  if (matched) return out;

  // 2) Prose path: segment on sentence/line breaks FIRST (so a phrase never bleeds
  //    across "Thailand. This"), then capture Capitalized proper-noun phrases
  //    (1-5 words, internal of/and/& allowed) and gate each through isLikelyCompany().
  for (const seg of note.split(/[.!?]\s+|\n+/)) {
    const reProper = /[A-Z][A-Za-z0-9&]*(?:[ \t]+(?:[A-Z][A-Za-z0-9&]*|of|and|&)){0,4}/g;
    let pm;
    while ((pm = reProper.exec(seg))) {
      const phrase = pm[0].replace(/[ \t]+(?:of|and|&)$/i, '').trim();
      if (isLikelyCompany(phrase)) push(phrase);
    }
  }
  return out;
}
