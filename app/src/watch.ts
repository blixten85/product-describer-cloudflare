// Avd. B — prisbevakning (app-sidan). Kontot bevakar produkter och konfigurerar
// larmkanaler; engine-cronen (checkPriceDrops) sköter detektering + utskick.
import { randomId } from "../../shared/crypto";
import { catalogFilter } from "./bistand";
import type { Env } from "./db";

export interface WatchRow {
  id: number; // product_id
  url: string;
  title: string | null;
  current_price: number | null;
}

export async function listWatches(env: Env, accountId: string): Promise<WatchRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.url, p.title, p.current_price
     FROM price_watch w JOIN products p ON p.id = w.product_id
     WHERE w.account_id = ?1 ORDER BY w.created_at DESC`,
  )
    .bind(accountId)
    .all<WatchRow>();
  return results ?? [];
}

export async function addWatch(env: Env, accountId: string, productId: number): Promise<boolean> {
  const p = await env.DB.prepare("SELECT id FROM products WHERE id = ?1").bind(productId).first();
  if (!p) return false;
  await env.DB.prepare(
    "INSERT INTO price_watch (account_id, product_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING",
  )
    .bind(accountId, productId, Date.now())
    .run();
  return true;
}

export async function removeWatch(env: Env, accountId: string, productId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM price_watch WHERE account_id = ?1 AND product_id = ?2")
    .bind(accountId, productId)
    .run();
}

// Bevaka HELA katalogen (matchande nuvarande filter) på en gång, server-side.
// INSERT ... SELECT; redan bevakade hoppas över. Returnerar antal nya rader.
export async function bulkAddWatch(env: Env, accountId: string, q: string, category: string): Promise<number> {
  const { whereSql, binds } = catalogFilter(q, category);
  const r = await env.DB.prepare(
    `INSERT INTO price_watch (account_id, product_id, created_at)
     SELECT ?, id, ? FROM products${whereSql}
     ON CONFLICT DO NOTHING`,
  )
    .bind(accountId, Date.now(), ...binds)
    .run();
  return r.meta.changes ?? 0;
}

const KINDS = new Set(["ntfy", "slack", "telegram", "webhook"]);
// Kanaler vars target är en URL som servern sedan POST:ar till (engine-cronen).
// Telegram är inte med — dess target är "bottoken:chatid", inte en URL.
const URL_KINDS = new Set(["ntfy", "slack", "webhook"]);

// Best-effort SSRF-spärr: en godtycklig target skulle annars göra larm-utskicket
// till en anonym utgående HTTP-proxy mot interna adresser (molnmetadata,
// RFC1918, loopback). Kräver https och avvisar privata/interna värdar. Skyddar
// inte mot DNS-rebinding, men stänger de uppenbara målen.
function isSafeWebhookUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return false;
  if (h.includes(":")) return false; // IPv6-literal (::1, fc00::, …) — avvisa konservativt
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local + 169.254.169.254 (metadata)
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  }
  return true;
}

export interface ChannelRow {
  id: string;
  kind: string;
  target: string;
  enabled: number;
}

export async function listChannels(env: Env, accountId: string): Promise<ChannelRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, kind, target, enabled FROM alert_channels WHERE account_id = ?1 ORDER BY created_at",
  )
    .bind(accountId)
    .all<ChannelRow>();
  return results ?? [];
}

export async function addChannel(env: Env, accountId: string, kind: string, target: string): Promise<string | null> {
  target = target.trim();
  if (!KINDS.has(kind) || !target) return null;
  if (URL_KINDS.has(kind) && !isSafeWebhookUrl(target)) return null;
  const id = randomId();
  await env.DB.prepare(
    "INSERT INTO alert_channels (id, account_id, kind, target, enabled, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
  )
    .bind(id, accountId, kind, target, Date.now())
    .run();
  return id;
}

export async function removeChannel(env: Env, accountId: string, channelId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM alert_channels WHERE id = ?1 AND account_id = ?2")
    .bind(channelId, accountId)
    .run();
}
