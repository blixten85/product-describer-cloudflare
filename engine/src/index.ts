// (auto-deploy-verifiering 2026-07-01)
// product-describer-engine — hjärnan i den enhetliga arkitekturen (se DESIGN.md).
//
// Cloudflare blir sanningskälla; servern krymps till en statslös Playwright-
// fetcher som BARA gör utgående HTTPS. Den här Workern gör två saker:
//
//  A) HTTP-endpoints som fetchern anropar (Fas 1).
//  B) EN cron-handler (Fas 4) som driver hela katalog-loopen mot D1.
//
// Endpoints fetchern behöver:
//
//   POST /jobs/lease        — leasa N render-jobb (lease/ack, ersätter Queues)
//   POST /jobs/:id/result   — rapportera resultat: upsert produkt + prishistorik,
//                             list-jobb skapar detail-jobb för upptäckta länkar
//   POST /ingest            — bulk-upsert produkter (migrering + list-resultat)
//   GET  /health            — opfri hälsokoll
//
// Auth: X-API-Key mot secret INGEST_API_KEY (operatörsnyckel), samma mönster
// som dagens scraper-API. Inget per konto — katalogen är operatörs-ägd.

import {
  ProviderChain,
  AllProvidersExhausted,
  DEFAULT_MODELS,
  type ProviderSpec,
  type ProviderName,
} from "../../shared/providers";
import { buildSystemPrompt, userMessage } from "../../shared/prompts";
import { reportErrorToGitHub, type GitHubReportEnv } from "../../shared/github-report";

interface Env extends GitHubReportEnv {
  DB: D1Database;
  INGEST_API_KEY: string;
  // AI-leverantörer (Wrangler secrets) — samma som sync-Workern. Operatörens
  // egna nycklar, inte kontobaserat.
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  AZURE_OPENAI_API_KEY?: string;
  AZURE_OPENAI_ENDPOINT?: string;
  AZURE_OPENAI_DEPLOYMENT?: string;
  // Cron-tak per tick (vars i wrangler.jsonc).
  SCHEDULE_LIMIT?: string; // max detail-jobb att skapa per tick (default 200)
  DESCRIBE_LIMIT?: string; // max produkter att beskriva per tick (default 10)
  DESCRIBE_WORKERS?: string; // parallella AI-anrop (default 2)
}

const REPO = "blixten85/product-describer-cloudflare";

const LEASE_MS = 120_000; // detail-jobb: kort lease (snabba)
const LIST_LEASE_MS = 900_000; // list-jobb (crawl): lång lease, kan ta många minuter
const MAX_ATTEMPTS = 5; // efter så många misslyckanden -> status='error'
const MAX_LEASE = 50; // tak per lease-anrop

