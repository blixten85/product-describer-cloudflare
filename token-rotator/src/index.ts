// cf-token-rotator — mailar när kontots Cloudflare API-tokens närmar sig utgång.
//
// Förlängde tidigare tokens automatiskt. Det togs bort medvetet 2026-07-27: en
// process som i tysthet håller nycklar vid liv år efter år är ingen
// säkerhetsåtgärd, bara en zombie som gör att ingen någonsin omprövar om
// nyckeln fortfarande behövs. Nu larmar den i stället, varje dygn, tills en
// människa gått in och förlängt eller raderat tokenen. Mailet slutar av sig
// självt när utgången hamnat utanför tröskeln igen — ingen kvittering, ingen
// lagrad status.
//
// Följden är att Workern inte längre behöver kunna SKRIVA. Den listar bara.
// CF_ADMIN_TOKEN bör därför krympas till "Account API Tokens Read" i
// dashboarden, se noten i wrangler.jsonc.
//
// Endast scheduled() — ingen HTTP-route, ingen yta att anropa utifrån.

interface Env {
  CF_ADMIN_TOKEN: string; // räcker med Account API Tokens Read
  CF_ACCOUNT_ID: string;
  THRESHOLD_DAYS?: string;
  RESEND_API_KEY?: string;
  EMAIL_TO?: string;
  EMAIL_FROM?: string;
}

const API = "https://api.cloudflare.com/client/v4";
const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

interface TokenSummary {
  id: string;
  name: string;
  status: string;
  expires_on?: string;
}

interface Expiring {
  name: string;
  daysLeft: number;
  expiresOn: string;
}

async function cf(method: string, path: string, token: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  return res.json();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function sendMail(env: Env, expiring: Expiring[]): Promise<void> {
  const to = env.EMAIL_TO;
  const key = env.RESEND_API_KEY;
  if (!key || !to) {
    console.error("kan inte maila: RESEND_API_KEY eller EMAIL_TO saknas");
    return;
  }
  const soonest = expiring[0].daysLeft; // listan är sorterad, närmast först
  const subject =
    expiring.length === 1
      ? `Cloudflare-token utgår om ${soonest} dagar`
      : `${expiring.length} Cloudflare-tokens utgår, närmast om ${soonest} dagar`;

  const rows = expiring
    .map(
      (e) =>
        `<li><strong>${escapeHtml(e.name)}</strong> — ${e.daysLeft} dagar kvar (${e.expiresOn.slice(0, 10)})</li>`,
    )
    .join("\n");
  const threshold = Number(env.THRESHOLD_DAYS) || 30;
  const html = `<p>Följande Cloudflare API-tokens närmar sig utgång:</p>
<ul>
${rows}
</ul>
<p>Gå till <a href="${TOKENS_URL}">API-tokens i dashboarden</a> och antingen
<strong>förläng livslängden</strong> eller <strong>radera tokenen</strong> om den
inte behövs längre.</p>
<p>Det här mailet skickas varje dygn tills utgången ligger mer än ${threshold}
dagar bort. Ingen kvittering behövs — när du åtgärdat saken slutar det av sig
självt.</p>`;

  const text =
    "Följande Cloudflare API-tokens närmar sig utgång:\n" +
    expiring.map((e) => `  - ${e.name}: ${e.daysLeft} dagar kvar (${e.expiresOn.slice(0, 10)})`).join("\n") +
    `\n\nFörläng eller radera: ${TOKENS_URL}\n` +
    "Mailet upprepas varje dygn tills det är åtgärdat.";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "CF-tokenvakt <tokens@send.denied.se>",
      to,
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    // Loggas som fel men kastar inte vidare: en utebliven notis ska inte se ut
    // som att kontrollen aldrig kördes.
    console.error(`Resend svarade ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  console.log(`mail skickat till ${to} om ${expiring.length} token(s)`);
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const acc = env.CF_ACCOUNT_ID;
    const admin = env.CF_ADMIN_TOKEN;
    if (!acc || !admin) {
      console.error("saknar CF_ACCOUNT_ID eller CF_ADMIN_TOKEN");
      return;
    }
    const thresholdDays = Number(env.THRESHOLD_DAYS) || 30;
    const now = Date.now();
    const thresholdMs = now + thresholdDays * 86_400_000;

    const listing = await cf("GET", `/accounts/${acc}/tokens`, admin);
    if (!listing.success) {
      console.error("kunde inte lista tokens:", JSON.stringify(listing.errors));
      return;
    }

    const expiring: Expiring[] = [];
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
      console.log(`[UTGÅR] ${t.name}: ${daysLeft}d kvar (${t.expires_on})`);
      expiring.push({ name: t.name, daysLeft, expiresOn: t.expires_on });
    }

    if (expiring.length === 0) {
      console.log("cf-token-rotator klar: inget nära utgång.");
      return;
    }
    expiring.sort((a, b) => a.daysLeft - b.daysLeft);
    await sendMail(env, expiring);
    console.log(`cf-token-rotator klar: ${expiring.length} token(s) nära utgång.`);
  },
} satisfies ExportedHandler<Env>;
