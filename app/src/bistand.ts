// Fas 5 — bistånds-underlag. Kontot söker i den operatörs-ägda katalogen
// (products i D1), väljer produkter och skriver en egen motivering per produkt
// ("varför just jag behöver detta"). Genererar en utskrivbar sida (skriv ut /
// spara som PDF) att skicka till socialtjänsten.
import type { Account, Env } from "./db";

const CATALOG_LIMIT = 30;

export interface CatalogRow {
  id: number;
  url: string;
  title: string | null;
  current_price: number | null;
  description: string | null;
}

export interface BistandRow extends CatalogRow {
  motivation: string;
}

// Sök i katalogen på titel. Tom sökning -> ett urval (senaste produkterna) så
// listan inte är tom vid start. offset för sidbläddring (katalogvyn).
export async function searchCatalog(env: Env, q: string, offset = 0): Promise<CatalogRow[]> {
  const query = q.trim();
  const off = Math.max(0, offset | 0);
  const stmt = query
    ? env.DB.prepare(
        "SELECT id, url, title, current_price, description FROM products WHERE title LIKE ?1 ORDER BY id LIMIT ?2 OFFSET ?3",
      ).bind(`%${query}%`, CATALOG_LIMIT, off)
    : env.DB.prepare(
        "SELECT id, url, title, current_price, description FROM products ORDER BY id DESC LIMIT ?1 OFFSET ?2",
      ).bind(CATALOG_LIMIT, off);
  const { results } = await stmt.all<CatalogRow>();
  return results ?? [];
}

export async function listBistand(env: Env, accountId: string): Promise<BistandRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.url, p.title, p.current_price, p.description, b.motivation
     FROM bistand_items b JOIN products p ON p.id = b.product_id
     WHERE b.account_id = ?1 ORDER BY b.created_at`,
  )
    .bind(accountId)
    .all<BistandRow>();
  return results ?? [];
}

// Lägg till / uppdatera motivering. Verifierar att produkten finns (FK skulle
// annars ge ett kryptiskt fel) och upsertar per (konto, produkt).
export async function upsertBistand(
  env: Env,
  accountId: string,
  productId: number,
  motivation: string,
): Promise<boolean> {
  const product = await env.DB.prepare("SELECT id FROM products WHERE id = ?1").bind(productId).first();
  if (!product) return false;
  await env.DB.prepare(
    `INSERT INTO bistand_items (account_id, product_id, motivation, created_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(account_id, product_id) DO UPDATE SET motivation = excluded.motivation`,
  )
    .bind(accountId, productId, motivation, Date.now())
    .run();
  return true;
}

export async function removeBistand(env: Env, accountId: string, productId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM bistand_items WHERE account_id = ?1 AND product_id = ?2")
    .bind(accountId, productId)
    .run();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPrice(kr: number | null): string {
  if (kr == null) return "—";
  return `${kr.toLocaleString("sv-SE")} kr`;
}

// Server-renderad utskrivbar sida. Öppnas i ny flik; användaren skriver ut /
// sparar som PDF via webbläsaren. Print-CSS döljer knappar och sätter A4-marginal.
export async function renderUnderlag(env: Env, account: Account): Promise<string> {
  const items = await listBistand(env, account.id);
  const total = items.reduce((sum, r) => sum + (r.current_price ?? 0), 0);
  const date = new Date().toISOString().slice(0, 10);

  const rows = items
    .map(
      (r) => `
    <article class="item">
      <h3>${escapeHtml(r.title ?? "(namnlös produkt)")}</h3>
      <table class="meta">
        <tr><th>Pris</th><td>${formatPrice(r.current_price)}</td></tr>
        <tr><th>Länk</th><td><a href="${escapeHtml(r.url)}">${escapeHtml(r.url)}</a></td></tr>
      </table>
      ${r.description ? `<p class="beskrivning">${escapeHtml(r.description)}</p>` : ""}
      <div class="motivering">
        <strong>Motivering — varför jag behöver detta:</strong>
        <p>${r.motivation ? escapeHtml(r.motivation) : "<em>(ingen motivering angiven)</em>"}</p>
      </div>
    </article>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Underlag till socialtjänsten</title>
<style>
  /* Mörkt tema på skärm (matchar sajten); ljust dokument vid utskrift. */
  * { box-sizing: border-box; }
  body { font-family: Georgia, "Times New Roman", serif; background: #0c0e14; color: #e4e2dc; max-width: 820px; margin: 0 auto; padding: 2rem; line-height: 1.5; }
  header { border-bottom: 2px solid #f0a500; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  .sub { color: #9aa0aa; margin: 0; }
  .item { border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 1rem 1.25rem; margin-bottom: 1rem; background: #13161f; page-break-inside: avoid; }
  .item h3 { margin: 0 0 .5rem; font-size: 1.15rem; }
  table.meta { border-collapse: collapse; margin: 0 0 .5rem; }
  table.meta th { text-align: left; padding: .1rem .75rem .1rem 0; color: #9aa0aa; font-weight: normal; vertical-align: top; white-space: nowrap; }
  table.meta a { color: #f0a500; word-break: break-all; }
  .beskrivning { margin: .5rem 0; color: #c9c7c1; }
  .motivering { margin-top: .75rem; padding-top: .5rem; border-top: 1px dashed rgba(255,255,255,0.2); }
  .motivering p { margin: .25rem 0 0; }
  .summary { margin-top: 1.5rem; font-size: 1.1rem; }
  .toolbar { margin-bottom: 1.5rem; }
  .toolbar button, .toolbar a { font-family: system-ui, sans-serif; font-size: .95rem; padding: .5rem 1rem; margin-right: .5rem; border: 1px solid rgba(255,255,255,0.2); border-radius: 5px; background: #13161f; color: #e4e2dc; text-decoration: none; cursor: pointer; }
  .empty { color: #6b7280; font-style: italic; }
  @media print {
    /* Rent dokument för socialtjänsten: vitt papper, svart text. */
    body { background: #fff; color: #111; padding: 0; max-width: none; }
    header { border-bottom-color: #111; }
    .sub { color: #444; }
    .item { border-color: #ccc; background: #fff; }
    table.meta th { color: #555; }
    table.meta a { color: #0a58ca; }
    .beskrivning { color: #333; }
    .motivering { border-top-color: #bbb; }
    .toolbar { display: none; }
    a { color: #111; text-decoration: none; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">Skriv ut / spara som PDF</button>
    <a href="/">← Tillbaka</a>
  </div>
  <header>
    <h1>Underlag till socialtjänsten</h1>
    <p class="sub">Produkter med motivering — sammanställt ${escapeHtml(date)} av ${escapeHtml(account.email)}</p>
  </header>
  ${items.length ? rows : '<p class="empty">Inga produkter tillagda ännu.</p>'}
  ${items.length ? `<p class="summary"><strong>Summa:</strong> ${formatPrice(total)} (${items.length} produkter)</p>` : ""}
</body>
</html>`;
}
