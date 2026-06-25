// Motsvarar app.py:s _process()/_finish_job() — men som en Cloudflare Queue-
// konsument istället för en lång bakgrundstråd med ThreadPoolExecutor, eftersom
// Workers inte kan köra en flertimmars bakgrundsprocess i en enda invocation.
//
// Två meddelandetyper i samma kö (motsvarar Pythons tvåstegsflöde: extrahera
// rader en gång per fil, sedan generera beskrivning per rad):
// - {type: "extract", jobId}     — extraherar rader ur den uppladdade filen
// - {type: "describe", jobId, rowIndex} — genererar beskrivning för EN rad
//
// Parallellitet kommer från köns max_concurrency (flera describe-meddelanden
// för samma jobb körs samtidigt) — motsvarar workers-parametern i Python,
// men utan en explicit trådpool.

import { buildChain, type ProviderConfigEnv } from "../../shared/provider-config";
import { extractRows, ExtractionError, type ExtractedRows } from "./extractors";
import { buildSystemPrompt, userMessage } from "../../shared/prompts";
import { AllProvidersExhausted } from "../../shared/providers";

interface Env extends ProviderConfigEnv {
  UPLOADS: R2Bucket;
  JOB_QUEUE: Queue<JobMessage>;
}

type JobMessage = { type: "extract"; jobId: string } | { type: "describe"; jobId: string; rowIndex: number };

interface JobRow {
  id: string;
  account_id: string;
  status: string;
  filename: string;
  r2_key: string;
  rows_json: string | null;
  partial_results_json: string | null;
  options_json: string;
  custom_direction: string;
  total: number;
}

export default {
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        if (msg.body.type === "extract") {
          await handleExtract(env, msg.body.jobId, msg);
        } else {
          await handleDescribe(env, msg.body.jobId, msg.body.rowIndex, msg);
        }
      } catch (err) {
        // Ej AllProvidersExhausted (hanteras separat nedan, med retry) — ett
        // oväntat fel ska inte kunna fastna i en oändlig kö-retry-loop.
        console.error(`jobId=${msg.body.jobId} type=${msg.body.type} misslyckades:`, err);
        msg.ack();
      }
    }
  },
};

async function getJob(env: Env, jobId: string): Promise<JobRow | null> {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<JobRow>();
}

function retryDelay(resumeAt: Date): number {
  return Math.max(1, Math.ceil((resumeAt.getTime() - Date.now()) / 1000));
}

async function handleExtract(env: Env, jobId: string, msg: Message<JobMessage>): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job) {
    msg.ack(); // jobbet finns inte längre (t.ex. raderat) — inget att göra
    return;
  }

  // Redan extraherat (t.ex. en tidigare AllProvidersExhausted-paus som nu
  // återupptas) — hoppa direkt till att fylla på saknade describe-meddelanden.
  if (job.rows_json) {
    await enqueueMissingDescribeMessages(env, job);
    return;
  }

  const chain = await buildChain(env, job.account_id);
  if (!chain) {
    await env.DB.prepare("UPDATE jobs SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?")
      .bind("Ingen AI-leverantör konfigurerad.", Date.now(), jobId)
      .run();
    msg.ack();
    return;
  }

  const obj = await env.UPLOADS.get(job.r2_key);
  if (!obj) {
    await env.DB.prepare("UPDATE jobs SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?")
      .bind("Den uppladdade filen hittades inte.", Date.now(), jobId)
      .run();
    msg.ack();
    return;
  }

  let extracted: ExtractedRows;
  try {
    extracted = await extractRows(job.filename, await obj.arrayBuffer(), chain);
  } catch (err) {
    if (err instanceof AllProvidersExhausted) {
      await env.DB.prepare("UPDATE jobs SET status = 'paused', updated_at = ? WHERE id = ?").bind(Date.now(), jobId).run();
      msg.retry({ delaySeconds: retryDelay(err.resumeAt) });
      return;
    }
    const message = err instanceof ExtractionError ? err.message : err instanceof Error ? err.message : String(err);
    await env.DB.prepare("UPDATE jobs SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?").bind(message, Date.now(), jobId).run();
    msg.ack();
    return;
  }

  await env.DB.prepare("UPDATE jobs SET status = 'processing', rows_json = ?, total = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(extracted), extracted.rows.length, Date.now(), jobId)
    .run();

  job.rows_json = JSON.stringify(extracted);
  job.total = extracted.rows.length;
  await enqueueMissingDescribeMessages(env, job);
  msg.ack();
}

