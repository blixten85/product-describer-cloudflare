// Avd. B — publik katalog. Bläddring/sök återanvänder searchCatalog i bistand.ts;
// här ligger produktdetalj (med prishistorik) och on-demand-beskrivning som
// proxas till engine-Workern (POST /describe) så AI-nyckeln bara finns på ett
// ställe. Beskrivningen cachas i D1 av engine -> nästa visning är gratis.
import type { Env } from "./db";
import { buildChain } from "../../shared/provider-config";
import { buildSystemPrompt, userMessage } from "../../shared/prompts";
import { AllProvidersExhausted } from "../../shared/providers";

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

interface DescribeResult {
  beskrivning?: string;
  varför?: string;
  error?: string;
  status: number;
}

// Beskriv on-demand. Använder KONTOTS egen provider-nyckel om konfigurerad (så
// operatören inte betalar för andras användning — samma princip som CSV-verktyget),
// annars proxas till engine (operatörens delade Gemini-nyckel, gratis-tier).
// Resultatet cachas i products.description (delad katalog) -> nästa läsning gratis.
export async function describeProduct(env: Env, accountId: string, id: number): Promise<DescribeResult> {
  const p = await env.DB.prepare(
    "SELECT id, title, category, source_text, description, description_why FROM products WHERE id = ?1",
  )
    .bind(id)
    .first<ProductRow>();
  if (!p) return { error: "produkt finns inte", status: 404 };
  if (p.description) return { beskrivning: p.description, varför: p.description_why ?? "", status: 200 };

  const chain = await buildChain(env, accountId);
  if (!chain) return describeViaEngine(env, id); // inget eget nyckel -> operatörens engine

  try {
    const parts = await chain.generate(
      buildSystemPrompt(),
      userMessage("", p.title ?? "", "", p.category ?? "", p.source_text ?? ""),
    );
    if (!parts.beskrivning) return { error: "tomt svar från AI", status: 502 };
    await env.DB.prepare(
      "UPDATE products SET description=?1, description_why=?2, description_updated_at=?3 WHERE id=?4",
    )
      .bind(parts.beskrivning, parts.varför, Date.now(), id)
      .run();
    return { beskrivning: parts.beskrivning, varför: parts.varför, status: 200 };
  } catch (err) {
    if (err instanceof AllProvidersExhausted) return { error: "Din AI-kvot är slut, försök snart igen", status: 429 };
    return { error: err instanceof Error ? err.message : "beskrivning misslyckades", status: 502 };
  }
}

interface ProductRow {
  id: number;
  title: string | null;
  category: string | null;
  source_text: string | null;
  description: string | null;
  description_why: string | null;
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
