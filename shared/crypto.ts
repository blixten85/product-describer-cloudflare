// Kryptering för mail_credentials.encrypted_password (AES-GCM) och
// lösenordshashning för accounts (PBKDF2) — allt via Web Crypto, ingen
// extern dependency (fungerar nativt i Workers-runtimen).

// Workers' WebCrypto-implementation tillåter max 100 000 PBKDF2-iterationer
// (verifierat i produktion 2026-06-22 — högre värden ger ett runtime-fel).
const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return { hash: toBase64(hash), salt: toBase64(salt) };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const computed = await pbkdf2(password, fromBase64(salt));
  return toBase64(computed) === hash;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
}

// AES-GCM-kryptering av SMTP-lösenord. Nyckeln kommer från Wrangler secret
// MAIL_CRED_KEY (32 random bytes, base64), satt en gång per miljö.
export async function encryptSecret(plaintext: string, base64Key: string): Promise<string> {
  const key = await importAesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  // iv + ciphertext, base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return toBase64(combined);
}

export async function decryptSecret(encoded: string, base64Key: string): Promise<string> {
  const key = await importAesKey(base64Key);
  const combined = fromBase64(encoded);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(base64Key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomId(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)))
    .replace(/[+/=]/g, "")
    .slice(0, 22);
}

export function randomVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// API-nycklar är hög-entropi slumptokens, inte mänskliga lösenord — vanlig
// snabb SHA-256 räcker (samma praxis som GitHub/Stripe), ingen PBKDF2 behövs.
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = toBase64(bytes).replace(/[+/=]/g, "");
  return `pwapi_${token}`;
}