async function enqueueMissingDescribeMessages(env: Env, job: JobRow): Promise<void> {
  const { rows } = JSON.parse(job.rows_json!) as ExtractedRows;
  const partial: Record<string, unknown> = job.partial_results_json ? JSON.parse(job.partial_results_json) : {};
  const pending = rows.map((_, i) => i).filter((i) => !(i in partial));
  if (pending.length === 0) {
    await maybeFinishJob(env, job.id);
    return;
  }
  await env.JOB_QUEUE.sendBatch(pending.map((rowIndex) => ({ body: { type: "describe", jobId: job.id, rowIndex } as JobMessage })));
}

async function handleDescribe(env: Env, jobId: string, rowIndex: number, msg: Message<JobMessage>): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job || !job.rows_json) {
    msg.ack(); // jobbet/raderna borttagna, eller extraktionen blev aldrig klar — inget att beskriva ännu
    return;
  }

  const { rows } = JSON.parse(job.rows_json) as ExtractedRows;
  const row = rows[rowIndex];
  if (!row) {
    msg.ack();
    return;
  }

  const chain = await buildChain(env, job.account_id);
  if (!chain) {
    msg.ack(); // konfigurationen togs bort under körning — inte meningsfullt att retrya
    return;
  }

  const options = JSON.parse(job.options_json || "{}");
  let result: { beskrivning: string; varför: string };
  try {
    const systemPrompt = buildSystemPrompt(options, job.custom_direction);
    result = await chain.generate(systemPrompt, userMessage(row.Site ?? "", row.Product ?? "", row["Price (SEK)"] ?? ""));
  } catch (err) {
    if (err instanceof AllProvidersExhausted) {
      msg.retry({ delaySeconds: retryDelay(err.resumeAt) });
      return;
    }
    console.error(`jobId=${jobId} rad=${rowIndex} misslyckades:`, err);
    result = { beskrivning: "", varför: "" }; // motsvarar Pythons do()-felhantering — räknas som klar, inte omförsökt i evighet
  }

  // Atomisk json_set istället för läs-ändra-skriv, eftersom flera
  // describe-meddelanden för SAMMA jobb körs parallellt (köns
  // max_concurrency) — annars riskerar samtidiga skrivningar att tappa
  // varandras resultat.
  await env.DB.prepare(
    "UPDATE jobs SET partial_results_json = json_set(COALESCE(partial_results_json, '{}'), '$.\"' || ? || '\"', json(?)), updated_at = ? WHERE id = ?",
  )
    .bind(String(rowIndex), JSON.stringify(result), Date.now(), jobId)
    .run();

  msg.ack();
  await maybeFinishJob(env, jobId);
}

// Motsvarar _finish_job() — men anropas av VARJE describe-handler efter att
// den skrivit sitt resultat; UPDATE ... WHERE status != 'done' garanterar
// att bara EN av dem faktiskt utför slutförandet även om flera råkar bli
// "den sista raden" samtidigt.
async function maybeFinishJob(env: Env, jobId: string): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job || !job.rows_json) return;

  const { rows, fieldnames } = JSON.parse(job.rows_json) as ExtractedRows;
  const partial: Record<string, { beskrivning: string; varför: string }> = job.partial_results_json ? JSON.parse(job.partial_results_json) : {};
  if (Object.keys(partial).length < rows.length) return; // inte alla rader klara än

  const outFields = [...fieldnames, "Beskrivning", "Varför"];
  const lines = [outFields.map(csvEscape).join(",")];
  let succeeded = 0;
  for (let i = 0; i < rows.length; i++) {
    const parts = partial[i] ?? { beskrivning: "", varför: "" };
    if (parts.beskrivning) succeeded++;
    const row: Record<string, string> = { ...rows[i], Beskrivning: parts.beskrivning, Varför: parts.varför };
    lines.push(outFields.map((f) => csvEscape(row[f] ?? "")).join(","));
  }
  const csv = lines.join("\r\n");

  const outputKey = `${job.account_id}/${jobId}_med_beskrivning.csv`;
  await env.UPLOADS.put(outputKey, csv, { httpMetadata: { contentType: "text/csv" } });

  const result = await env.DB.prepare("UPDATE jobs SET status = 'done', output_key = ?, succeeded = ?, updated_at = ? WHERE id = ? AND status != 'done'")
    .bind(outputKey, succeeded, Date.now(), jobId)
    .run();
  if (result.meta.changes > 0) {
    // Bara den invocation som faktiskt utförde övergången städar bort
    // mellanresultaten — annars riskerar en annan parallell invocation att
    // läsa rows_json/partial_results_json efter att de redan rensats.
    await env.DB.prepare("UPDATE jobs SET rows_json = NULL, partial_results_json = NULL WHERE id = ?").bind(jobId).run();
  }
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
