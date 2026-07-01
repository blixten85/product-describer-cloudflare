// Motsvarar app.py:s Flask-rutter. Jobbkörningen själv (extraktion +
// radvis beskrivningsgenerering) sker INTE här — den här Workern bara
// validerar, sparar till R2/D1 och lägger ett "extract"-meddelande i kön;
// processor-Workern (../processor/src/index.ts) gör det faktiska arbetet.

import { signup, login, logout, requireAccount, createSession } from "./auth";
import { getAuthorizeUrl, handleOAuthCallback, isKnownProvider } from "./oauth";
import { createJob, getJobsForAccount, getJob, type Env, type JobMessage } from "./db";
import { searchCatalog, listBistand, upsertBistand, removeBistand, renderUnderlag } from "./bistand";
import { getProduct, describeProduct } from "./catalog";
import { listWatches, addWatch, removeWatch, listChannels, addChannel, removeChannel } from "./watch";
import {
  configuredProviders,
  getProviderConfig,
  setProviderConfig,
  removeProviderConfig,
  getOrder,
  setOrder,
  DEFAULT_MODELS,
  EXTRA_FIELDS,
  PROVIDER_NAMES,
  type ProviderName,
} from "../../shared/provider-config";

const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "Claude (Anthropic)",
  openai: "ChatGPT (OpenAI)",
  gemini: "Gemini (Google)",
  azure_openai: "Azure OpenAI Service",
};

