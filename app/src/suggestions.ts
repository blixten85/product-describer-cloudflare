// Användar-inskickade sidförslag + admin-godkännandegrind. En användare föreslår
// en sida -> lagras + mail till admin. Admin bedömer; först vid explicit
// godkännande (och efter att koden skrivits) implementeras något. Se minnet
// feedback_email_only_for_user_submissions.
import { randomId } from "../../shared/crypto";
import type { Env } from "./db";
import { sendEmail } from "./mail";

export interface Suggestion {
  id: string;
  email: string | null;
  title: string;
  description: string;
  status: string;
  created_at: number;
}

export async function submitSuggestion(
  env: Env,
  accountId: string,
  accountEmail: string,
  title: string,
  description: string,
): Promise<{ ok: boolean; error?: string }> {
  const t = title.trim();
  if (!t) return { ok: false, error: "Titel krävs" };
  const id = randomId();
  await env.DB.prepare(
    "INSERT INTO page_suggestions (id, account_id, email, title, description, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)",
  )
    .bind(id, accountId, accountEmail, t.slice(0, 200), description.trim().slice(0, 4000), Date.now())
    .run();

  // Notifiera admin (godkännande-grind). Best-effort — förslaget är sparat oavsett.
  const adminEmail = env.ADMIN_EMAIL || "anders.eriksson@denied.se";
  await sendEmail(
    env,
    adminEmail,
    `Nytt sidförslag: ${t.slice(0, 80)}`,
    `En användare (${accountEmail}) har föreslagit en ny sida.\n\n` +
      `Titel: ${t}\n\nBeskrivning:\n${description.trim() || "(ingen)"}\n\n` +
      `Bedöm i admin-vyn innan något implementeras. Förslags-id: ${id}`,
  );
  return { ok: true };
}

export async function listSuggestions(env: Env): Promise<Suggestion[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, email, title, description, status, created_at FROM page_suggestions ORDER BY created_at DESC LIMIT 200",
  ).all<Suggestion>();
  return results ?? [];
}

export async function setSuggestionStatus(env: Env, id: string, status: string): Promise<void> {
  const allowed = new Set(["pending", "coded", "approved", "rejected"]);
  if (!allowed.has(status)) return;
  await env.DB.prepare("UPDATE page_suggestions SET status = ?1 WHERE id = ?2").bind(status, id).run();
}
