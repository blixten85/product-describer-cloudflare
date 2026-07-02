// Admin-panel: driftstatistik, kontolista och export. Samma funktioner som
// politiker-webapps admin-vy men mot product-describers domän (katalog, jobb,
// bevakning, underlag). Alla anrop gatas på role='admin' i index.ts.
import type { Env } from "./db";

const DAY_MS = 24 * 3600 * 1000;

interface StatusCount {
  k: string;
  n: number;
}

interface SeriesPoint {
  d: string;
  n: number;
}

function statusMap(rows: StatusCount[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows ?? []) out[r.k] = r.n;
  return out;
}

export async function adminStats(env: Env) {
  const now = Date.now();
  const [accounts, jobs, products, misc, suggestions, renderJobs, descSeries, accountSeries, priceSeries] =
    await env.DB.batch([
      env.DB.prepare(
        "SELECT count(*) total, coalesce(sum(role = 'admin'), 0) admins, coalesce(sum(created_at >= ?1), 0) new_30d FROM accounts",
      ).bind(now - 30 * DAY_MS),
      env.DB.prepare("SELECT status k, count(*) n FROM jobs GROUP BY status"),
      env.DB.prepare(
        "SELECT count(*) total, coalesce(sum(description IS NOT NULL), 0) described, coalesce(sum(source_text IS NOT NULL), 0) with_source FROM products",
      ),
      env.DB.prepare(
        `SELECT (SELECT count(*) FROM price_history) price_points,
                (SELECT count(*) FROM price_watch) watches,
                (SELECT count(*) FROM alert_channels WHERE enabled = 1) channels,
                (SELECT count(*) FROM bistand_items) bistand,
                (SELECT count(*) FROM sites WHERE enabled = 1) sites_enabled,
                (SELECT count(*) FROM sites) sites_total`,
      ),
      env.DB.prepare("SELECT status k, count(*) n FROM page_suggestions GROUP BY status"),
      env.DB.prepare("SELECT status k, count(*) n FROM render_jobs GROUP BY status"),
      // Tidsserier till diagrammen. Tidsstämplar är unix-ms -> /1000 för SQLite.
      env.DB.prepare(
        "SELECT date(description_updated_at / 1000, 'unixepoch') d, count(*) n FROM products WHERE description_updated_at >= ?1 GROUP BY d ORDER BY d",
      ).bind(now - 30 * DAY_MS),
      env.DB.prepare(
        "SELECT date(created_at / 1000, 'unixepoch') d, count(*) n FROM accounts WHERE created_at >= ?1 GROUP BY d ORDER BY d",
      ).bind(now - 30 * DAY_MS),
      env.DB.prepare(
        "SELECT date(ts / 1000, 'unixepoch') d, count(*) n FROM price_history WHERE ts >= ?1 GROUP BY d ORDER BY d",
      ).bind(now - 14 * DAY_MS),
    ]);

  return {
    accounts: accounts.results?.[0] ?? { total: 0, admins: 0, new_30d: 0 },
    jobs: statusMap(jobs.results as StatusCount[]),
    products: products.results?.[0] ?? { total: 0, described: 0, with_source: 0 },
    ...(misc.results?.[0] ?? {}),
    suggestions: statusMap(suggestions.results as StatusCount[]),
    render_jobs: statusMap(renderJobs.results as StatusCount[]),
    series: {
      descriptions_30d: (descSeries.results ?? []) as SeriesPoint[],
      accounts_30d: (accountSeries.results ?? []) as SeriesPoint[],
      price_points_14d: (priceSeries.results ?? []) as SeriesPoint[],
    },
  };
}

export interface AdminAccountRow {
  id: string;
  email: string;
  role: string;
  created_at: number;
  jobs: number;
  watches: number;
  bistand: number;
  suggestions: number;
}

export async function adminAccounts(env: Env): Promise<AdminAccountRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.email, a.role, a.created_at,
            (SELECT count(*) FROM jobs j WHERE j.account_id = a.id) jobs,
            (SELECT count(*) FROM price_watch w WHERE w.account_id = a.id) watches,
            (SELECT count(*) FROM bistand_items b WHERE b.account_id = a.id) bistand,
            (SELECT count(*) FROM page_suggestions s WHERE s.account_id = a.id) suggestions
     FROM accounts a ORDER BY a.created_at DESC LIMIT 500`,
  ).all<AdminAccountRow>();
  return results ?? [];
}

// Rollbyte. Egen nedgradering spärras — annars kan operatören låsa ute sig
// själv ur admin-panelen med ett felklick.
export async function setAccountRole(
  env: Env,
  actingAccountId: string,
  targetId: string,
  role: string,
): Promise<{ ok: boolean; error?: string }> {
  if (role !== "user" && role !== "admin") return { ok: false, error: "Ogiltig roll" };
  if (targetId === actingAccountId && role !== "admin") {
    return { ok: false, error: "Du kan inte ta bort din egen admin-roll" };
  }
  const r = await env.DB.prepare("UPDATE accounts SET role = ?1 WHERE id = ?2").bind(role, targetId).run();
  if (!r.meta.changes) return { ok: false, error: "Kontot finns inte" };
  return { ok: true };
}

function csvEscape(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(fields: string[], rows: Record<string, unknown>[]): string {
  const lines = [fields.map(csvEscape).join(",")];
  for (const row of rows) lines.push(fields.map((f) => csvEscape(row[f])).join(","));
  return lines.join("\r\n") + "\r\n";
}

function exportResponse(name: string, fields: string[], rows: Record<string, unknown>[], format: string): Response {
  if (format === "json") {
    return new Response(JSON.stringify(rows), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${name}.json"`,
      },
    });
  }
  return new Response(toCsv(fields, rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}.csv"`,
    },
  });
}

const EXPORT_CHUNK = 2000;

// Katalog-exporten hämtas i keyset-bitar — ~32k produkter i en enda D1-fråga
// riskerar svarsstorleksgränsen. source_text/description utelämnas medvetet
// (stora blobbar; has_description räcker för analys).
export async function exportProducts(env: Env, format: string): Promise<Response> {
  const fields = ["id", "url", "title", "current_price", "category", "has_description", "first_seen", "last_updated"];
  const rows: Record<string, unknown>[] = [];
  let lastId = 0;
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT id, url, title, current_price, category,
              (description IS NOT NULL) has_description, first_seen, last_updated
       FROM products WHERE id > ?1 ORDER BY id LIMIT ?2`,
    )
      .bind(lastId, EXPORT_CHUNK)
      .all<Record<string, unknown>>();
    const chunk = results ?? [];
    if (chunk.length === 0) break;
    rows.push(...chunk);
    lastId = Number(chunk[chunk.length - 1].id);
    if (chunk.length < EXPORT_CHUNK) break;
  }
  return exportResponse("produkter", fields, rows, format);
}

export async function exportAccounts(env: Env, format: string): Promise<Response> {
  const fields = ["id", "email", "role", "created_at", "jobs", "watches", "bistand", "suggestions"];
  const rows = (await adminAccounts(env)) as unknown as Record<string, unknown>[];
  return exportResponse("konton", fields, rows, format);
}
