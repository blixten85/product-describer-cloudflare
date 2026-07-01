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
  await Promise.all([loadSettings(), loadJobs(), loadBistand()]);
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

// ── Bistånds-underlag ─────────────────────────────────────────────────────

function formatPrice(kr) {
  return kr == null ? "—" : `${kr.toLocaleString("sv-SE")} kr`;
}

async function searchCatalog() {
  const q = document.getElementById("catalog-q").value;
  const results = await api(`/api/catalog?q=${encodeURIComponent(q)}`);
  const inBistand = new Set(currentBistand.map((r) => r.id));
  const list = document.getElementById("catalog-results");
  list.innerHTML = "";
  for (const p of results) {
    const li = document.createElement("li");
    li.className = "catalog-row";
    const info = document.createElement("span");
    info.innerHTML = `<strong>${escapeHtml(p.title ?? "(namnlös)")}</strong> — ${formatPrice(p.current_price)}`;
    li.appendChild(info);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-btn";
    if (inBistand.has(p.id)) {
      btn.textContent = "✓ Tillagd";
      btn.disabled = true;
    } else {
      btn.textContent = "Lägg till";
      btn.onclick = async () => {
        await api("/api/bistand", { method: "POST", body: JSON.stringify({ product_id: p.id }) });
        await loadBistand();
        await searchCatalog();
      };
    }
    li.appendChild(btn);
    list.appendChild(li);
  }
}

let currentBistand = [];

async function loadBistand() {
  currentBistand = await api("/api/bistand");
  const list = document.getElementById("bistand-list");
  list.innerHTML = "";
  for (const r of currentBistand) {
    const li = document.createElement("li");
    li.className = "bistand-row";

    const head = document.createElement("div");
    head.className = "bistand-head";
    head.innerHTML = `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(r.title ?? "(namnlös)")}</strong></a> — ${formatPrice(r.current_price)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link-btn";
    remove.textContent = "Ta bort";
    remove.onclick = async () => {
      await api(`/api/bistand/${r.id}`, { method: "DELETE" });
      await loadBistand();
      await searchCatalog();
    };
    head.appendChild(remove);
    li.appendChild(head);

    const ta = document.createElement("textarea");
    ta.className = "motivation-input";
    ta.rows = 2;
    ta.placeholder = "Motivering — varför du behöver detta…";
    ta.value = r.motivation ?? "";
    ta.addEventListener("change", async () => {
      await api("/api/bistand", { method: "POST", body: JSON.stringify({ product_id: r.id, motivation: ta.value }) });
    });
    li.appendChild(ta);

    list.appendChild(li);
  }
}

document.getElementById("catalog-search-btn").addEventListener("click", searchCatalog);
document.getElementById("catalog-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); searchCatalog(); }
});

// Pollar jobblistan var 5s medan appen är synlig — motsvarar sidans
// tidigare polling i Flask-versionens index.html.
setInterval(() => {
  if (!document.getElementById("app-view").hidden) loadJobs();
}, 5000);

// ── Avdelningar (hamburgermeny) ───────────────────────────────────────────

function showDept(name) {
  for (const s of document.querySelectorAll(".dept")) s.hidden = s.id !== `dept-${name}`;
  document.getElementById("dept-drawer").hidden = true;
  if (name === "katalog" && !catalogLoaded) loadCatalog();
}

document.getElementById("hamburger-btn").addEventListener("click", () => {
  const d = document.getElementById("dept-drawer");
  d.hidden = !d.hidden;
});
for (const btn of document.querySelectorAll(".dept-link")) {
  btn.addEventListener("click", () => showDept(btn.dataset.dept));
}

// ── Katalog (Avd. B) ──────────────────────────────────────────────────────

let catalogLoaded = false;
const catState = { q: "", offset: 0 };
const CAT_PAGE = 30;

async function loadCatalog() {
  catalogLoaded = true;
  const rows = await api(`/api/catalog?q=${encodeURIComponent(catState.q)}&offset=${catState.offset}`);
  const list = document.getElementById("cat-results");
  list.innerHTML = "";
  for (const p of rows) {
    const li = document.createElement("li");
    li.className = "catalog-row";
    li.innerHTML = `<span><strong>${escapeHtml(p.title ?? "(namnlös)")}</strong> — ${formatPrice(p.current_price)}${p.description ? " ✓" : ""}</span>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-btn";
    btn.textContent = "Visa";
    btn.onclick = () => openProduct(p.id);
    li.appendChild(btn);
    list.appendChild(li);
  }
  document.getElementById("cat-prev").hidden = catState.offset === 0;
  document.getElementById("cat-next").hidden = rows.length < CAT_PAGE;
}

