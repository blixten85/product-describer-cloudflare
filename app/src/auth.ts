// Kontohantering — e-post+lösenord, KV-sessioner. Motsvarar auth.py, men
// utan e-postverifiering (fanns inte i Flask-versionen) och utan
// legacy-datamigrering (det var en engångsmigrering för befintliga
// Flask-installationer från innan kontosystemet fanns — ej relevant för en
// helt ny Cloudflare-installation).

import { hashPassword, verifyPassword, randomId, sha256Hex } from "../../shared/crypto";
import { createAccount, getAccountByEmail, getAccountById, type Env } from "./db";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dagar, samma som politiker-webapp

export async function signup(env: Env, email: string, password: string): Promise<{ accountId: string }> {
  email = email.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("Ogiltig e-postadress");
  if (password.length < 8) throw new Error("Lösenordet måste vara minst 8 tecken");

  const existing = await getAccountByEmail(env.DB, email);
  if (existing) throw new Error("E-postadressen är redan registrerad");

  const { hash, salt } = await hashPassword(password);
  const accountId = await createAccount(env.DB, { email, passwordHash: hash, passwordSalt: salt });
  return { accountId };
}

export async function login(env: Env, email: string, password: string): Promise<{ sessionToken: string }> {
  const account = await getAccountByEmail(env.DB, email);
  if (!account) throw new Error("Fel e-post eller lösenord");
  const ok = await verifyPassword(password, account.password_hash, account.password_salt);
  if (!ok) throw new Error("Fel e-post eller lösenord");

  return { sessionToken: await createSession(env, account.id) };
}

// KV-nycklar härleds alltid från en hash av sessionstoken, aldrig token direkt.
// KV:s nyckelgräns är 512 bytes UTF-8 — en rå token/cookie-sträng kan i teorin
// bli godtyckligt lång (klientbugg, manipulerad request) och skulle då krascha
// GET/PUT med "key length limit"-felet. sha256Hex ger alltid en fast 64-tecken
// nyckel oavsett indatans längd. Skriv- (createSession/logout) och läs-sidan
// (getAccountFromSession) MÅSTE använda exakt samma härledning, annars matchar
// nycklarna inte längre.
async function sessionKey(sessionToken: string): Promise<string> {
  return `session:${await sha256Hex(sessionToken)}`;
}

// Skapar en session för ett konto-id (delas av lösenordslogin och OAuth-callback).
export async function createSession(env: Env, accountId: string): Promise<string> {
  const sessionToken = randomId() + randomId();
  await env.SESSIONS.put(await sessionKey(sessionToken), accountId, { expirationTtl: SESSION_TTL_SECONDS });
  return sessionToken;
}

export async function logout(env: Env, sessionToken: string | null): Promise<void> {
  if (sessionToken) await env.SESSIONS.delete(await sessionKey(sessionToken));
}

export async function getAccountFromSession(env: Env, sessionToken: string | null) {
  if (!sessionToken) return null;
  const accountId = await env.SESSIONS.get(await sessionKey(sessionToken));
  if (!accountId) return null;
  return getAccountById(env.DB, accountId);
}

function getSessionTokenFromCookie(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

// Motsvarar @login_required-decoratorn i app.py — varje skyddad route
// anropar denna och returnerar tidigt vid null.
export async function requireAccount(env: Env, request: Request) {
  const token = getSessionTokenFromCookie(request);
  return getAccountFromSession(env, token);
}

// Enkel per-IP-räknare i KV (SESSIONS) mot brute-force på inloggning och
// massregistrering. Inte atomisk — samtidiga anrop kan tappa en inkrement —
// men det räcker för att strypa scriptade attacker. Returnerar true om anropet
// ska tillåtas. TTL:n förnyas vid varje träff (glidande fönster).
export async function allowRateLimited(
  env: Env,
  bucket: string,
  ip: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const key = `rl:${bucket}:${ip}`;
  const current = Number((await env.SESSIONS.get(key)) ?? "0");
  if (current >= limit) return false;
  await env.SESSIONS.put(key, String(current + 1), { expirationTtl: windowSeconds });
  return true;
}
