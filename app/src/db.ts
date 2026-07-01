import { randomId } from "../../shared/crypto";

export type JobMessage = { type: "extract"; jobId: string } | { type: "describe"; jobId: string; rowIndex: number };

export interface Env {
  DB: D1Database;
  UPLOADS: R2Bucket;
  SESSIONS: KVNamespace;
  PROVIDER_CONFIG_KEY: string;
  JOB_QUEUE: Queue<JobMessage>;
  GITHUB_ERROR_REPORT_TOKEN?: string;
  // Avd. B: on-demand-beskrivning proxas till engine-Workern.
  ENGINE_URL?: string;
  INGEST_API_KEY?: string;
}

export interface Account {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  created_at: number;
}

export async function getAccountByEmail(db: D1Database, email: string): Promise<Account | null> {
  return db.prepare("SELECT * FROM accounts WHERE email = ?").bind(email.trim().toLowerCase()).first();
}

export async function getAccountById(db: D1Database, id: string): Promise<Account | null> {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first();
}

export async function createAccount(
  db: D1Database,
  fields: { email: string; passwordHash: string; passwordSalt: string },
): Promise<string> {
  const id = randomId();
  await db
    .prepare("INSERT INTO accounts (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, fields.email.trim().toLowerCase(), fields.passwordHash, fields.passwordSalt, Date.now())
    .run();
  return id;
}

// Motsvarar jobs.json-listan i app.py — men en D1-rad per jobb istället för
// en delad JSON-fil (slipper _lock/_save-mönstret, D1 hanterar samtidighet).
export interface Job {
  id: string;
  account_id: string;
  status: string;
  filename: string;
  r2_key: string;
  output_key: string | null;
  options_json: string;
  custom_direction: string;
  total: number;
  succeeded: number;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export async function createJob(
  db: D1Database,
  fields: {
    id: string;
    accountId: string;
    filename: string;
    r2Key: string;
    options: { tone?: string; length?: string; audience?: string };
    customDirection: string;
  },
): Promise<string> {
  const { id } = fields;
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO jobs (id, account_id, status, filename, r2_key, options_json, custom_direction, created_at, updated_at) " +
        "VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, fields.accountId, fields.filename, fields.r2Key, JSON.stringify(fields.options), fields.customDirection, now, now)
    .run();
  return id;
}

export async function getJobsForAccount(db: D1Database, accountId: string): Promise<Job[]> {
  const { results } = await db
    .prepare("SELECT * FROM jobs WHERE account_id = ? ORDER BY created_at DESC")
    .bind(accountId)
    .all<Job>();
  return results;
}

export async function getJob(db: D1Database, jobId: string): Promise<Job | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<Job>();
}
