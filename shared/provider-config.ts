// Motsvarar provider_config.py — lagring av leverantörers API-nycklar +
// failover-ordning. Fernet (Python) → AES-GCM via Web Crypto (samma mönster
// som politiker-webapps MAIL_CRED_KEY, se shared/crypto.ts). En rad per
// (konto, leverantör) i D1 istället för en krypterad fil per nyckel.
//
// Ingen legacy-plaintext-fallback här (det fanns i Python-versionen för att
// stödja installationer från innan PROVIDER_CONFIG_MASTER_KEY infördes) —
// irrelevant för en ny installation där kryptering alltid är på.

import { encryptSecret, decryptSecret } from "./crypto";
import { ProviderChain, type ProviderSpec, type ProviderCreds } from "./providers";

// Minimal struktur som täcker både app- och processor-Workerns Env — denna
// fil ska kunna användas av båda utan att bero på endera sidans fullständiga
// Env-typ (som har olika bindningar, t.ex. UPLOADS/SESSIONS finns bara i app).
export interface ProviderConfigEnv {
  DB: D1Database;
  PROVIDER_CONFIG_KEY: string;
}

export type ProviderName = "anthropic" | "openai" | "gemini" | "azure_openai";

export const PROVIDER_NAMES: ProviderName[] = ["anthropic", "openai", "gemini", "azure_openai"];

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
  azure_openai: "",
};

// Fält utöver api_key som en leverantör behöver innan den kan användas.
export const EXTRA_FIELDS: Partial<Record<ProviderName, { name: string; label: string }[]>> = {
  azure_openai: [
    { name: "endpoint", label: "Azure-endpoint (https://<resurs>.openai.azure.com)" },
    { name: "deployment", label: "Deployment-namn" },
  ],
};

export interface ProviderConfig {
  api_key: string;
  [extraField: string]: string;
}

export interface OrderEntry {
  provider: ProviderName;
  model: string;
}

export async function getProviderConfig(env: ProviderConfigEnv, accountId: string, provider: ProviderName): Promise<ProviderConfig> {
  const row = await env.DB.prepare("SELECT encrypted_config FROM provider_configs WHERE account_id = ? AND provider = ?")
    .bind(accountId, provider)
    .first<{ encrypted_config: string }>();
  if (!row) return { api_key: "" };
  const decrypted = await decryptSecret(row.encrypted_config, env.PROVIDER_CONFIG_KEY);
  return JSON.parse(decrypted);
}

export async function setProviderConfig(
  env: ProviderConfigEnv,
  accountId: string,
  provider: ProviderName,
  updates: Partial<ProviderConfig>,
): Promise<void> {
  const config = { ...(await getProviderConfig(env, accountId, provider)), ...updates };
  for (const key of Object.keys(config)) {
    if (typeof config[key] === "string") config[key] = config[key].trim();
  }
  const encrypted = await encryptSecret(JSON.stringify(config), env.PROVIDER_CONFIG_KEY);
  await env.DB.prepare(
    "INSERT INTO provider_configs (account_id, provider, encrypted_config) VALUES (?, ?, ?) " +
      "ON CONFLICT(account_id, provider) DO UPDATE SET encrypted_config = excluded.encrypted_config",
  )
    .bind(accountId, provider, encrypted)
    .run();
}

export async function removeProviderConfig(env: ProviderConfigEnv, accountId: string, provider: ProviderName): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_configs WHERE account_id = ? AND provider = ?").bind(accountId, provider).run();
}

export function isProviderReady(provider: ProviderName, config: ProviderConfig): boolean {
  if (!config.api_key) return false;
  return (EXTRA_FIELDS[provider] ?? []).every((field) => config[field.name]);
}

export async function configuredProviders(env: ProviderConfigEnv, accountId: string): Promise<ProviderName[]> {
  const ready: ProviderName[] = [];
  for (const name of PROVIDER_NAMES) {
    if (isProviderReady(name, await getProviderConfig(env, accountId, name))) ready.push(name);
  }
  return ready;
}

// En konfigurerad leverantör som saknas i en tidigare sparad ordning (t.ex.
// nyckel lades till efter att ordningen senast sparades) läggs på sist
// istället för att tappas — samma beteende som get_order() i Python.
export async function getOrder(env: ProviderConfigEnv, accountId: string): Promise<OrderEntry[]> {
  const configured = await configuredProviders(env, accountId);
  const row = await env.DB.prepare("SELECT order_json FROM provider_order WHERE account_id = ?").bind(accountId).first<{
    order_json: string;
  }>();
  const saved: OrderEntry[] = row ? JSON.parse(row.order_json) : [];
  const order = saved.filter((entry) => configured.includes(entry.provider));
  const seen = new Set(order.map((e) => e.provider));
  for (const name of configured) {
    if (!seen.has(name)) order.push({ provider: name, model: DEFAULT_MODELS[name] });
  }
  return order;
}

export async function setOrder(env: ProviderConfigEnv, accountId: string, order: OrderEntry[]): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO provider_order (account_id, order_json) VALUES (?, ?) " +
      "ON CONFLICT(account_id) DO UPDATE SET order_json = excluded.order_json",
  )
    .bind(accountId, JSON.stringify(order))
    .run();
}

// Motsvarar build_chain() — bygger en ProviderChain av kontots sparade
// inställningar, i failover-prioritetsordning. Returnerar null om inget
// är konfigurerat (anroparen avgör om det ska behandlas som fel).
export async function buildChain(env: ProviderConfigEnv, accountId: string): Promise<ProviderChain | null> {
  const order = await getOrder(env, accountId);
  const specs: ProviderSpec[] = [];
  for (const entry of order) {
    const config = await getProviderConfig(env, accountId, entry.provider);
    if (!isProviderReady(entry.provider, config)) continue;
    const creds: ProviderCreds = { apiKey: config.api_key, endpoint: config.endpoint, deployment: config.deployment };
    specs.push({ provider: entry.provider, creds, model: entry.model });
  }
  if (specs.length === 0) return null;
  return new ProviderChain(specs);
}
