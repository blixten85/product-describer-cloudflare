// Motsvarar providers.py — men varje leverantör anropas via rå fetch()
// istället för en SDK, eftersom inga av SDK:erna (anthropic/openai/
// google-genai) körs i Workers-runtimen. Samma fetch-mot-REST-API-mönster
// som redan används i politiker-webapp/app/src/draft-letter.ts för
// Anthropic specifikt — utökat här till alla fyra leverantörer.

const ANTHROPIC_VERSION = "2023-06-01";
const AZURE_API_VERSION = "2024-10-21";

export class RateLimitExceeded extends Error {
  constructor(public providerName: string, public retryAfterSeconds?: number) {
    super(`${providerName}: rate limit exceeded`);
  }
}

export class AllProvidersExhausted extends Error {
  constructor(public resumeAt: Date) {
    super(`All providers exhausted, next retry at ${resumeAt.toISOString()}`);
  }
}

// En "för låg kreditbalans"/"saknar kvot"-fel kommer inte alltid som 429
// (Anthropic skickar t.ex. 400) — matchar på text eftersom leverantörerna
// saknar en gemensam felkod för detta specifikt. Samma fraser som
// providers.py:s _BILLING_EXHAUSTED_PHRASES.
const BILLING_EXHAUSTED_PHRASES = ["credit balance", "insufficient_quota", "insufficient quota", "exceeded your current quota", "billing"];
const BILLING_RETRY_SECONDS = 6 * 3600; // ingen API-ledtråd om när krediter fylls på — gissa 6h

function isBillingExhausted(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  return BILLING_EXHAUSTED_PHRASES.some((phrase) => lower.includes(phrase));
}

function retryAfterSeconds(resp: Response): number | undefined {
  const value = resp.headers.get("retry-after");
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export type ProviderName = "anthropic" | "openai" | "gemini" | "azure_openai";

export const DEFAULT_MODELS: Record<ProviderName, string[]> = {
  anthropic: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-8"],
  openai: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
  azure_openai: [],
};

export interface ProviderCreds {
  apiKey: string;
  endpoint?: string; // azure_openai
  deployment?: string; // azure_openai
}

// Returnerar rå textsvar från modellen. Kastar RateLimitExceeded så
// ProviderChain kan byta till nästa leverantör i kedjan.
export async function generate(
  providerName: ProviderName,
  creds: ProviderCreds,
  systemPrompt: string,
  userMessage: string,
  model: string,
): Promise<string> {
  switch (providerName) {
    case "anthropic":
      return generateAnthropic(creds, systemPrompt, userMessage, model);
    case "openai":
      return generateOpenAI(creds, systemPrompt, userMessage, model, "https://api.openai.com/v1/chat/completions", {
        Authorization: `Bearer ${creds.apiKey}`,
      });
    case "gemini":
      return generateGemini(creds, systemPrompt, userMessage, model);
    case "azure_openai":
      return generateAzure(creds, systemPrompt, userMessage, model);
  }
}

async function generateAnthropic(creds: ProviderCreds, systemPrompt: string, userMessage: string, model: string): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": creds.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!resp.ok) await handleProviderError("anthropic", resp);
  const data = await resp.json<{ content: Array<{ type: string; text?: string }> }>();
  return data.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

async function generateOpenAI(
  creds: ProviderCreds,
  systemPrompt: string,
  userMessage: string,
  model: string,
  url: string,
  extraHeaders: Record<string, string>,
): Promise<string> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });
  if (!resp.ok) await handleProviderError("openai", resp);
  const data = await resp.json<{ choices: Array<{ message: { content: string | null } }> }>();
  return data.choices[0]?.message.content ?? "";
}

async function generateGemini(creds: ProviderCreds, systemPrompt: string, userMessage: string, model: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${creds.apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: userMessage }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
    }),
  });
  if (!resp.ok) await handleProviderError("gemini", resp);
  const data = await resp.json<{ candidates: Array<{ content: { parts: Array<{ text?: string }> } }> }>();
  return data.candidates[0]?.content.parts.map((p) => p.text ?? "").join("") ?? "";
}

async function generateAzure(creds: ProviderCreds, systemPrompt: string, userMessage: string, model: string): Promise<string> {
  const deployment = model || creds.deployment;
  const url = `${creds.endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`;
  return generateOpenAI(creds, systemPrompt, userMessage, model, url, { "api-key": creds.apiKey });
}

async function handleProviderError(providerName: ProviderName, resp: Response): Promise<never> {
  const bodyText = await resp.text();
  if (resp.status === 429) {
    throw new RateLimitExceeded(providerName, retryAfterSeconds(resp));
  }
  if (isBillingExhausted(bodyText)) {
    throw new RateLimitExceeded(providerName, BILLING_RETRY_SECONDS);
  }
  throw new Error(`${providerName} API-fel (${resp.status}): ${bodyText.slice(0, 300)}`);
}

function nextReset(retryAfterSec: number | undefined): Date {
  const now = new Date();
  if (retryAfterSec) return new Date(now.getTime() + retryAfterSec * 1000);
  // Ingen ledtråd om återställningstid — antar dygnskvot, väntar till nästa UTC-midnatt.
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow;
}

export interface ProviderSpec {
  provider: ProviderName;
  creds: ProviderCreds;
  model: string;
}

const JSON_BLOCK = /\{[\s\S]*\}/;

export function parseDescriptionResponse(content: string): { beskrivning: string; varför: string } {
  const text = (content ?? "").trim();
  const match = JSON_BLOCK.exec(text);
  if (match) {
    try {
      const data = JSON.parse(match[0]);
      return {
        beskrivning: String(data.beskrivning ?? "").trim(),
        varför: String(data.varför ?? data.varfor ?? "").trim(),
      };
    } catch {
      // föll igenom till textfallback nedan
    }
  }
  return { beskrivning: text, varför: "" };
}

// Motsvarar ProviderChain — provar leverantörer i prioritetsordning, byter
// till nästa vid kvotfel, försöker den uttömda igen efter förväntad
// återställningstid.
export class ProviderChain {
  private exhaustedUntil = new Map<number, Date>();

  constructor(private specs: ProviderSpec[]) {
    if (specs.length === 0) throw new Error("ProviderChain needs at least one provider");
  }

  private availableIndex(now: Date): number | null {
    for (let i = 0; i < this.specs.length; i++) {
      const until = this.exhaustedUntil.get(i);
      if (!until || until <= now) return i;
    }
    return null;
  }

  nextResumeAt(): Date {
    if (this.exhaustedUntil.size === 0) return new Date();
    return new Date(Math.min(...[...this.exhaustedUntil.values()].map((d) => d.getTime())));
  }

  async call(systemPrompt: string, userMessage: string): Promise<string> {
    while (true) {
      const now = new Date();
      const idx = this.availableIndex(now);
      if (idx === null) throw new AllProvidersExhausted(this.nextResumeAt());
      const spec = this.specs[idx];
      try {
        return await generate(spec.provider, spec.creds, systemPrompt, userMessage, spec.model);
      } catch (err) {
        if (err instanceof RateLimitExceeded) {
          this.exhaustedUntil.set(idx, nextReset(err.retryAfterSeconds));
          continue;
        }
        throw err;
      }
    }
  }

  async generate(systemPrompt: string, userMessage: string): Promise<{ beskrivning: string; varför: string }> {
    return parseDescriptionResponse(await this.call(systemPrompt, userMessage));
  }
}
