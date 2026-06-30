# Design: enhetlig product-describer (scraper + describer)

Status: **förslag** · 2026-06-30 · författare: Claude (arkitekt på uppdrag av operatören)

## 1. Varför

Idag är systemet uppdelat på två ben med olika pålitlighet:

- **scraper** (egen server): Playwright-crawl + postgres som **sanningskälla** för
  hela produktkatalogen (titel, pris, `source_text`, beskrivningar, prishistorik).
- **product-describer-cloudflare**: beskriv-motorn (filuppladdning + en `sync`-cron
  som pollar scraperns API).

Problemet visade sig 2026-06-29: en USB-disk dog och tog hela postgres med sig —
~32k produkter och all berikning borta. Servern är opålitlig; ändå bor systemets
**minne** där.

Operatörens direktiv: *flytta så mycket som möjligt till Cloudflare; det som måste
köras på servern (Playwright — för dyrt att migrera till Browser Rendering) får göra
det; product-describer ska bli "allt scraper är + product-describer". Noll ny
löpande kostnad.*

## 2. Bärande princip

> **Cloudflare = hjärna + minne. Servern = en utbytbar muskel.**

All durabel data och all logik flyttar till Cloudflare (D1/Workers/R2). På servern
blir kvar enbart en **statslös Playwright-fetcher** som renderar sidor på beställning.
Dör servern förlorar man bara muskeln — den redeployas på minuter, datan är orörd i D1.

## 3. Ground-up-val (avviker medvetet från dagens design)

### 3.1 Pull i stället för push
Fetchern **pollar** Cloudflare efter renderingsjobb i stället för att CF anropar
servern. Konsekvenser:

- Fetchern behöver **bara utgående HTTPS** — ingen inkommande route, **ingen
  cloudflared-tunnel för scrapern alls** (`scraper-api.denied.se` kan pensioneras).
- Fetchern blir trivialt portabel: kör var som helst med en API-nyckel + utgående nät.
- CF äger all schemaläggning och allt tillstånd.

### 3.2 `render_jobs`-tabell i D1 i stället för Cloudflare Queues
En jobbkö som D1-tabell (lease/ack-mönster) ger pull-modellen sin backing **och**
håller oss på gratisnivå (Queues kräver Workers Paid). Cron fyller kön, fetchern
leasar, Workers konsumerar resultat.

### 3.3 D1 som enda sanningskälla
Postgres pensioneras. Katalog, `source_text`, beskrivningar och prishistorik bor i D1.

## 4. Målarkitektur

```
                       Cloudflare (hjärna + minne)
  ┌─────────────────────────────────────────────────────────────────┐
  │  D1: accounts/jobs (befintligt)  +  products, price_history,      │
  │      sites, render_jobs, alert_cooldown (nytt)                    │
  │                                                                   │
  │  Workers:                                                         │
  │   • app      — UI/API: katalog, produktsidor, upload (befintligt) │
  │   • ingest   — POST /jobs/lease, POST /jobs/:id/result (fetcher)  │
  │   • cron(5m) — schemalägg crawl/source_text-jobb; beskriv         │
  │                produkter som saknar description (Gemini/Haiku)    │
  │   • alerts   — prisfall → e-post/webhook                          │
  └───────────────▲───────────────────────────────────────▲──────────┘
                  │ (1) GET /jobs/lease                     │ (3) outbound LLM
                  │ (2) POST /jobs/:id/result               │
  ┌───────────────┴───────────────┐
  │  Server (muskel)              │   statslös, bara utgående HTTPS
  │   fetcher: Playwright-loop    │   render URL → extrahera → posta upp
  └───────────────────────────────┘
```

### 4.1 Fetchern (allt som blir kvar på servern)
En liten long-running process (Python + Playwright). Loop:

1. `GET /jobs/lease?n=N` → får N jobb `{id, url, type, detail_selector, use_stealth}`.
2. Renderar med Playwright (återanvänder dagens vänte-/extraktionslogik:
   `RENDER_WAIT_MS`, JSON-LD → `detail_selector` → og → meta för `type=detail`;
   listselektorer för `type=list`).
3. `POST /jobs/:id/result` med `{title, price, source_text}` eller upptäckta länkar.

Ingen DB, ingen inkommande port, ingen tunnel. Paketeras som en minimal container
eller systemd-tjänst. Återanvänder kod från dagens `scraper.py`/`enrich.py`.

