// product-describer-engine — Fas 1 av den enhetliga arkitekturen (se DESIGN.md).
//
// Cloudflare blir sanningskälla; servern krymps till en statslös Playwright-
// fetcher som BARA gör utgående HTTPS. Den här Workern exponerar de endpoints
// fetchern behöver:
//
//   POST /jobs/lease        — leasa N render-jobb (lease/ack, ersätter Queues)
//   POST /jobs/:id/result   — rapportera resultat: upsert produkt + prishistorik,
//                             list-jobb skapar detail-jobb för upptäckta länkar
//   POST /ingest            — bulk-upsert produkter (migrering + list-resultat)
//   GET  /health            — opfri hälsokoll
//
// Auth: X-API-Key mot secret INGEST_API_KEY (operatörsnyckel), samma mönster
// som dagens scraper-API. Inget per konto — katalogen är operatörs-ägd.

interface Env {
  DB: D1Database;
  INGEST_API_KEY: string;
}

const LEASE_MS = 120_000; // hur länge ett leasat jobb är "ägt" innan det kan återtas
const MAX_ATTEMPTS = 5; // efter så många misslyckanden -> status='error'
const MAX_LEASE = 50; // tak per lease-anrop

interface LeasedJob {
  id: number;
  url: string;
  type: string;
  site_id: number | null;
  detail_selector: string;
  use_stealth: number;
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
  // Leasbar = pending, eller leased vars lease gått ut (självläkande).
  const leased = await env.DB.prepare(
    `UPDATE render_jobs
       SET status = 'leased', lease_until = ?1, attempts = attempts + 1, updated_at = ?1
     WHERE id IN (
       SELECT id FROM render_jobs
       WHERE status = 'pending' OR (status = 'leased' AND lease_until < ?2)
       ORDER BY id LIMIT ?3
     )
     RETURNING id, url, type, site_id`,
  )
    .bind(now + LEASE_MS, now, n)
    .all<{ id: number; url: string; type: string; site_id: number | null }>();

  const rows = leased.results ?? [];
  if (rows.length === 0) return json({ jobs: [] });

  // Berika med per-sajt-inställningar (detail_selector, use_stealth). Få sajter
  // -> hämta alla och slå upp i minnet.
  const sites = await env.DB.prepare(
    "SELECT id, detail_selector, use_stealth FROM sites",
  ).all<{ id: number; detail_selector: string; use_stealth: number }>();
  const siteMap = new Map((sites.results ?? []).map((s) => [s.id, s]));

  const jobs: LeasedJob[] = rows.map((r) => {
    const site = r.site_id != null ? siteMap.get(r.site_id) : undefined;
    return {
      id: r.id,
      url: r.url,
      type: r.type,
      site_id: r.site_id,
      detail_selector: site?.detail_selector ?? "",
      use_stealth: site?.use_stealth ?? 0,
    };
  });
  return json({ jobs });
}

interface ResultBody {
  error?: string;
  title?: string;
  price?: number;
  source_text?: string;
  category?: string;
  links?: string[]; // för list-jobb: upptäckta produkt-URL:er
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

  // List-jobb: skapa produkt-stubbar + detail-jobb för nya länkar (idempotent).
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

  // Markera jobbet klart.
  stmts.push(
    env.DB.prepare("UPDATE render_jobs SET status = 'done', updated_at = ?1 WHERE id = ?2").bind(now, id),
  );

  await env.DB.batch(stmts);
  return json({ ok: true, created_detail_jobs: body.links?.length ?? 0 });
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") return json({ ok: true });

    if (!authorized(req, env)) return json({ error: "obehörig" }, 401);

    try {
      if (req.method === "POST" && path === "/jobs/lease") return await leaseJobs(req, env);
      if (req.method === "POST" && path === "/ingest") return await ingest(req, env);

      const m = path.match(/^\/jobs\/(\d+)\/result$/);
      if (req.method === "POST" && m) return await reportResult(Number(m[1]), req, env);

      return json({ error: "okänd route" }, 404);
    } catch (err) {
      return json({ error: String(err instanceof Error ? err.message : err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