interface LeasedJob {
  id: number;
  url: string;
  type: string;
  site_id: number | null;
  detail_selector: string;
  use_stealth: number;
  // Endast för list-jobb (crawl av listningssida).
  base_url?: string;
  product_selector?: string;
  title_selector?: string;
  price_selector?: string;
  link_selector?: string;
  pagination_type?: string;
  max_pages?: number;
  exclude_link_pattern?: string;
  url_scope?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function authorized(req: Request, env: Env): boolean {
  const key = req.headers.get("X-API-Key");
  return !!env.INGEST_API_KEY && key === env.INGEST_API_KEY;
}

// POST /jobs/lease  { n?: number }
async function leaseJobs(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { n?: number };
  const n = Math.min(Math.max(1, body.n ?? 10), MAX_LEASE);
  const now = Date.now();

  // Atomiskt: markera de N äldsta leasbara jobben som leased och returnera dem.
  // Leasbar = pending, eller leased vars lease gått ut (självläkande). List-jobb
  // (crawl) får längre lease då de kan ta många minuter.
  const leased = await env.DB.prepare(
    `UPDATE render_jobs
       SET status = 'leased',
           lease_until = ?1 + CASE type WHEN 'list' THEN ?4 ELSE ?5 END,
           attempts = attempts + 1, updated_at = ?1
     WHERE id IN (
       SELECT id FROM render_jobs
       WHERE status = 'pending' OR (status = 'leased' AND lease_until < ?2)
       -- List-jobb (crawl) prioriteras: de är få och tidskänsliga (färska priser/
       -- upptäckt) och ska inte svältas bakom en lång detail-backlog.
       ORDER BY CASE type WHEN 'list' THEN 0 ELSE 1 END, id LIMIT ?3
     )
     RETURNING id, url, type, site_id`,
  )
    .bind(now, now, n, LIST_LEASE_MS, LEASE_MS)
    .all<{ id: number; url: string; type: string; site_id: number | null }>();

  const rows = leased.results ?? [];
  if (rows.length === 0) return json({ jobs: [] });

  // Berika med per-sajt-inställningar. Få sajter -> hämta alla och slå upp i
  // minnet. Detail-jobb behöver detail_selector/use_stealth; list-jobb behöver
  // dessutom hela crawl-konfigen (list-selektorer + paginering).
  const sites = await env.DB.prepare(
    `SELECT id, base_url, detail_selector, product_selector, title_selector, price_selector,
            link_selector, pagination_type, max_pages, exclude_link_pattern, url_scope, use_stealth
     FROM sites`,
  ).all<{
    id: number;
    base_url: string;
    detail_selector: string;
    product_selector: string;
    title_selector: string;
    price_selector: string;
    link_selector: string;
    pagination_type: string;
    max_pages: number;
    exclude_link_pattern: string;
    url_scope: string;
    use_stealth: number;
  }>();
  const siteMap = new Map((sites.results ?? []).map((s) => [s.id, s]));

  const jobs: LeasedJob[] = rows.map((r) => {
    const site = r.site_id != null ? siteMap.get(r.site_id) : undefined;
    const base: LeasedJob = {
      id: r.id,
      url: r.url,
      type: r.type,
      site_id: r.site_id,
      detail_selector: site?.detail_selector ?? "",
      use_stealth: site?.use_stealth ?? 0,
    };
    if (r.type === "list" && site) {
      base.base_url = site.base_url;
      base.product_selector = site.product_selector;
      base.title_selector = site.title_selector;
      base.price_selector = site.price_selector;
      base.link_selector = site.link_selector;
      base.pagination_type = site.pagination_type;
      base.max_pages = site.max_pages;
      base.exclude_link_pattern = site.exclude_link_pattern;
      base.url_scope = site.url_scope;
    }
    return base;
  });
  return json({ jobs });
}

interface ResultBody {
  error?: string;
  title?: string;
  price?: number;
  source_text?: string;
  category?: string;
  links?: string[]; // för list-jobb: upptäckta produkt-URL:er (bakåtkompat)
  items?: { url: string; title?: string; price?: number; category?: string }[]; // list-jobb: strukturerat
}

// POST /jobs/:id/result
async function reportResult(id: number, req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as ResultBody;
  const now = Date.now();

  const job = await env.DB.prepare(
    "SELECT id, url, type, site_id, attempts FROM render_jobs WHERE id = ?1",
  )
    .bind(id)
    .first<{ id: number; url: string; type: string; site_id: number | null; attempts: number }>();
  if (!job) return json({ error: "okänt jobb" }, 404);

  // Misslyckande: försök igen tills MAX_ATTEMPTS, sedan parkera som 'error'.
  if (body.error) {
    const dead = job.attempts >= MAX_ATTEMPTS;
    await env.DB.prepare(
      "UPDATE render_jobs SET status = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4",
    )
      .bind(dead ? "error" : "pending", body.error.slice(0, 500), now, id)
      .run();
    return json({ ok: true, retried: !dead });
  }

  const stmts: D1PreparedStatement[] = [];

  // Upsert av produkten som jobbet gäller (matchas på url).
  if (body.title != null || body.price != null || body.source_text != null || body.category != null) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO products (url, site_id, title, current_price, source_text, category, source_text_updated_at, first_seen, last_updated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(url) DO UPDATE SET
           title = COALESCE(excluded.title, products.title),
           current_price = COALESCE(excluded.current_price, products.current_price),
           source_text = COALESCE(excluded.source_text, products.source_text),
           category = COALESCE(excluded.category, products.category),
           source_text_updated_at = CASE WHEN excluded.source_text IS NOT NULL
             THEN excluded.source_text_updated_at ELSE products.source_text_updated_at END,
           last_updated = excluded.last_updated`,
      ).bind(
        job.url,
        job.site_id,
        body.title ?? null,
        body.price ?? null,
        body.source_text ?? null,
        body.category ?? null,
        body.source_text != null ? now : null,
        now,
      ),
    );
  }

  // Prishistorik (kopplas till produktens id via url).
  if (body.price != null) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO price_history (product_id, price, ts) SELECT id, ?1, ?2 FROM products WHERE url = ?3",
      ).bind(body.price, now, job.url),
    );
  }

  // List-jobb (bakåtkompat): bara URL:er -> produkt-stubbar + detail-jobb.
  for (const link of body.links ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO products (url, site_id, first_seen, last_updated) VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(url) DO NOTHING`,
      ).bind(link, job.site_id, now),
    );
    stmts.push(
      env.DB.prepare(
        `INSERT INTO render_jobs (url, site_id, type, created_at, updated_at)
         SELECT ?1, ?2, 'detail', ?3, ?3
         WHERE NOT EXISTS (
           SELECT 1 FROM render_jobs WHERE url = ?1 AND type = 'detail' AND status IN ('pending','leased')
         )`,
      ).bind(link, job.site_id, now),
    );
  }

  // List-jobb (strukturerat): varje item bär url + titel/pris från listkortet.
  // Upserta produkten, spara prishistorik (dedupas mot senaste priset), och
  // skapa ett detail-jobb bara om produkten ännu saknar source_text — så
  // prisuppdateringar sker via list-crawl utan att re-rendera varje produktsida.
  for (const item of body.items ?? []) {
    if (!item.url) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO products (url, site_id, title, current_price, category, first_seen, last_updated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(url) DO UPDATE SET
           title = COALESCE(excluded.title, products.title),
           current_price = COALESCE(excluded.current_price, products.current_price),
           category = COALESCE(excluded.category, products.category),
           last_updated = excluded.last_updated`,
      ).bind(item.url, job.site_id, item.title ?? null, item.price ?? null, item.category ?? null, now),
    );
    if (item.price != null) {
      // Bara om priset skiljer sig från senast noterade (undviker att skriva en
      // rad per crawl när priset är oförändrat).
      stmts.push(
        env.DB.prepare(
          `INSERT INTO price_history (product_id, price, ts)
           SELECT p.id, ?1, ?2 FROM products p
           WHERE p.url = ?3 AND NOT EXISTS (
             SELECT 1 FROM price_history ph WHERE ph.product_id = p.id
               AND ph.price = ?1
               AND ph.ts = (SELECT MAX(ts) FROM price_history ph2 WHERE ph2.product_id = p.id)
           )`,
        ).bind(item.price, now, item.url),
      );
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO render_jobs (url, site_id, type, created_at, updated_at)
         SELECT ?1, ?2, 'detail', ?3, ?3
         WHERE EXISTS (SELECT 1 FROM products WHERE url = ?1 AND source_text IS NULL)
           AND NOT EXISTS (
             SELECT 1 FROM render_jobs WHERE url = ?1 AND type = 'detail' AND status IN ('pending','leased')
           )`,
      ).bind(item.url, job.site_id, now),
    );
  }

  // Markera jobbet klart.
  stmts.push(
    env.DB.prepare("UPDATE render_jobs SET status = 'done', updated_at = ?1 WHERE id = ?2").bind(now, id),
  );

  await env.DB.batch(stmts);
  return json({ ok: true, links: body.links?.length ?? 0, items: body.items?.length ?? 0 });
}

