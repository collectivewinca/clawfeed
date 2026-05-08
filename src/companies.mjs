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

const GATEWAY_URL = 'http://169.254.169.254/gateway/llm/openai/v1/embeddings';
const EMBED_MODEL = 'text-embedding-3-small';
const VESTOCK_EMBEDDINGS_URL = 'https://ve-stock.exe.xyz/api/chipmonk/embeddings?limit=50';

const KNOWN_THRESHOLD = 0.70;      // tuned: same entity, slight variations
const CANDIDATE_THRESHOLD = 0.40;  // tuned: semantic neighbor in same domain

let CATALOG = null;  // [{ symbol, name, vector: Float32Array }]
let CATALOG_LOADED_AT = null;

export async function embedTexts(inputs) {
  if (!Array.isArray(inputs)) inputs = [inputs];
  const r = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`embed failed: HTTP ${r.status} ${body.slice(0, 200)}`);
  }
  const d = await r.json();
  return d.data
    .sort((a, b) => a.index - b.index)
    .map(e => Float32Array.from(e.embedding));
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

// Extract entity strings from a single mark's note body.
// Looks for the **KEY ENTITIES:** line emitted by article_reader.py.
export function extractEntitiesFromNote(note) {
  if (!note) return [];
  const out = [];
  const re = /\*\*KEY ENTITIES:\*\*\s*([^\n]+)/g;
  let m;
  while ((m = re.exec(note))) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/[.;]+$/, '').trim();
      if (name && name.length >= 2 && name.length <= 60) out.push(name);
    }
  }
  return out;
}
