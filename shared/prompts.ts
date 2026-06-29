// Motsvarar prompts.py — bygger systemprompten för beskrivningsgenerering
// utifrån UI-valen.

export interface PromptOptions {
  tone?: string;
  length?: string;
  audience?: string;
}

const BASE_PROMPT = [
  "Du är en assistent som skriver korta produktbeskrivningar på svenska.",
  "Svara ALLTID med endast giltig JSON i exakt detta format, utan kodstaket eller extra text:",
  '{"beskrivning": "...", "varför": "..."}',
  "- 'beskrivning' (1–2 meningar): kort, naturlig beskrivning av produkten.",
  "- 'varför' (1–2 meningar): varför någon skulle vilja eller behöva produkten.",
].join("\n");

const TONE_INSTRUCTIONS: Record<string, string> = {
  saklig: "Håll tonen saklig och informativ.",
  entusiastisk: "Skriv med entusiasm och energi.",
  humoristisk: "Lägg in en lätt humoristisk touch.",
  lyxig: "Skriv med en exklusiv, premium känsla.",
};

const LENGTH_INSTRUCTIONS: Record<string, string> = {
  kort: "Var extra kort — max en mening per fält.",
  medel: "Använd 1–2 meningar per fält (standard).",
  lang: "Du får använda upp till 3 meningar per fält om det behövs.",
};

const DEFAULT_VARIATION =
  "Variera stilen mellan produkter — ibland praktisk, ibland entusiastisk, ibland reflekterande. " +
  "Undvik inledningar som 'Självklart!', 'Givetvis!' eller 'Absolut!'.";

export function buildSystemPrompt(options: PromptOptions = {}, customDirection = ""): string {
  const parts = [BASE_PROMPT];

  if (options.tone && TONE_INSTRUCTIONS[options.tone]) {
    parts.push(TONE_INSTRUCTIONS[options.tone]);
  } else {
    parts.push(DEFAULT_VARIATION);
  }

  if (options.length && LENGTH_INSTRUCTIONS[options.length]) {
    parts.push(LENGTH_INSTRUCTIONS[options.length]);
  }

  const audience = (options.audience ?? "").trim();
  if (audience) parts.push(`Anpassa motiveringen för målgruppen: ${audience}.`);

  const custom = customDirection.trim();
  if (custom) parts.push(`Extra instruktion från användaren: ${custom}`);

  return parts.join("\n");
}

export function userMessage(site: string, product: string, price: string, category = ""): string {
  const lines = [`Produkt: ${product}`];
  if (category.trim()) lines.push(`Kategori: ${category.trim()}`);
  lines.push(`Butik: ${site}`);
  lines.push(`Pris: ${price} kr`);
  return lines.join("\n");
}