interface IngestBody {
  products?: { url: string; title?: string; price?: number; site_id?: number; source_text?: string }[];
}

// POST /ingest — bulk-upsert (migrering postgres->D1, samt list-resultat).
async function ingest(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as IngestBody;
  const items = body.products ?? [];
  if (items.length === 0) return json({ upserted: 0 });
  const now = Date.now();

  const stmts = items
    .filter((p) => p.url)
    .map((p) =>
      env.DB.prepare(
        `INSERT INTO products (url, site_id, title, current_price, source_text, source_text_updated_at, first_seen, last_updated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(url) DO UPDATE SET
           title = COALESCE(excluded.title, products.title),
           current_price = COALESCE(excluded.current_price, products.current_price),
           source_text = COALESCE(excluded.source_text, products.source_text),
           source_text_updated_at = CASE WHEN excluded.source_text IS NOT NULL
             THEN excluded.source_text_updated_at ELSE products.source_text_updated_at END,
           last_updated = excluded.last_updated`,
      ).bind(
        p.url,
        p.site_id ?? null,
        p.title ?? null,
        p.price ?? null,
        p.source_text ?? null,
        p.source_text != null ? now : null,
        now,
      ),
    );

  await env.DB.batch(stmts);
  return json({ upserted: stmts.length });
}