### 4.2 Nya D1-tabeller (utöver befintliga accounts/jobs)
```sql
CREATE TABLE sites (              -- f.d. scraper_config
  id INTEGER PRIMARY KEY, name TEXT UNIQUE, base_url TEXT,
  product_selector TEXT, title_selector TEXT, price_selector TEXT,
  link_selector TEXT, pagination_selector TEXT, detail_selector TEXT DEFAULT '',
  use_stealth INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
  scrape_interval INTEGER DEFAULT 3600
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY, url TEXT UNIQUE, site_id INTEGER REFERENCES sites(id),
  title TEXT, current_price INTEGER,
  source_text TEXT, category TEXT,
  description TEXT, description_why TEXT, description_updated_at INTEGER,
  source_text_updated_at INTEGER, first_seen INTEGER, last_updated INTEGER
);
CREATE INDEX idx_products_missing_desc   ON products(id) WHERE description IS NULL;
CREATE INDEX idx_products_missing_source ON products(id) WHERE source_text IS NULL;
CREATE TABLE price_history ( product_id INTEGER REFERENCES products(id), price INTEGER, ts INTEGER );
CREATE TABLE render_jobs (       -- köersättning (lease/ack), inga Queues
  id INTEGER PRIMARY KEY, url TEXT, site_id INTEGER, type TEXT,  -- 'list' | 'detail'
  status TEXT DEFAULT 'pending', -- pending | leased | done | error
  attempts INTEGER DEFAULT 0, lease_until INTEGER, created_at INTEGER
);
CREATE INDEX idx_render_jobs_claimable ON render_jobs(status, lease_until);
CREATE TABLE alert_cooldown ( product_id INTEGER PRIMARY KEY REFERENCES products(id), last_alert INTEGER );
```

### 4.3 API-kontrakt (Workers)
- `GET  /jobs/lease?n=` → `[{id,url,type,detail_selector,use_stealth}]` (sätter status=leased, lease_until=now+X).
- `POST /jobs/:id/result` → `{title?,price?,source_text?,links?[]}` → upsert i `products`/`price_history`, status=done. `links` (från list-jobb) skapar nya detail-jobb.
- Befintliga upload-/describe-rutter orörda.
- Auth: `X-API-Key` (operatörsnyckel, som dagens scraper-API).

### 4.4 Cron (var 5:e min, ersätter `scraper.py`-loop + dagens `sync`)
1. **Schemalägg:** för varje aktivt `site` vars intervall löpt ut → skapa `list`-render-jobb. För `products` med `source_text IS NULL` → skapa `detail`-jobb (rate-limitat antal per cykel).
2. **Beskriv:** ta N `products` med `description IS NULL` (helst där `source_text IS NOT NULL`), generera via Gemini/Haiku, skriv tillbaka. (Detta är dagens `sync`, men mot D1 i stället för scraper-API.)
3. **Städa:** utgångna leases (`leased` + `lease_until<now`) → tillbaka till `pending` (resumabelt om fetchern dör).

## 5. Kostnad (operatörens hårda noll-regel)
- **Playwright stannar lokalt** → ingen Browser Rendering-kostnad.
- **D1** inom gratisnivå: ~33k produkter ≪ 5 GB; backfill ~33k writes < 100k/dag-gränsen; katalog-läsningar måttliga. Bevaka read-units om UI blir tungt.
- **Inga Queues** → ingen ny Paid-utlösare (render_jobs-tabell i stället).
- **Cron Triggers** ingår. Nettotillägg: **0 kr** (utöver befintligt $5-golv som redan finns via politiker-webapp).

## 6. Migrering (engång)
Den pågående backloggen fyller *lokal* postgres → den blir migreringskällan:
1. När backloggen är klar: exportera `products` (+ `source_text`, `price_history`, `sites`) → NDJSON.
2. Importera till D1 via `wrangler d1 execute`/batch-API.
3. Verifiera antal + stickprov.

## 7. Faser (varje fas = egen PR, additiv tills sista)
- **Fas 1 — fundament (river inget):** D1-tabeller + `GET /jobs/lease` + `POST /jobs/:id/result`. Befintligt orört.
- **Fas 2 — fetcher:** ny `fetcher/` (Playwright pull-loop) som ersätter `scraper.py`+`enrich.py`. Körs parallellt mot dagens scraper för validering.
- **Fas 3 — migrering:** postgres → D1. CF blir sanningskälla.
- **Fas 4 — cron:** flytta schemaläggning + beskriv-loop till Workers-cron mot D1; dagens `sync` (mot scraper-API) pensioneras.
- **Fas 5 — alerts + UI:** prisvakt + katalog/produktsidor i `app`.
- **Fas 6 — rivning:** pensionera lokal postgres, scraper-API, `scraper.denied.se`/`scraper-api.denied.se`-routes. Kvar på servern: enbart fetchern.

## 8. Risker / öppna frågor
- **D1 read-units** vid tung katalog-UI → mät tidigt; cachea aggregat i KV vid behov.
- **Fetcher-robusthet:** lease-timeout + attempts-tak gör jobb självläkande; döda jobb → `error` efter N försök.
- **Repo-topologi:** fetchern kan bo i `fetcher/` här, eller `scraper`-repot krympas till fetchern. Beslut i Fas 2.
- **Fyndvara (~8%)** saknar Product-JSON-LD → behåller boilerplate tills ev. arv från moderprodukt; ej blockerande.
