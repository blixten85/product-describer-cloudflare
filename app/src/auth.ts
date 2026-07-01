// Kontohantering — e-post+lösenord, KV-sessioner. Motsvarar auth.py, men
// utan e-postverifiering (fanns inte i Flask-versionen) och utan
// legacy-datamigrering (det var en engångsmigrering för befintliga
// Flask-installationer från innan kontosystemet fanns — ej relevant för en
// helt ny Cloudflare-installation).

import { hashPassword, verifyPassword, randomId } from "../../shared/crypto";
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

// Skapar en session för ett konto-id (delas av lösenordslogin och OAuth-callback).
export async function createSession(env: Env, accountId: string): Promise<string> {
  const sessionToken = randomId() + randomId();
  await env.SESSIONS.put(`session:${sessionToken}`, accountId, { expirationTtl: SESSION_TTL_SECONDS });
  return sessionToken;
}

export async function logout(env: Env, sessionToken: string | null): Promise<void> {
  if (sessionToken) await env.SESSIONS.delete(`session:${sessionToken}`);
}

export async function getAccountFromSession(env: Env, sessionToken: string | null) {
  if (!sessionToken) return null;
  const accountId = await env.SESSIONS.get(`session:${sessionToken}`);
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
