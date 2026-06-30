-- product-describer D1-schema. Motsvarar SQLite-databasen (accounts.db)
-- och filsystem-lagringen (config/accounts/<id>/credentials/,
-- provider_order.json) i den befintliga Flask-versionen.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- En rad per (konto, leverantör) — encrypted_config är ett AES-GCM-krypterat
-- JSON-blob {"api_key": "...", ...extra fält som Azures endpoint/deployment}.
-- Motsvarar provider_config.py:s Fernet-krypterade filer.
CREATE TABLE provider_configs (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL,
  encrypted_config TEXT NOT NULL,
  PRIMARY KEY (account_id, provider)
);

-- Failover-ordning, en rad per konto. order_json: [{"provider": "...", "model": "..."}].
CREATE TABLE provider_order (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  order_json TEXT NOT NULL
);

-- Motsvarar outputs/{job_id}_rows.json/_partial.json + jobs.json i Flask-
-- versionen — job-status och resultat samlat i en tabell istället för
-- separata JSON-filer på disk. rows_json/partial_results_json hålls som
-- text snarare än normaliserade rader eftersom radschema varierar fritt
-- (vilka kolumner som finns beror på indatafilen).
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL, -- 'queued' | 'processing' | 'paused' | 'done' | 'error'
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL, -- uppladdad indatafil i R2
  output_key TEXT, -- genererad CSV i R2, satt när status='done'
  options_json TEXT NOT NULL DEFAULT '{}', -- {tone, length, audience} — UI-valen för ton/längd/målgrupp
  custom_direction TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  rows_json TEXT, -- extraherade rader innan AI-bearbetning, cachat för att en paus aldrig ska tappa redan extraherat arbete. Rensas när jobbet blir 'done'.
  partial_results_json TEXT, -- per-rad-resultat hittills, samma syfte. Rensas när jobbet blir 'done'.
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_jobs_account ON jobs(account_id);

-- ============================================================================
-- Katalog-domänen (f.d. scraperns postgres). Operatörs-ägd, inte per konto.
-- Se DESIGN.md: Cloudflare blir sanningskälla, servern krymps till en
-- statslös Playwright-fetcher som leasar render_jobs och postar tillbaka.
-- Tidsstämplar = unix-ms (INTEGER), samma konvention som jobs ovan.
-- ============================================================================

-- f.d. scraper_config: en rad per sajt som ska crawlas.
CREATE TABLE sites (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  base_url TEXT NOT NULL,
  product_selector TEXT NOT NULL DEFAULT '',
  title_selector TEXT NOT NULL DEFAULT '',
  price_selector TEXT NOT NULL DEFAULT '',
  link_selector TEXT NOT NULL DEFAULT '',
  pagination_selector TEXT NOT NULL DEFAULT '',
  detail_selector TEXT NOT NULL DEFAULT '',   -- per-sajt CSS för produktbeskrivning (B.2)
  use_stealth INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  scrape_interval INTEGER NOT NULL DEFAULT 3600, -- sekunder
  last_crawled INTEGER
);

-- Produktkatalogen. url är naturlig nyckel (upsert-mål).
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  site_id INTEGER REFERENCES sites(id),
  title TEXT,
  current_price INTEGER,
  source_text TEXT,                 -- grundtext extraherad från produktsidan
  category TEXT,
  description TEXT,                  -- AI-genererad
  description_why TEXT,
  description_updated_at INTEGER,
  source_text_updated_at INTEGER,
  first_seen INTEGER NOT NULL,
  last_updated INTEGER NOT NULL
);
-- Partiella index för cron-urvalen (motsvarar postgres-versionens).
CREATE INDEX idx_products_missing_desc   ON products(id) WHERE description IS NULL;
CREATE INDEX idx_products_missing_source ON products(id) WHERE source_text IS NULL;
CREATE INDEX idx_products_site           ON products(site_id);

CREATE TABLE price_history (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_price_history_product ON price_history(product_id);

-- Köersättning för Cloudflare Queues (Queues kräver Paid; detta håller noll
-- kostnad). Lease/ack-mönster: fetchern leasar pending-jobb, postar resultat,
-- cron återställer utgångna leases till pending (självläkande).
CREATE TABLE render_jobs (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  site_id INTEGER REFERENCES sites(id),
  type TEXT NOT NULL,               -- 'list' | 'detail'
  status TEXT NOT NULL DEFAULT 'pending', -- pending | leased | done | error
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Snabbt urval av leasbara jobb (pending, eller leased med utgången lease).
CREATE INDEX idx_render_jobs_claimable ON render_jobs(status, lease_until);

CREATE TABLE alert_cooldown (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  last_alert INTEGER NOT NULL
);
