// Avd. B — publik katalog. Bläddring/sök återanvänder searchCatalog i bistand.ts;
// här ligger produktdetalj (med prishistorik) och on-demand-beskrivning som
// proxas till engine-Workern (POST /describe) så AI-nyckeln bara finns på ett
// ställe. Beskrivningen cachas i D1 av engine -> nästa visning är gratis.
import type { Env } from "./db";

export interface ProductDetail {
  id: number;
  url: string;
  title: string | null;
  current_price: number | null;
  category: string | null;
  description: string | null;
  description_why: string | null;
  price_history: { price: number; ts: number }[];
}

export async function getProduct(env: Env, id: number): Promise<ProductDetail | null> {
  const p = await env.DB.prepare(
    `SELECT id, url, title, current_price, category, description, description_why
     FROM products WHERE id = ?1`,
  )
    .bind(id)
    .first<Omit<ProductDetail, "price_history">>();
  if (!p) return null;
  const ph = await env.DB.prepare(
    "SELECT price, ts FROM price_history WHERE product_id = ?1 ORDER BY ts DESC LIMIT 30",
  )
    .bind(id)
    .all<{ price: number; ts: number }>();
  return { ...p, price_history: (ph.results ?? []).reverse() };
}

// Beskriv on-demand via engine. Returnerar {beskrivning, varför} eller {error}.
export async function describeViaEngine(
  env: Env,
  id: number,
): Promise<{ beskrivning?: string; varför?: string; error?: string; status: number }> {
  if (!env.ENGINE_URL || !env.INGEST_API_KEY) {
    return { error: "beskrivningstjänst ej konfigurerad", status: 503 };
  }
  try {
    const resp = await fetch(`${env.ENGINE_URL}/describe`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": env.INGEST_API_KEY },
      body: JSON.stringify({ id }),
    });
    const data = (await resp.json().catch(() => ({}))) as { beskrivning?: string; varför?: string; error?: string };
    return { ...data, status: resp.status };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "beskrivning misslyckades", status: 502 };
  }
}