// ── Cron-handlerns hjälpfunktioner ──────────────────────────────────────────

// Bygger leverantörskedjan ur miljövariabler — samma som sync-Workern.
function buildChainFromEnv(env: Env): ProviderChain | null {
  const specs: ProviderSpec[] = [];
  const keys: Record<ProviderName, string | undefined> = {
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    gemini: env.GEMINI_API_KEY,
    azure_openai: env.AZURE_OPENAI_API_KEY,
  };
  for (const [name, apiKey] of Object.entries(keys) as [ProviderName, string | undefined][]) {
    if (!apiKey) continue;
    if (name === "azure_openai") {
      if (!env.AZURE_OPENAI_ENDPOINT || !env.AZURE_OPENAI_DEPLOYMENT) continue;
      specs.push({
        provider: name,
        creds: { apiKey, endpoint: env.AZURE_OPENAI_ENDPOINT, deployment: env.AZURE_OPENAI_DEPLOYMENT },
        model: env.AZURE_OPENAI_DEPLOYMENT,
      });
      continue;
    }
    specs.push({ provider: name, creds: { apiKey }, model: DEFAULT_MODELS[name][0] });
  }
  return specs.length > 0 ? new ProviderChain(specs) : null;
}

// 1. Utgångna leases -> pending (självläkande om fetchern dog mitt i ett jobb).
async function reclaimLeases(env: Env, now: number): Promise<number> {
  const r = await env.DB.prepare(
    "UPDATE render_jobs SET status='pending', updated_at=?1 WHERE status='leased' AND lease_until < ?1",
  )
    .bind(now)
    .run();
  return r.meta.changes ?? 0;
}

// 2. Skapa detail-jobb för produkter som saknar source_text och inte redan har
//    ett aktivt jobb. Cappat per tick.
async function scheduleDetailJobs(env: Env, now: number, limit: number): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO render_jobs (url, site_id, type, status, created_at, updated_at)
     SELECT p.url, p.site_id, 'detail', 'pending', ?1, ?1 FROM products p
     WHERE p.source_text IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM render_jobs rj
         WHERE rj.url = p.url AND rj.type = 'detail' AND rj.status IN ('pending','leased')
       )
     LIMIT ?2`,
  )
    .bind(now, limit)
    .run();
  return r.meta.changes ?? 0;
}

// 2b. Schemalägg crawl (list-jobb) för sajter vars intervall löpt ut. En list-
//     jobb per due sajt; hoppar sajter som redan har ett aktivt list-jobb.
//     Sätter last_crawled direkt så nästa tick inte dubblar innan jobbet körts.
async function scheduleDueCrawls(env: Env, now: number): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT id, base_url FROM sites
     WHERE enabled = 1
       AND (last_crawled IS NULL OR last_crawled + scrape_interval * 1000 < ?1)
       AND NOT EXISTS (
         SELECT 1 FROM render_jobs rj
         WHERE rj.site_id = sites.id AND rj.type = 'list' AND rj.status IN ('pending','leased')
       )`,
  )
    .bind(now)
    .all<{ id: number; base_url: string }>();
  const sites = due.results ?? [];
  if (sites.length === 0) return 0;

  const stmts = sites.flatMap((s) => [
    env.DB.prepare(
      `INSERT INTO render_jobs (url, site_id, type, status, created_at, updated_at)
       VALUES (?1, ?2, 'list', 'pending', ?3, ?3)`,
    ).bind(s.base_url, s.id, now),
    env.DB.prepare("UPDATE sites SET last_crawled = ?1 WHERE id = ?2").bind(now, s.id),
  ]);
  await env.DB.batch(stmts);
  return sites.length;
}

