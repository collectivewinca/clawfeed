-- Candidate companies extracted from mark KEY ENTITIES lines.
-- Classified against the ve-stock catalog via cosine sim of OpenAI text-embedding-3-small.
-- Approved candidates are exported as JSON for manual paste into ve-stock's watchlist.

CREATE TABLE IF NOT EXISTS company_candidates (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,           -- raw extracted string, preserved as seen
  name_normalized     TEXT NOT NULL UNIQUE,    -- lowercase + trimmed, for dedupe
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  source_count        INTEGER DEFAULT 1,       -- how many marks have mentioned it
  best_known_match    TEXT,                    -- nearest ve-stock symbol (e.g. NVDA)
  best_known_score    REAL,                    -- cosine 0..1
  classifier_verdict  TEXT,                    -- known | candidate | not_a_company
  first_seen_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  reviewed_at         DATETIME,
  notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_company_candidates_status ON company_candidates(status);
CREATE INDEX IF NOT EXISTS idx_company_candidates_verdict ON company_candidates(classifier_verdict);

-- Stoplist: names we've decided are not companies (geo, products, generic concepts, publishers).
-- Auto-skipped on subsequent extraction runs.
CREATE TABLE IF NOT EXISTS company_stoplist (
  name_normalized     TEXT PRIMARY KEY,
  reason              TEXT,                    -- 'geo' | 'product' | 'generic' | 'publisher' | 'rejected'
  added_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed obvious negatives so the first extraction run isn't 80% noise.
INSERT OR IGNORE INTO company_stoplist (name_normalized, reason) VALUES
  ('china', 'geo'),
  ('taiwan', 'geo'),
  ('malaysia', 'geo'),
  ('singapore', 'geo'),
  ('vietnam', 'geo'),
  ('south korea', 'geo'),
  ('korea', 'geo'),
  ('japan', 'geo'),
  ('india', 'geo'),
  ('united states', 'geo'),
  ('u.s.', 'geo'),
  ('us', 'geo'),
  ('europe', 'geo'),
  ('eu', 'geo'),
  ('asia', 'geo'),
  ('asia-pacific', 'geo'),
  ('southeast asia', 'geo'),
  ('sea', 'geo'),
  ('arizona', 'geo'),
  ('ai chips', 'generic'),
  ('cpus', 'generic'),
  ('gpus', 'generic'),
  ('hbm', 'generic'),
  ('llm', 'generic'),
  ('soc', 'generic'),
  ('asic', 'generic'),
  ('ai workloads', 'generic'),
  ('ai accelerator', 'generic'),
  ('ai accelerators', 'generic'),
  ('ai factories', 'generic'),
  ('hpc systems', 'generic'),
  ('data centers', 'generic'),
  ('data center', 'generic'),
  ('cloud', 'generic'),
  ('open-source', 'generic'),
  ('semiconductors', 'generic'),
  ('semiconductor industry', 'generic'),
  ('global semiconductor market', 'generic'),
  ('generative ai applications', 'generic'),
  ('sovereign ai', 'generic'),
  ('ai hardware', 'generic'),
  ('supply chain diversification', 'generic'),
  ('electronics manufacturing', 'generic'),
  ('asic demand', 'generic'),
  ('q1 2026', 'time'),
  ('q2 2026', 'time'),
  ('q3 2026', 'time'),
  ('q4 2026', 'time'),
  ('mit technology review', 'publisher'),
  ('ars technica', 'publisher'),
  ('bloomberg', 'publisher'),
  ('reuters', 'publisher'),
  ('techcrunch', 'publisher'),
  ('wsj', 'publisher'),
  ('the verge', 'publisher'),
  ('osat', 'generic'),
  ('multi-token prediction', 'product'),
  ('speculative decoding', 'product'),
  ('tpu', 'product'),
  ('mlx', 'product'),
  ('vllm', 'product'),
  ('sglang', 'product'),
  ('ollama', 'product'),
  ('windows', 'product'),
  ('linux', 'product'),
  ('android', 'product'),
  ('iphone', 'product'),
  ('pixel phones', 'product'),
  ('apple m4', 'product'),
  ('gemma 4', 'product'),
  ('nvidia rtx pro 6000', 'product');
