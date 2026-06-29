// Port av Flask-versionens github_report.py: rapporterar oväntade driftfel
// som en @claude-taggad GitHub-issue så att repots claude.yml-automation tar
// hand om dem, med samma saneringsregler och avdubblering.
//
// Skillnader mot Python-versionen, av runtime-skäl:
// - Ingen in-memory-throttle: Workers-isolat är kortlivade och delar inte
//   minne, så GitHub-sidans avdubblering (sök öppen issue med samma
//   fingeravtryck) är enda spärren — precis som Pythons avdubbling.
// - Stacktrace istället för traceback.format_exception (Error.stack).
//
// No-op om GITHUB_ERROR_REPORT_TOKEN saknas — felet loggas ändå till console
// av anroparen.

const SECRET_ENV_MARKERS = ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASS"];
const EMAIL_RE = /[\w.+-]{1,64}@[\w.-]{1,255}\.\w{2,24}/g;
const HOME_PATH_RE = /\/home\/[^/\s]+/g;
const KEY_PATTERN_RE =
  /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{12,}|Bearer\s+[A-Za-z0-9._-]{10,})/g;

export interface GitHubReportEnv {
  GITHUB_ERROR_REPORT_TOKEN?: string;
  // Övriga bindings/secrets — itereras för att maska hemlighetslika värden.
  [key: string]: unknown;
}

function redact(text: string, env: GitHubReportEnv): string {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.length >= 8 && SECRET_ENV_MARKERS.some((m) => key.toUpperCase().includes(m))) {
      text = text.split(value).join("[REDACTED]");
    }
  }
  text = text.replace(KEY_PATTERN_RE, "[REDACTED]");
  text = text.replace(EMAIL_RE, "[EMAIL REDACTED]");
  text = text.replace(HOME_PATH_RE, "/home/[user]");
  return text;
}

async function fingerprint(err: Error): Promise<string> {
  const firstFrame = (err.stack ?? "").split("\n")[1]?.trim() ?? "?";
  const data = new TextEncoder().encode(`${err.name}@${firstFrame}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

export async function reportErrorToGitHub(
  repo: string,
  title: string,
  err: unknown,
  env: GitHubReportEnv,
  context?: Record<string, string>,
): Promise<string | null> {
  const token = env.GITHUB_ERROR_REPORT_TOKEN;
  if (!token) return null;

  const error = err instanceof Error ? err : new Error(String(err));
  const fp = await fingerprint(error);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "product-describer",
  };

  try {
    const q = `repo:${repo} is:issue is:open in:title [${fp}]`;
    const search = await fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}`, { headers });
    if (search.ok) {
      const data = await search.json<{ total_count: number; items: { html_url: string }[] }>();
      if (data.total_count > 0) return data.items[0].html_url;
    }
  } catch {
    // avdubblering är best effort — fortsätt hellre rapportera än att tystna
  }

  const stack = redact(error.stack ?? `${error.name}: ${error.message}`, env);
  let contextText = "";
  if (context && Object.keys(context).length > 0) {
    const safe = Object.entries(context)
      .map(([k, v]) => `${k}: ${redact(String(v), env)}`)
      .join("\n");
    contextText = `\n\n**Kontext:**\n\`\`\`\n${safe}\n\`\`\``;
  }

  const body =
    `@claude Ett oväntat fel inträffade i drift.\n\n` +
    `\`\`\`\n${stack}\n\`\`\`` +
    `${contextText}\n\n` +
    `_Automatiskt rapporterad av applikationen. Känslig information ` +
    `(API-nycklar, e-postadresser, sökvägar med användarnamn, ` +
    `filinnehåll) är borttagen innan denna issue skapades._`;

  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `[auto] ${title} [${fp}]`.slice(0, 250),
        body,
        labels: ["bug", "auto-reported"],
      }),
    });
    if (resp.status === 201) {
      const data = await resp.json<{ html_url: string }>();
      return data.html_url;
    }
  } catch {
    // best effort
  }
  return null;
}