document.getElementById("cat-search-btn").addEventListener("click", () => {
  catState.q = document.getElementById("cat-q").value;
  catState.offset = 0;
  loadCatalog();
});
document.getElementById("cat-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); document.getElementById("cat-search-btn").click(); }
});
document.getElementById("cat-prev").addEventListener("click", () => {
  catState.offset = Math.max(0, catState.offset - CAT_PAGE);
  loadCatalog();
});
document.getElementById("cat-next").addEventListener("click", () => {
  catState.offset += CAT_PAGE;
  loadCatalog();
});

async function openProduct(id) {
  const modal = document.getElementById("product-modal");
  const body = document.getElementById("modal-body");
  body.innerHTML = "<p>Laddar…</p>";
  modal.hidden = false;
  let p;
  try {
    p = await api(`/api/produkt/${id}`);
  } catch (err) {
    body.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    return;
  }
  const priceRows = p.price_history.map((h) => `${formatPrice(h.price)}`).join(" → ") || "—";
  body.innerHTML = `
    <h2>${escapeHtml(p.title ?? "(namnlös)")}</h2>
    <p><strong>Pris:</strong> ${formatPrice(p.current_price)}</p>
    ${p.category ? `<p><strong>Kategori:</strong> ${escapeHtml(p.category)}</p>` : ""}
    <p><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Öppna produktsidan →</a></p>
    <p><strong>Prishistorik:</strong> ${escapeHtml(priceRows)}</p>
    <div id="desc-area"><strong>Beskrivning:</strong> <span id="desc-text">${p.description ? escapeHtml(p.description) : "<em>ingen ännu</em>"}</span></div>
  `;
  const descArea = document.getElementById("desc-area");
  if (!p.description) {
    const gen = document.createElement("button");
    gen.type = "button";
    gen.textContent = "Generera beskrivning";
    gen.onclick = async () => {
      gen.disabled = true; gen.textContent = "Genererar…";
      try {
        const r = await api(`/api/produkt/${id}/describe`, { method: "POST" });
        document.getElementById("desc-text").innerHTML = escapeHtml(r.beskrivning ?? "");
        gen.remove();
      } catch (err) {
        gen.disabled = false; gen.textContent = "Försök igen";
        const e = document.createElement("p"); e.className = "error"; e.textContent = err.message;
        descArea.appendChild(e);
      }
    };
    descArea.appendChild(document.createElement("br"));
    descArea.appendChild(gen);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Lägg till i underlag";
  add.onclick = async () => {
    add.disabled = true;
    try {
      await api("/api/bistand", { method: "POST", body: JSON.stringify({ product_id: id }) });
      add.textContent = "✓ Tillagd i underlag";
      if (typeof loadBistand === "function") loadBistand();
    } catch (err) {
      add.disabled = false; add.textContent = "Fel — försök igen";
    }
  };
  body.appendChild(add);
}

document.getElementById("modal-close").addEventListener("click", () => {
  document.getElementById("product-modal").hidden = true;
});
document.querySelector("#product-modal .modal-backdrop").addEventListener("click", () => {
  document.getElementById("product-modal").hidden = true;
});

(async function init() {
  try {
    await api("/api/status");
    showApp();
  } catch {
    // inte inloggad — auth-view visas redan som default
  }
})();