// On-demand-beskrivning (POST /describe). Katalogen har ~32k produkter; att
// förbeskriva alla ryms inte i gratis-Geminis kvot. I stället beskrivs en
// produkt först när den faktiskt visas/väljs (app-Workern anropar hit) och
// cachas i D1. Redan cachad -> returneras direkt utan API-anrop.
interface ProductRow {
  id: number;
  title: string | null;
  category: string | null;
  source_text: string | null;
  description: string | null;
  description_why: string | null;
}

async function describeProduct(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { url?: string; id?: number; refresh?: boolean };
  const where = body.url != null ? "url = ?1" : "id = ?1";
  const key = body.url ?? body.id;
  if (key == null) return json({ error: "url eller id krävs" }, 400);

  const p = await env.DB.prepare(
    `SELECT id, title, category, source_text, description, description_why FROM products WHERE ${where}`,
  )
    .bind(key)
    .first<ProductRow>();
  if (!p) return json({ error: "produkt finns inte" }, 404);

  // Cache-träff: returnera direkt (om inte refresh begärs).
  if (p.description && !body.refresh) {
    return json({ beskrivning: p.description, varför: p.description_why ?? "", cached: true });
  }

  const chain = buildChainFromEnv(env);
  if (!chain) return json({ error: "ingen AI-leverantör konfigurerad" }, 503);

  let parts: { beskrivning: string; varför: string };
  try {
    parts = await chain.generate(
      buildSystemPrompt(),
      userMessage("", p.title ?? "", "", p.category ?? "", p.source_text ?? ""),
    );
  } catch (err) {
    if (err instanceof AllProvidersExhausted) return json({ error: "AI-kvot tillfälligt slut, försök snart igen" }, 429);
    return json({ error: err instanceof Error ? err.message : "beskrivning misslyckades" }, 502);
  }
  if (!parts.beskrivning) return json({ error: "tomt svar från AI" }, 502);

  await env.DB.prepare(
    "UPDATE products SET description=?1, description_why=?2, description_updated_at=?3 WHERE id=?4",
  )
    .bind(parts.beskrivning, parts.varför, Date.now(), p.id)
    .run();
  return json({ beskrivning: parts.beskrivning, varför: parts.varför, cached: false });
}

export default {
  // EN cron-trigger (*/5), EN handler som gör allt sekventiellt och cappat per
  // tick (DESIGN.md §4.4). Inga flera cronjobb att koordinera.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    try {
      // Beskrivning sker INTE här längre — den är on-demand (POST /describe),
      // eftersom gratis-Geminis kvot inte räcker för att förbeskriva ~32k
      // produkter. Cronen sköter bara crawl/discovery + source_text-jobb.
      const reclaimed = await reclaimLeases(env, now);
      const crawls = await scheduleDueCrawls(env, now);
      const scheduled = await scheduleDetailJobs(env, now, Number(env.SCHEDULE_LIMIT) || 200);
      console.log(`cron: reclaimed=${reclaimed} crawls=${crawls} scheduled=${scheduled}`);
    } catch (err) {
      console.error("cron misslyckades:", err);
      await reportErrorToGitHub(REPO, "Engine cron misslyckades", err, env);
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") return json({ ok: true });

    if (!authorized(req, env)) return json({ error: "obehörig" }, 401);

    try {
      if (req.method === "POST" && path === "/jobs/lease") return await leaseJobs(req, env);
      if (req.method === "POST" && path === "/ingest") return await ingest(req, env);
      if (req.method === "POST" && path === "/describe") return await describeProduct(req, env);

      const m = path.match(/^\/jobs\/(\d+)\/result$/);
      if (req.method === "POST" && m) return await reportResult(Number(m[1]), req, env);

      return json({ error: "okänd route" }, 404);
    } catch (err) {
      return json({ error: String(err instanceof Error ? err.message : err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
