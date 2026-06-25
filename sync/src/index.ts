// Motsvarar main.py:s cmd_sync(--watch) — men som en Cloudflare Cron
// Trigger istället för en evig while-loop med time.sleep(). Ingen
// persisterad paus/återupptagning behövs: en produkt som hoppas över på
// grund av AllProvidersExhausted (eller ett enstaka fel) fångas naturligt
// upp av NÄSTA 5-minuterscykel, eftersom scraper-API:et alltid returnerar
// alla produkter som fortfarande saknar beskrivning.
//
// Använder leverantörsnycklar direkt från miljövariabler (Wrangler secrets),
// INTE D1/konto-baserat — motsvarar build_chain_from_env(), eftersom det här
// är operatörens egen körning, inte knuten till ett användarkonto.

import { ProviderChain, AllProvidersExhausted, DEFAULT_MODELS, type ProviderSpec, type ProviderName } from "../../shared/providers";
import { buildSystemPrompt, userMessage } from "../../shared/prompts";

interface Env {
  SCRAPER_URL: string;
  SCRAPER_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  AZURE_OPENAI_API_KEY?: string;
  AZURE_OPENAI_ENDPOINT?: string;
  AZURE_OPENAI_DEPLOYMENT?: string;
  SYNC_LIMIT?: string; // default 50, motsvarar --limit
  SYNC_WORKERS?: string; // default 2, motsvarar --workers (parallella AI-anrop per cykel)
}

interface Product {
  id: number;
  title: string;
  url?: string;
}

function buildChainFromEnv(env: Env): ProviderChain | null {
  const specs: ProviderSpec[] = [];
  const providerKeys: Record<ProviderName, string | undefined> = {
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    gemini: env.GEMINI_API_KEY,
    azure_openai: env.AZURE_OPENAI_API_KEY,
  };
  for (const [name, apiKey] of Object.entries(providerKeys) as [ProviderName, string | undefined][]) {
    if (!apiKey) continue;
    if (name === "azure_openai") {
      if (!env.AZURE_OPENAI_ENDPOINT || !env.AZURE_OPENAI_DEPLOYMENT) continue;
      specs.push({
        provider: name,
        creds: { apiKey, endpoint: env.AZURE_OPENAI_ENDPOINT, deployment: env.AZURE_OPENAI_DEPLOYMENT },
        model: env.AZURE_OPENAI_DEPLOYMENT,
      });
      continue;
    }
    specs.push({ provider: name, creds: { apiKey }, model: DEFAULT_MODELS[name][0] });
  }
  return specs.length > 0 ? new ProviderChain(specs) : null;
}

async function fetchProductsMissingDescription(env: Env, limit: number): Promise<Product[]> {
  const resp = await fetch(`${env.SCRAPER_URL}/products?missing_description=true&limit=${limit}`, {
    headers: { "X-API-Key": env.SCRAPER_API_KEY },
  });
  if (!resp.ok) throw new Error(`scraper-API svarade ${resp.status}`);
  const data = await resp.json<{ products: Product[] }>();
  return data.products ?? [];
}

async function pushDescription(env: Env, productId: number, beskrivning: string, varför: string): Promise<void> {
  const resp = await fetch(`${env.SCRAPER_URL}/products/${productId}/description`, {
    method: "PUT",
    headers: { "X-API-Key": env.SCRAPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ description: beskrivning, why: varför }),
  });
  if (!resp.ok) throw new Error(`scraper-API svarade ${resp.status}`);
}

async function processOne(chain: ProviderChain, product: Product, env: Env): Promise<void> {
  let parts: { beskrivning: string; varför: string };
  try {
    const systemPrompt = buildSystemPrompt();
    parts = await chain.generate(systemPrompt, userMessage("", product.title, ""));
  } catch (err) {
    if (err instanceof AllProvidersExhausted) {
      console.warn(`Alla leverantörer uttömda, försöker igen efter ${err.resumeAt.toISOString()}`);
      return;
    }
    console.warn(`Hoppar över produkt ${product.id}:`, err);
    return;
  }
  if (!parts.beskrivning) {
    console.warn(`Hoppar över produkt ${product.id}: tomt svar`);
    return;
  }
  try {
    await pushDescription(env, product.id, parts.beskrivning, parts.varför);
    console.log(`Beskrev produkt ${product.id}`);
  } catch (err) {
    console.error(`Kunde inte spara beskrivning för ${product.id}:`, err);
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const chain = buildChainFromEnv(env);
    if (!chain) {
      console.error("Ingen AI-leverantör konfigurerad (sätt t.ex. ANTHROPIC_API_KEY som secret).");
      return;
    }

    const limit = Number(env.SYNC_LIMIT) || 50;
    let products: Product[];
    try {
      products = await fetchProductsMissingDescription(env, limit);
    } catch (err) {
      console.error("Kunde inte hämta från scrapern:", err);
      return;
    }

    if (products.length === 0) {
      console.log("Inga produkter att beskriva just nu");
      return;
    }
    console.log(`Hämtade ${products.length} produkter utan beskrivning`);

    // Parallellitet motsvarar Pythons ThreadPoolExecutor(max_workers) — men
    // utan en explicit trådpool, eftersom fetch() i Workers redan är
    // asynkront/icke-blockerande. SYNC_WORKERS begränsar hur många AI-anrop
    // som körs samtidigt, för att inte träffa leverantörens egen rate limit.
    const concurrency = Number(env.SYNC_WORKERS) || 2;
    for (let i = 0; i < products.length; i += concurrency) {
      const batch = products.slice(i, i + concurrency);
      await Promise.all(batch.map((p) => processOne(chain, p, env)));
    }
  },
};