const SUPPORTED_EXTENSIONS = [".csv", ".xlsx", ".txt", ".docx", ".pdf"];
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB, samma gräns som Flask-versionen

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      return await route(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: err instanceof Error ? err.message : "Ett internt fel uppstod" }, 500);
    }
  },
};

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;

  if (pathname === "/signup" && request.method === "POST") return handleSignup(request, env);
  if (pathname === "/login" && request.method === "POST") return handleLogin(request, env);
  if (pathname === "/logout" && request.method === "POST") return handleLogout(request, env);

  // OAuth-inloggning (publik — sker före inloggning).
  const oauthStart = pathname.match(/^\/api\/oauth\/([a-z]+)$/);
  if (oauthStart && request.method === "GET") return handleOAuthStart(oauthStart[1], env);
  const oauthCb = pathname.match(/^\/api\/oauth\/([a-z]+)\/callback$/);
  if (oauthCb && request.method === "GET") return handleOAuthCallbackRoute(oauthCb[1], request, env, url);

  // Allt annat under /api/* (och /underlag) kräver inloggning.
  const account = await requireAccount(env, request);
  if (!account) return json({ error: "Inte inloggad" }, 401);

  // Utskrivbart bistånds-underlag (server-renderad HTML, öppnas i ny flik).
  if (pathname === "/underlag" && request.method === "GET") {
    return new Response(await renderUnderlag(env, account), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Operatörsverktygen (beskriv-verktyget: provider-nycklar, uppladdning, jobb)
  // är admin-only nu när appen är publik. Katalog/underlag/bevakning är öppna
  // för alla inloggade.
  if (/^\/api\/(settings|upload|jobs)(\/|$)/.test(pathname) && account.role !== "admin") {
    return json({ error: "Endast administratör" }, 403);
  }

  if (pathname === "/api/status" && request.method === "GET") return handleStatus(env, account);
  if (pathname === "/api/settings" && request.method === "GET") return handleGetSettings(env, account.id);
  if (pathname === "/api/settings/key" && request.method === "POST") return handleSetKey(request, env, account.id);
  if (pathname.startsWith("/api/settings/key/") && request.method === "DELETE") {
    return handleDeleteKey(env, account.id, pathname.slice("/api/settings/key/".length));
  }
  if (pathname === "/api/settings/order" && request.method === "POST") return handleSetOrder(request, env, account.id);
  if (pathname === "/api/upload" && request.method === "POST") return handleUpload(request, env, account.id);
  if (pathname === "/api/jobs" && request.method === "GET") return handleListJobs(env, account.id);

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)(\/download)?$/);
  if (jobMatch && request.method === "GET") {
    return jobMatch[2] ? handleDownloadJob(env, account.id, jobMatch[1]) : handleGetJob(env, account.id, jobMatch[1]);
  }

  // Bistånds-underlag: katalog-sök + kontots valda produkter med motivering.
  if (pathname === "/api/catalog" && request.method === "GET") {
    return json(await searchCatalog(env, url.searchParams.get("q") ?? "", Number(url.searchParams.get("offset")) || 0));
  }
  const prodMatch = pathname.match(/^\/api\/produkt\/(\d+)$/);
  if (prodMatch && request.method === "GET") {
    const p = await getProduct(env, Number(prodMatch[1]));
    return p ? json(p) : json({ error: "Produkten finns inte" }, 404);
  }
  const descMatch = pathname.match(/^\/api\/produkt\/(\d+)\/describe$/);
  if (descMatch && request.method === "POST") {
    const { status, ...body } = await describeProduct(env, account.id, Number(descMatch[1]));
    return json(body, status);
  }
  if (pathname === "/api/describe-mode" && request.method === "POST") {
    const data = await request.json<{ mode?: string }>().catch(() => ({}) as { mode?: string });
    const mode = data.mode === "auto" ? "auto" : "on-demand";
    await env.DB.prepare("UPDATE accounts SET describe_mode = ?1 WHERE id = ?2").bind(mode, account.id).run();
    return json({ ok: true, describe_mode: mode });
  }

  // Prisbevakning + larmkanaler.
  if (pathname === "/api/watch" && request.method === "GET") return json(await listWatches(env, account.id));
  if (pathname === "/api/watch" && request.method === "POST") {
    const data = await request.json<{ product_id?: number }>().catch(() => ({}) as { product_id?: number });
    const ok = await addWatch(env, account.id, Number(data.product_id));
    return ok ? json({ ok: true }) : json({ error: "Produkten finns inte" }, 404);
  }
  const watchMatch = pathname.match(/^\/api\/watch\/(\d+)$/);
  if (watchMatch && request.method === "DELETE") {
    await removeWatch(env, account.id, Number(watchMatch[1]));
    return json({ ok: true });
  }
  if (pathname === "/api/channels" && request.method === "GET") return json(await listChannels(env, account.id));
  if (pathname === "/api/channels" && request.method === "POST") {
    const data = await request.json<{ kind?: string; target?: string }>().catch(() => ({}) as { kind?: string; target?: string });
    const id = await addChannel(env, account.id, data.kind ?? "", data.target ?? "");
    return id ? json({ ok: true, id }) : json({ error: "Ogiltig kanal" }, 400);
  }
  const chMatch = pathname.match(/^\/api\/channels\/([A-Za-z0-9_-]+)$/);
  if (chMatch && request.method === "DELETE") {
    await removeChannel(env, account.id, chMatch[1]);
    return json({ ok: true });
  }
  if (pathname === "/api/bistand" && request.method === "GET") return json(await listBistand(env, account.id));
  if (pathname === "/api/bistand" && request.method === "POST") return handleAddBistand(request, env, account.id);
  const bistandMatch = pathname.match(/^\/api\/bistand\/(\d+)$/);
  if (bistandMatch && request.method === "DELETE") {
    await removeBistand(env, account.id, Number(bistandMatch[1]));
    return json({ ok: true });
  }

  return json({ error: "Hittar inte" }, 404);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function handleAddBistand(request: Request, env: Env, accountId: string): Promise<Response> {
  const data = await request
    .json<{ product_id?: number; motivation?: string }>()
    .catch(() => ({}) as { product_id?: number; motivation?: string });
  const productId = Number(data.product_id);
  if (!Number.isInteger(productId) || productId <= 0) return json({ error: "Ogiltig produkt" }, 400);
  const ok = await upsertBistand(env, accountId, productId, (data.motivation ?? "").trim());
  if (!ok) return json({ error: "Produkten finns inte" }, 404);
  return json({ ok: true });
}

function withSessionCookie(body: unknown, sessionToken: string): Response {
  const resp = json(body);
  resp.headers.append(
    "Set-Cookie",
    `session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
  );
  return resp;
}

// OAuth: starta inloggning -> redirect till leverantören med en state-nonce
// (lagras i cookie, verifieras i callbacken mot CSRF).
async function handleOAuthStart(provider: string, env: Env): Promise<Response> {
  if (!isKnownProvider(provider)) return json({ error: "Okänd leverantör" }, 404);
  const state = crypto.randomUUID();
  let authorizeUrl: string;
  try {
    authorizeUrl = getAuthorizeUrl(provider, env, state);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "OAuth ej konfigurerad" }, 503);
  }
  const resp = new Response(null, { status: 302, headers: { Location: authorizeUrl } });
  resp.headers.append(
    "Set-Cookie",
    `oauth_state=${state}; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  );
  return resp;
}

