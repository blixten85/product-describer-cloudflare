# product-describer (Cloudflare-version)

AI-genererade produktbeskrivningar på svenska — Cloudflare Workers-version
av [product-describer](https://github.com/blixten85/product-describer)
(Flask/Docker). Samma funktionalitet, ny arkitektur:

- Konton, leverantörsnycklar (krypterade), jobb → D1 istället för SQLite/disk
- Uppladdade filer + resultat → R2 istället för det lokala filsystemet
- AI-anrop (Anthropic/OpenAI/Gemini/Azure OpenAI) via rå `fetch()` istället
  för officiella SDK:er (ingen av SDK:erna kan köras i Workers-runtimen)
- Jobbkörning (extraktion + radvis beskrivningsgenerering) via en
  **Cloudflare Queue** istället för en bakgrundstråd med ThreadPoolExecutor
  — Workers kan inte köra en flertimmars bakgrundsprocess i en enda
  invocation, så varje rad blir ett eget kö-meddelande istället
- `sync --watch`-bakgrundspollern mot scraper-API:et → en **Cron Trigger**
  (var 5:e minut) istället för en evig while-loop

## Struktur

Tre Workers:

- `app/` — webb-UI + API (auth, inställningar, filuppladdning, jobblista/nedladdning). Lägger en `extract`-kö-post per uppladdning, gör inget extraktions-/AI-arbete själv.
- `processor/` — kö-konsument. Extraherar produktrader ur uppladdade filer (CSV/XLSX/TXT/DOCX/PDF) och genererar en beskrivning per rad. Paus/återupptagning vid leverantörskvot hanteras via `queueMsg.retry({delaySeconds})`, inte en persisterad bakgrundstråd.
- `sync/` — Cron Trigger var 5:e minut. Pollar scraper-API:et efter produkter utan beskrivning, genererar, skickar tillbaka. Använder miljövariabel-baserade nycklar (operatörens egna), inte kontobundna.

`shared/` — kod gemensam för flera Workers (kryptering, AI-providers, prompts, kontoinställningar). OBS: `extractors.ts` ligger i `processor/src/` istället för `shared/` trots att den konceptuellt är delad logik — TypeScripts modulupplösning för tredjepartsbibliotek (xlsx/mammoth/unpdf) söker bara uppåt i katalogträdet, så filer i `shared/` (ett syskon till `processor/`) kan inte hitta paket som bara finns i `processor/node_modules`.

## Känd, medvetet olöst skillnad mot Flask-versionen

`github_report.py`s automatiska felrapportering till GitHub-issues är INTE
porterad — `sync/`/`processor/` loggar bara till `console.error`/`console.warn`
(synligt via `wrangler tail`/dashboarden) istället. Kan läggas till senare
om det visar sig behövas.

## Sätta upp lokalt

```bash
cd app && npm install && cp .dev.vars.example .dev.vars   # fyll i ett riktigt PROVIDER_CONFIG_KEY
cd ../processor && npm install && cp .dev.vars.example .dev.vars  # samma nyckel som ovan
cd ../sync && npm install

openssl rand -base64 32   # generera PROVIDER_CONFIG_KEY
```

`PROVIDER_CONFIG_KEY` måste vara **samma värde** i `app` och `processor`
(app krypterar, processor dekrypterar — samma mönster som politiker-webapps
`MAIL_CRED_KEY`).

D1-schema (lokalt):
```bash
cd app && npx wrangler d1 execute product_describer --local --file=../infra/schema.sql
```

**Testa app+processor tillsammans lokalt** (kö-simuleringen delas INTE
mellan separata `wrangler dev`-processer — känd Wrangler-begränsning):
```bash
cd app && npx wrangler dev --local --persist-to /tmp/pd-state -c wrangler.jsonc -c ../processor/wrangler.jsonc
```

## Deploy

Kräver riktiga D1-/R2-/KV-/Queue-resurser provisionerade (database_id/kv id
är `"TBD"`-platshållare i wrangler.jsonc-filerna just nu) samt:

```bash
cd app && npx wrangler secret put PROVIDER_CONFIG_KEY && npx wrangler deploy
cd ../processor && npx wrangler secret put PROVIDER_CONFIG_KEY && npx wrangler deploy   # samma värde som ovan
cd ../sync && npx wrangler secret put SCRAPER_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY   # och/eller OPENAI_API_KEY/GEMINI_API_KEY
npx wrangler deploy
```

`sync`s `SCRAPER_URL` pekar på `https://scraper-api.denied.se` (publikt
tunnlat på mp100, skyddat av `X-API-Key`) — se `infra/` för bakgrund om
scraper-tjänsten själv (som INTE flyttas till Cloudflare: Playwright-baserad
webbskrapning och Postgres-specifika SQL-funktioner gör den inte
migrerbar, se commit-historiken för den bedömningen).

## Verifierat lokalt (denna migrering)

- Signup/login/sessioner, kryptering av leverantörsnycklar
- Filuppladdning (R2) + jobbskapande (D1)
- Hela kö-kedjan end-to-end: extraktion av en CSV → per-rad-beskrivning →
  jobbslutförande med genererad utdata-CSV i R2 (testat med en avsiktligt
  ogiltig API-nyckel — bekräftade att 401-fel hanteras korrekt utan att
  fastna eller krascha)
- PDF-extraktion (`unpdf`) mot riktiga flersidiga PDF-filer
- **Inte** verifierat: en riktig, fungerande AI-nyckel end-to-end (testades
  bara med en avsiktligt ogiltig nyckel), produktionsdeploy, sync-Workerns
  Cron Trigger i verklig drift
