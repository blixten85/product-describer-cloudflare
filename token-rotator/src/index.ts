// cf-token-rotator — håller kontots Cloudflare API-tokens från att tyst löpa ut.
//
// Speglar ~/.claude-admin/rotate-keys.py:s `check`-läge, men kör som en
// Cloudflare Worker-cron i stället för server-cron. Poängen: token-hygienen blir
// SJÄLVGÅENDE på Cloudflare och överlever att servern (eller operatören)
// försvinner. Admin-token kan förlänga alla kontots tokens inklusive SIG SJÄLV
// -> självförevigande så länge Workern kör och kontot är aktivt (betalt).
//
// Endast scheduled() — ingen HTTP-route (Workern bär en kraftfull admin-token,
// så ingen yta att anropa utifrån).

import * as Sentry from "@sentry/cloudflare";

interface Env {
  CF_ADMIN_TOKEN: string; // Account API Tokens Write
  CF_ACCOUNT_ID: string;
  THRESHOLD_DAYS?: string;
  EXTEND_DAYS?: string;
  SENTRY_DSN?: string;
}

const API = "https://api.cloudflare.com/client/v4";

interface TokenSummary {
  id: string;
  name: string;
  status: string;
  expires_on?: string;
}

async function cf(method: string, path: string, token: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1.0,
  }),
  {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const acc = env.CF_ACCOUNT_ID;
    const admin = env.CF_ADMIN_TOKEN;
    if (!acc || !admin) {
      console.error("saknar CF_ACCOUNT_ID eller CF_ADMIN_TOKEN");
      return;
    }
    const thresholdDays = Number(env.THRESHOLD_DAYS) || 30;
    const extendDays = Number(env.EXTEND_DAYS) || 365;
    const now = Date.now();
    const thresholdMs = now + thresholdDays * 86_400_000;
    const newExpiry = new Date(now + extendDays * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");

    const listing = await cf("GET", `/accounts/${acc}/tokens`, admin);
    if (!listing.success) {
      console.error("kunde inte lista tokens:", JSON.stringify(listing.errors));
      return;
    }

    let extended = 0;
    for (const t of listing.result as TokenSummary[]) {
      if (!t.expires_on) {
        console.log(`[ok evig] ${t.name}`);
        continue;
      }
      const expMs = Date.parse(t.expires_on);
      const daysLeft = Math.round((expMs - now) / 86_400_000);
      if (expMs > thresholdMs) {
        console.log(`[ok ${daysLeft}d] ${t.name}`);
        continue;
      }
      // hämta full token-definition och PUT:a med ny utgång
      const full = (await cf("GET", `/accounts/${acc}/tokens/${t.id}`, admin)).result;
      const body: Record<string, unknown> = {
        name: full.name,
        policies: full.policies,
        expires_on: newExpiry,
      };
      if (full.not_before) body.not_before = full.not_before;
      if (full.condition) body.condition = full.condition;
      const res = await cf("PUT", `/accounts/${acc}/tokens/${t.id}`, admin, body);
      if (res.success) {
        extended++;
        console.log(`[FÖRLÄNGD] ${t.name} (${daysLeft}d -> ${extendDays}d, ny ${res.result.expires_on})`);
      } else {
        console.error(`[FEL] ${t.name}: ${JSON.stringify(res.errors)}`);
      }
    }
    console.log(`cf-token-rotator klar: ${extended} token(s) förlängda.`);
  },
  } satisfies ExportedHandler<Env>,
);
