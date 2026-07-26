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
- Katalog-/beskrivningsloopen (f.d. `sync --watch` mot scraper-API:et) → en
  **Cron Trigger** i `engine/` var 5:e minut, mot D1 istället för scraper-API:et

## Struktur

Workers:

- `app/` — webb-UI + API (auth, inställningar, filuppladdning, jobblista/nedladdning, katalog, prisbevakning, bistånds-underlag, admin-panel). Lägger en `extract`-kö-post per uppladdning, gör inget extraktions-/AI-arbete själv.
- `processor/` — kö-konsument. Extraherar produktrader ur uppladdade filer (CSV/XLSX/TXT/DOCX/PDF) och genererar en beskrivning per rad. Paus/återupptagning vid leverantörskvot hanteras via `queueMsg.retry({delaySeconds})`, inte en persisterad bakgrundstråd.
- `engine/` — katalog-motorn. En Cron Trigger var 5:e minut driver crawl/discovery, schemaläggning av detaljjobb och prisbevakning mot D1, plus HTTP-endpoints som den serverbundna Playwright-fetchern anropar (lease/ack). On-demand-beskrivning via `POST /describe`. Använder operatörens egna miljövariabel-nycklar, inte kontobundna.
- `token-rotator/` — Cron som förlänger Cloudflare API-tokens nära utgång så token-hygienen blir självgående.

`shared/` — kod gemensam för flera Workers (kryptering, AI-providers, prompts, kontoinställningar). OBS: `extractors.ts` ligger i `processor/src/` istället för `shared/` trots att den konceptuellt är delad logik — TypeScripts modulupplösning för tredjepartsbibliotek (xlsx/mammoth/unpdf) söker bara uppåt i katalogträdet, så filer i `shared/` (ett syskon till `processor/`) kan inte hitta paket som bara finns i `processor/node_modules`.

## Automatisk felrapportering

`github_report.py` är porterad till `shared/github-report.ts`: oväntade
driftfel i `processor/` (kö-konsumentens topp-catch) och `engine/` (cron +
fetcher-endpoints) öppnar en `@claude`-taggad GitHub-issue, med
samma sanering (env-hemligheter, nyckelmönster, e-post, home-paths) och
avdubblering via fingeravtryck som Flask-versionen. No-op om secreten
`GITHUB_ERROR_REPORT_TOKEN` saknas — då loggas felen bara till
`console.error`/`console.warn` (synligt via `wrangler tail`/dashboarden).
Ingen in-memory-throttle som i Flask: Workers-isolat är kortlivade och delar
inte minne, så GitHub-sidans avdubblering är enda spärren.

## Sätta upp lokalt

```bash
cd app && npm install && cp .dev.vars.example .dev.vars   # fyll i ett riktigt PROVIDER_CONFIG_KEY
cd ../processor && npm install && cp .dev.vars.example .dev.vars  # samma nyckel som ovan

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
cd ../engine && npx wrangler secret put INGEST_API_KEY   # operatörsnyckel för fetcher-endpoints
npx wrangler secret put GEMINI_API_KEY   # och/eller ANTHROPIC_API_KEY/OPENAI_API_KEY för beskriv-steget
npx wrangler secret put GITHUB_ERROR_REPORT_TOKEN   # valfritt: auto-felrapportering (även i processor/)
npx wrangler deploy
```

Själva renderingen (Playwright-baserad webbskrapning) flyttas INTE till
Cloudflare — den körs som en statslös fetcher på mp100 som leasar `render_jobs`
från `engine/` och postar tillbaka resultat (skyddat av `X-API-Key`). Se
`DESIGN.md` för arkitekturen.

## Verifierat lokalt (denna migrering)

- Signup/login/sessioner, kryptering av leverantörsnycklar
- Filuppladdning (R2) + jobbskapande (D1)
- Hela kö-kedjan end-to-end: extraktion av en CSV → per-rad-beskrivning →
  jobbslutförande med genererad utdata-CSV i R2 (testat med en avsiktligt
  ogiltig API-nyckel — bekräftade att 401-fel hanteras korrekt utan att
  fastna eller krascha)
- PDF-extraktion (`unpdf`) mot riktiga flersidiga PDF-filer
- **Inte** verifierat: en riktig, fungerande AI-nyckel end-to-end (testades
  bara med en avsiktligt ogiltig nyckel), produktionsdeploy, `engine`-Workerns
  Cron Trigger i verklig drift