async function handleOAuthCallbackRoute(provider: string, request: Request, env: Env, url: URL): Promise<Response> {
  if (!isKnownProvider(provider)) return json({ error: "Okänd leverantör" }, 404);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = (request.headers.get("Cookie") ?? "").match(/oauth_state=([^;]+)/)?.[1] ?? null;
  if (!code || !state || !cookieState || state !== cookieState) {
    return redirectTo("/?error=oauth_state");
  }
  try {
    const { accountId } = await handleOAuthCallback(provider, env, code);
    const sessionToken = await createSession(env, accountId);
    const resp = redirectTo("/");
    resp.headers.append(
      "Set-Cookie",
      `session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
    );
    resp.headers.append("Set-Cookie", "oauth_state=; Path=/api/oauth; Max-Age=0");
    return resp;
  } catch (err) {
    console.error("oauth callback:", err);
    return redirectTo("/?error=oauth_failed");
  }
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

async function handleSignup(request: Request, env: Env): Promise<Response> {
  const data = await request.json<{ email?: string; password?: string }>().catch(() => ({}) as { email?: string; password?: string });
  try {
    const { accountId } = await signup(env, data.email ?? "", data.password ?? "");
    const { sessionToken } = await login(env, data.email ?? "", data.password ?? "");
    return withSessionCookie({ ok: true, accountId }, sessionToken);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Registrering misslyckades" }, 400);
  }
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const data = await request.json<{ email?: string; password?: string }>().catch(() => ({}) as { email?: string; password?: string });
  try {
    const { sessionToken } = await login(env, data.email ?? "", data.password ?? "");
    return withSessionCookie({ ok: true }, sessionToken);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Inloggning misslyckades" }, 401);
  }
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const cookie = request.headers.get("Cookie") ?? "";
  const token = cookie.match(/session=([^;]+)/)?.[1] ?? null;
  await logout(env, token);
  const resp = json({ ok: true });
  resp.headers.append("Set-Cookie", "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  return resp;
}

async function handleStatus(env: Env, account: { id: string; email: string; role: string; describe_mode: string }): Promise<Response> {
  const isAdmin = account.role === "admin";
  // Provider-info bara relevant för admin (beskriv-verktyget). has_own_key styr
  // om "auto"-läget kan slås på (annars skulle det tära på operatörens kvot).
  const ownKeys = await configuredProviders(env, account.id);
  const configured = isAdmin ? ownKeys : [];
  return json({
    email: account.email,
    role: account.role,
    describe_mode: account.describe_mode,
    has_own_key: ownKeys.length > 0,
    configured,
    ready: configured.length > 0,
  });
}

async function handleGetSettings(env: Env, accountId: string): Promise<Response> {
  const order = await getOrder(env, accountId);
  const configured = await configuredProviders(env, accountId);

  const extraValues: Record<string, Record<string, string>> = {};
  for (const [name, fields] of Object.entries(EXTRA_FIELDS)) {
    const config = await getProviderConfig(env, accountId, name as ProviderName);
    extraValues[name] = {};
    for (const field of fields ?? []) extraValues[name][field.name] = config[field.name] ?? "";
  }

  return json({
    configured: [...configured].sort(),
    order,
    available_models: Object.fromEntries(PROVIDER_NAMES.map((name) => [name, DEFAULT_MODELS[name] ? [DEFAULT_MODELS[name]] : []])),
    labels: PROVIDER_LABELS,
    extra_fields: EXTRA_FIELDS,
    extra_values: extraValues,
  });
}

async function handleSetKey(request: Request, env: Env, accountId: string): Promise<Response> {
  const data = await request.json<Record<string, string>>().catch(() => ({}) as Record<string, string>);
  const provider = data.provider as ProviderName;
  if (!PROVIDER_NAMES.includes(provider)) return json({ error: "Okänd leverantör" }, 400);
  const apiKey = data.api_key ?? "";
  if (!apiKey.trim()) return json({ error: "Nyckel saknas" }, 400);

  const extra: Record<string, string> = {};
  for (const field of EXTRA_FIELDS[provider] ?? []) {
    const value = (data[field.name] ?? "").trim();
    if (!value) return json({ error: `Fältet "${field.label}" krävs` }, 400);
    extra[field.name] = value;
  }

  await setProviderConfig(env, accountId, provider, { api_key: apiKey, ...extra });
  return json({ ok: true });
}

async function handleDeleteKey(env: Env, accountId: string, provider: string): Promise<Response> {
  if (!PROVIDER_NAMES.includes(provider as ProviderName)) return json({ error: "Okänd leverantör" }, 400);
  await removeProviderConfig(env, accountId, provider as ProviderName);
  return json({ ok: true });
}

async function handleSetOrder(request: Request, env: Env, accountId: string): Promise<Response> {
  const data = await request.json<{ order?: { provider: string; model: string }[] }>().catch(() => null);
  if (!data) return json({ error: "Ogiltig eller saknad JSON-data" }, 400);
  const order = data.order ?? [];
  for (const entry of order) {
    if (!PROVIDER_NAMES.includes(entry.provider as ProviderName)) return json({ error: `Okänd leverantör: ${entry.provider}` }, 400);
  }
  await setOrder(env, accountId, order as { provider: ProviderName; model: string }[]);
  return json({ ok: true });
}

interface UploadedFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

async function handleUpload(request: Request, env: Env, accountId: string): Promise<Response> {
  const form = await request.formData();
  const entry = form.get("file");
  if (typeof entry === "string" || !entry) return json({ error: "Ingen fil bifogad" }, 400);
  const file = entry as unknown as UploadedFile;

  const suffix = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  if (!file.name || !SUPPORTED_EXTENSIONS.includes(suffix)) {
    return json({ error: `Filtyp måste vara en av: ${SUPPORTED_EXTENSIONS.sort().join(", ")}` }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) return json({ error: "Filen är större än 50MB" }, 400);

  const configured = await configuredProviders(env, accountId);
  if (configured.length === 0) {
    return json({ error: "Ingen AI-leverantör är konfigurerad. Lägg till en API-nyckel i inställningarna." }, 400);
  }

  const options = {
    tone: String(form.get("tone") ?? ""),
    length: String(form.get("length") ?? ""),
    audience: String(form.get("audience") ?? ""),
  };
  const customDirection = String(form.get("custom_direction") ?? "");

  const jobId = crypto.randomUUID().replace(/-/g, "");
  const r2Key = `${accountId}/${jobId}${suffix}`;
  await env.UPLOADS.put(r2Key, await file.arrayBuffer());
  await createJob(env.DB, { id: jobId, accountId, filename: file.name, r2Key, options, customDirection });
  await env.JOB_QUEUE.send({ type: "extract", jobId } satisfies JobMessage);

  return json({ job_id: jobId });
}

async function handleListJobs(env: Env, accountId: string): Promise<Response> {
  const jobs = await getJobsForAccount(env.DB, accountId);
  return json(jobs.map(publicJob));
}

async function handleGetJob(env: Env, accountId: string, jobId: string): Promise<Response> {
  const job = await getJob(env.DB, jobId);
  if (!job || job.account_id !== accountId) return json({ error: "Hittar inte jobbet" }, 404);
  return json(publicJob(job));
}

async function handleDownloadJob(env: Env, accountId: string, jobId: string): Promise<Response> {
  const job = await getJob(env.DB, jobId);
  if (!job || job.account_id !== accountId || !job.output_key) return json({ error: "Ingen fil att ladda ner" }, 404);
  const obj = await env.UPLOADS.get(job.output_key);
  if (!obj) return json({ error: "Filen hittades inte" }, 404);
  const stem = job.filename.replace(/\.[^.]+$/, "");
  return new Response(obj.body, {
    headers: {
      "content-type": "text/csv",
      "content-disposition": `attachment; filename="${stem}_med_beskrivning.csv"`,
    },
  });
}

// Döljer interna fält (rows_json/partial_results_json kan vara stora och
// innehåller mellanresultat som inte är menade att visas direkt).
function publicJob(job: import("./db").Job) {
  const { rows_json, partial_results_json, ...rest } = job as typeof job & { rows_json?: unknown; partial_results_json?: unknown };
  return rest;
}
