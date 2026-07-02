// Utgående mail via Resend (noreply@send.denied.se). Enda mail-vägen i appen.
import type { Env } from "./db";

export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const from = env.MAIL_FROM || "noreply@send.denied.se";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
