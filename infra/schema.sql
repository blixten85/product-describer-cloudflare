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
