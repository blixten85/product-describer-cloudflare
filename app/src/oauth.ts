// OAuth-inloggning (authorization code). Portad från politiker-webapp — SAMMA
// OAuth-appar (Google/Microsoft) återanvänds; bara redirect_uri skiljer, så
// product-describers callback-URL måste läggas till i respektive OAuth-apps
// redirect-lista. Apple ej stött (kräver roterande ES256-JWT-secret).
import { randomId, hashPassword } from "../../shared/crypto";
import { getAccountByEmail, type Env } from "./db";

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  clientIdEnvKey: keyof Env;
  clientSecretEnvKey: keyof Env;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    scope: "openid email profile",
    clientIdEnvKey: "OAUTH_GOOGLE_CLIENT_ID",
    clientSecretEnvKey: "OAUTH_GOOGLE_CLIENT_SECRET",
  },
  microsoft: {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userinfoUrl: "https://graph.microsoft.com/oidc/userinfo",
    scope: "openid email profile",
    clientIdEnvKey: "OAUTH_MICROSOFT_CLIENT_ID",
    clientSecretEnvKey: "OAUTH_MICROSOFT_CLIENT_SECRET",
  },
};

const REDIRECT_BASE = "https://product-describer.denied.se/api/oauth";

export function isKnownProvider(provider: string): boolean {
  return provider in PROVIDERS;
}

function redirectUri(provider: string): string {
  return `${REDIRECT_BASE}/${provider}/callback`;
}

export function getAuthorizeUrl(provider: string, env: Env, state: string): string {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error("Okänd leverantör");
  const clientId = env[cfg.clientIdEnvKey] as string | undefined;
  if (!clientId) throw new Error(`${provider}-inloggning är inte konfigurerad än`);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(provider),
    response_type: "code",
    scope: cfg.scope,
    state,
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

async function exchangeCodeForUserInfo(
  provider: string,
  env: Env,
  code: string,
): Promise<{ providerUserId: string; email: string; emailVerified: boolean }> {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error("Okänd leverantör");
  const clientId = env[cfg.clientIdEnvKey] as string | undefined;
  const clientSecret = env[cfg.clientSecretEnvKey] as string | undefined;
  if (!clientId || !clientSecret) throw new Error(`${provider}-inloggning är inte konfigurerad än`);

  const tokenResp = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri(provider),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) throw new Error(`Kunde inte hämta access token från ${provider}`);
  const tokenData = await tokenResp.json<{ access_token: string }>();

  const userResp = await fetch(cfg.userinfoUrl, {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "product-describer" },
  });
  if (!userResp.ok) throw new Error(`Kunde inte hämta användarinfo från ${provider}`);
  const userData = await userResp.json<Record<string, unknown>>();

  const providerUserId = String(userData.sub ?? userData.id ?? "");
  const email = (userData.email as string | undefined) ?? null;
  if (!providerUserId || !email) throw new Error(`Kunde inte hämta identitet från ${provider}`);
  // Leverantören kan hävda en e-post som användaren inte bevisat att den äger
  // (klassisk "nOAuth": sätt valfri e-post i profilen och logga in). Vi litar
  // bara på verified-flaggan när vi länkar till ett BEFINTLIGT lösenordskonto.
  // Google skickar email_verified (boolean eller "true"); saknas den (t.ex.
  // Microsofts userinfo) behandlas e-posten som overifierad.
  const rawVerified = userData.email_verified ?? userData.verified_email;
  const emailVerified = rawVerified === true || rawVerified === "true";
  return { providerUserId, email, emailVerified };
}

// Login-callback: matcha känd identitet -> annars länka på e-post -> annars nytt
// konto (med slumpat oanvändbart lösenord). Returnerar konto-id att skapa session för.
export async function handleOAuthCallback(provider: string, env: Env, code: string): Promise<{ accountId: string }> {
  const { providerUserId, email, emailVerified } = await exchangeCodeForUserInfo(provider, env, code);

  const existing = await env.DB.prepare(
    "SELECT account_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?",
  )
    .bind(provider, providerUserId)
    .first<{ account_id: string }>();
  if (existing) return { accountId: existing.account_id };

  const account = await getAccountByEmail(env.DB, email);
  let accountId: string;
  if (account) {
    // Länkning till ett befintligt konto kräver att leverantören intygar att
    // e-posten är verifierad — annars kunde en angripare ta över kontot genom
    // att sätta offrets e-post i sin egen IdP-profil.
    if (!emailVerified) {
      throw new Error(
        `${provider} kunde inte bekräfta att e-postadressen är verifierad. Logga in med lösenord i stället.`,
      );
    }
    accountId = account.id;
  } else {
    accountId = randomId();
    const { hash, salt } = await hashPassword(randomId() + randomId());
    await env.DB.prepare(
      "INSERT INTO accounts (id, email, password_hash, password_salt, role, created_at) VALUES (?, ?, ?, ?, 'user', ?)",
    )
      .bind(accountId, email.trim().toLowerCase(), hash, salt, Date.now())
      .run();
  }

  await env.DB.prepare(
    "INSERT INTO oauth_identities (id, account_id, provider, provider_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(randomId(), accountId, provider, providerUserId, Date.now())
    .run();
  return { accountId };
}
