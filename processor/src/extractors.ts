// Motsvarar extractors.py — gör om en uppladdad fil till produktrader.
// CSV/XLSX har redan strukturerade kolumner och parsas direkt. Fritextformat
// (txt/docx/pdf) saknar struktur, så texten skickas till AI-leverantörskedjan
// en gång per fil med en extraktionsprompt som ber den hitta varje produkt
// och svara som JSON.
//
// PDF via unpdf (samma bibliotek+mönster som redan verifierat fungera i
// produktion i politiker-webapp/app/src/document-parsing.ts) — INTE ännu
// testat mot stora/komplexa PDF:er i denna kodbas specifikt, se uppgift om
// att verifiera CPU-tid/minne mot riktiga testfiler upp till 50MB-gränsen.

import * as XLSX from "xlsx";
import { AllProvidersExhausted, ProviderChain } from "../../shared/providers";

export const SUPPORTED_EXTENSIONS = [".csv", ".xlsx", ".txt", ".docx", ".pdf"];

export const ROW_FIELDS = ["Site", "Product", "Price (SEK)", "Link"];

const JSON_ARRAY = /\[[\s\S]*\]/;

const EXTRACTION_PROMPT = [
  "Du får ett textdokument. Hitta varje enskild produkt/pryl som nämns i texten.",
  "Svara ALLTID med endast en giltig JSON-array, utan kodstaket eller extra text,",
  'i exakt detta format:\n[{"Product": "...", "Site": "...", "Price (SEK)": "..."}]',
  "- 'Product' (krävs): produktens namn.",
  "- 'Site' och 'Price (SEK)' (valfria): lämna som tom sträng om okänt.",
  "Hitta om möjligt ALLA produkter i dokumentet, inte bara de första.",
].join("\n");

export class ExtractionError extends Error {}

export interface ExtractedRows {
  rows: Record<string, string>[];
  fieldnames: string[];
}

export async function extractRows(
  filename: string,
  bytes: ArrayBuffer,
  chain: ProviderChain | null,
): Promise<ExtractedRows> {
  const suffix = filename.toLowerCase().slice(filename.lastIndexOf("."));

  if (suffix === ".csv") return parseCsv(bytes);
  if (suffix === ".xlsx") return parseXlsx(bytes);
  if (suffix === ".txt" || suffix === ".docx" || suffix === ".pdf") {
    if (!chain) throw new ExtractionError(`${suffix}-filer kräver en konfigurerad AI-leverantör för att hitta produkter.`);
    const text = await extractText(suffix, bytes);
    return aiExtract(text, chain);
  }
  throw new ExtractionError(`Filtypen ${suffix} stöds inte.`);
}

function parseCsv(bytes: ArrayBuffer): ExtractedRows {
  const text = new TextDecoder().decode(bytes);
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return { rows: [], fieldnames: [] };

  const fieldnames = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    fieldnames.forEach((field, i) => (row[field] = values[i] ?? ""));
    return row;
  });
  return { rows, fieldnames };
}

// Minimal CSV-radparsning med stöd för citerade fält ("a, b"-> ett fält) —
// motsvarar Pythons csv.DictReader för det vanliga fallet, ingen fullständig
// RFC4180-implementation (multiline-citerade fält stöds inte).
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      values.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function parseXlsx(bytes: ArrayBuffer): ExtractedRows {
  const wb = XLSX.read(bytes, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  if (rawRows.length === 0) return { rows: [], fieldnames: ROW_FIELDS };

  const header = rawRows[0].map((c) => (c === null || c === undefined ? "" : String(c)));
  const rows: Record<string, string>[] = [];
  for (const raw of rawRows.slice(1)) {
    if (raw.every((c) => c === null || c === undefined)) continue;
    const row: Record<string, string> = {};
    header.forEach((field, i) => {
      const v = raw[i];
      row[field] = v === null || v === undefined ? "" : String(v);
    });
    rows.push(row);
  }
  return { rows, fieldnames: header };
}

async function extractText(suffix: string, bytes: ArrayBuffer): Promise<string> {
  if (suffix === ".txt") return new TextDecoder().decode(bytes);
  if (suffix === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: bytes });
    return result.value;
  }
  if (suffix === ".pdf") {
    const { extractText: extractPdfText, getDocumentProxy } = await import("unpdf");
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractPdfText(pdf, { mergePages: true });
      return text;
    } catch (err) {
      throw new ExtractionError(`Kunde inte läsa PDF-filen — den verkar vara skadad eller felaktig: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw new ExtractionError(`Filtypen ${suffix} stöds inte.`);
}

async function aiExtract(text: string, chain: ProviderChain): Promise<ExtractedRows> {
  text = text.trim();
  if (!text) throw new ExtractionError("Dokumentet innehöll ingen text.");

  let content: string;
  try {
    content = await chain.call(EXTRACTION_PROMPT, text.slice(0, 50_000));
  } catch (err) {
    if (err instanceof AllProvidersExhausted) throw err;
    throw err;
  }

  const match = JSON_ARRAY.exec(content ?? "");
  if (!match) throw new ExtractionError("AI-leverantören kunde inte hitta några produkter i dokumentet.");

  let items: Array<Record<string, unknown>>;
  try {
    items = JSON.parse(match[0]);
  } catch {
    throw new ExtractionError("AI-leverantörens svar gick inte att tolka som JSON.");
  }

  const rows = items
    .map((item) => ({
      Site: String(item.Site ?? "").trim(),
      Product: String(item.Product ?? "").trim(),
      "Price (SEK)": String(item["Price (SEK)"] ?? "").trim(),
      Link: "",
    }))
    .filter((row) => row.Product);

  if (rows.length === 0) throw new ExtractionError("Inga produkter kunde identifieras i dokumentet.");
  return { rows, fieldnames: ROW_FIELDS };
}
