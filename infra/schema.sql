-- product-describer D1-schema. Motsvarar SQLite-databasen (accounts.db)
-- och filsystem-lagringen (config/accounts/<id>/credentials/,
-- provider_order.json) i den befintliga Flask-versionen.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', -- 'user' | 'admin' (operatörsverktyg gatas på admin)
  describe_mode TEXT NOT NULL DEFAULT 'on-demand', -- 'on-demand' | 'auto' (auto = beskriv underlaget automatiskt)
  created_at INTEGER NOT NULL
);

-- Externa OAuth-identiteter (Google/Microsoft) länkade till ett lokalt konto.
-- Konto skapat enbart via OAuth har ett slumpat oanvändbart lösenord.
CREATE TABLE oauth_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL,           -- google | microsoft
  provider_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, provider_user_id),
  UNIQUE(account_id, provider)
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
  -- Crawl/discovery (list-jobb). Speglar scraper_config i postgres.
  pagination_type TEXT NOT NULL DEFAULT 'query',   -- 'query' (?page=N) | annat -> enkelsida
  max_pages INTEGER NOT NULL DEFAULT 50,
  exclude_link_pattern TEXT NOT NULL DEFAULT '',   -- hoppa över URL:er som innehåller detta
  url_scope TEXT NOT NULL DEFAULT '',              -- behåll bara länkar under denna prefix
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

-- Avd. B prisbevakning: en rad per (konto, bevakad produkt). last_alert håller
-- cooldown per bevakning (så samma prisfall inte larmas om och om).
CREATE TABLE price_watch (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  last_alert INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, product_id)
);
CREATE INDEX idx_price_watch_product ON price_watch(product_id);

-- Larmkanaler per konto. kind: ntfy | slack | telegram | webhook. target bär
-- kanalens adress/config (ntfy-topic-URL, Slack-webhook, telegram "token:chatid",
-- generisk webhook-URL).
CREATE TABLE alert_channels (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Fas 5: bistånds-underlag. En rad per (konto, vald produkt) med kontots egna
-- personliga motivering ("varför just jag behöver detta"). Kontot väljer
-- produkter ur katalogen (products) och genererar en utskrivbar sida att skicka
-- till socialtjänsten. Per konto, till skillnad från den operatörs-ägda katalogen.
CREATE TABLE bistand_items (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  motivation TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, product_id)
);
CREATE INDEX idx_bistand_account ON bistand_items(account_id);

-- Fas: användar-inskickade sidförslag. En användare föreslår en sida; ett mail
-- går till admin (godkännande-grind) innan något implementeras. status:
-- pending | coded | approved | rejected.
CREATE TABLE page_suggestions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  email TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
