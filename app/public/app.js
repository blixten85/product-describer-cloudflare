async function api(path, options = {}) {
  const resp = await fetch(path, {
    ...options,
    headers: { ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `Fel (${resp.status})`);
  return data;
}

// ── Auth ─────────────────────────────────────────────────────────────────

document.getElementById("toggle-auth-btn").addEventListener("click", () => {
  const login = document.getElementById("login-form");
  const signup = document.getElementById("signup-form");
  const btn = document.getElementById("toggle-auth-btn");
  const showingSignup = !signup.hidden;
  login.hidden = showingSignup;
  signup.hidden = !showingSignup;
  btn.textContent = showingSignup ? "Inget konto? Registrera dig" : "Har du redan ett konto? Logga in";
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api("/login", { method: "POST", body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
    showApp();
  } catch (err) {
    document.getElementById("login-msg").textContent = err.message;
  }
});

document.getElementById("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api("/signup", { method: "POST", body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
    showApp();
  } catch (err) {
    document.getElementById("signup-msg").textContent = err.message;
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/logout", { method: "POST" });
  document.getElementById("app-view").hidden = true;
  document.getElementById("auth-view").hidden = false;
});

async function showApp() {
  document.getElementById("auth-view").hidden = true;
  document.getElementById("app-view").hidden = false;
  await Promise.all([loadSettings(), loadJobs()]);
}

// ── Inställningar ────────────────────────────────────────────────────────

const PROVIDER_NAMES = ["anthropic", "openai", "gemini", "azure_openai"];
let settingsCache = null;

async function loadSettings() {
  const data = await api("/api/settings");
  settingsCache = data;
  renderProviderList(data);
  renderProviderSelect(data);
}

function renderProviderList(data) {
  const div = document.getElementById("provider-list");
  div.innerHTML = "";
  for (const name of PROVIDER_NAMES) {
    const row = document.createElement("div");
    row.className = "provider-row";
    const configured = data.configured.includes(name);
    row.innerHTML = `<span>${data.labels[name]}</span><span class="${configured ? "ok" : "muted"}">${configured ? "✓ Konfigurerad" : "Inte konfigurerad"}</span>`;
    if (configured) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "link-btn";
      removeBtn.textContent = "Ta bort";
      removeBtn.onclick = async () => {
        await api(`/api/settings/key/${name}`, { method: "DELETE" });
        loadSettings();
      };
      row.appendChild(removeBtn);
    }
    div.appendChild(row);
  }
}

function renderProviderSelect(data) {
  const select = document.getElementById("provider-select");
  select.innerHTML = "";
  for (const name of PROVIDER_NAMES) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = data.labels[name];
    select.appendChild(opt);
  }
  renderExtraFields(data);
}

document.getElementById("provider-select").addEventListener("change", () => renderExtraFields(settingsCache));

function renderExtraFields(data) {
  const provider = document.getElementById("provider-select").value;
  const div = document.getElementById("extra-fields");
  div.innerHTML = "";
  for (const field of data.extra_fields[provider] ?? []) {
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.field = field.name;
    input.placeholder = field.label;
    input.value = data.extra_values[provider]?.[field.name] ?? "";
    div.appendChild(input);
  }
}

document.getElementById("save-key-btn").addEventListener("click", async () => {
  const provider = document.getElementById("provider-select").value;
  const apiKey = document.getElementById("api-key-input").value;
  const body = { provider, api_key: apiKey };
  for (const input of document.querySelectorAll("#extra-fields input")) {
    body[input.dataset.field] = input.value;
  }
  const msg = document.getElementById("settings-msg");
  try {
    await api("/api/settings/key", { method: "POST", body: JSON.stringify(body) });
    document.getElementById("api-key-input").value = "";
    msg.textContent = "Sparat.";
    loadSettings();
  } catch (err) {
    msg.textContent = err.message;
  }
});

// ── Uppladdning ──────────────────────────────────────────────────────────

document.getElementById("upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("file-input");
  const msg = document.getElementById("upload-msg");
  if (!fileInput.files[0]) return;

  const form = new FormData(e.target);
  form.set("file", fileInput.files[0]);

  const submitBtn = document.getElementById("upload-submit-btn");
  submitBtn.disabled = true;
  try {
    await api("/api/upload", { method: "POST", body: form });
    msg.textContent = "";
    e.target.reset();
    loadJobs();
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

// ── Jobb ─────────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  queued: "I kö",
  processing: "Bearbetar",
  paused: "Pausad (väntar på AI-leverantör)",
  done: "Klar",
  error: "Fel",
};

async function loadJobs() {
  const jobs = await api("/api/jobs");
  const list = document.getElementById("jobs-list");
  list.innerHTML = "";
  for (const job of jobs) {
    const li = document.createElement("li");
    li.className = "job-row";
    const progress = job.total > 0 ? ` (${job.succeeded}/${job.total})` : "";
    li.innerHTML = `<strong>${escapeHtml(job.filename)}</strong> — ${STATUS_LABELS[job.status] ?? job.status}${progress}`;
    if (job.status === "done") {
      const a = document.createElement("a");
      a.href = `/api/jobs/${job.id}/download`;
      a.textContent = "Ladda ner";
      a.className = "link-btn";
      li.appendChild(a);
    }
    if (job.status === "error" && job.error_message) {
      const span = document.createElement("p");
      span.className = "error";
      span.textContent = job.error_message;
      li.appendChild(span);
    }
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Pollar jobblistan var 5s medan appen är synlig — motsvarar sidans
// tidigare polling i Flask-versionens index.html.
setInterval(() => {
  if (!document.getElementById("app-view").hidden) loadJobs();
}, 5000);

(async function init() {
  try {
    await api("/api/status");
    showApp();
  } catch {
    // inte inloggad — auth-view visas redan som default
  }
})();
