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

let isAdmin = false;
let describeMode = "on-demand";
let hasOwnKey = false;

async function showApp(status) {
  document.getElementById("auth-view").hidden = true;
  document.getElementById("app-view").hidden = false;
  if (!status) { try { status = await api("/api/status"); } catch { status = null; } }
  isAdmin = (status && status.role === "admin") || false;
  describeMode = (status && status.describe_mode) || "on-demand";
  hasOwnKey = (status && status.has_own_key) || false;
  setupDescribeToggle();

  // Beskriv-verktyget (provider-nycklar/uppladdning/jobb) är bara för admin.
  const verktygLink = document.querySelector('.dept-link[data-dept="verktyg"]');
  if (verktygLink) verktygLink.hidden = !isAdmin;
  const adminLink = document.querySelector('.dept-link[data-dept="admin"]');
  if (adminLink) adminLink.hidden = !isAdmin;
  const tasks = [loadBistand()];
  if (isAdmin) tasks.push(loadSettings(), loadJobs());
  await Promise.all(tasks);

  // Icke-admin börjar i Katalog (verktygs-avdelningen är dold för dem).
  showDept(isAdmin ? "verktyg" : "katalog");
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
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    const descBadge = r.description ? '<span class="ok">✓ beskrivning</span>' : '<span class="muted">○ saknar beskrivning</span>';
    head.innerHTML = `<span><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(r.title ?? "(namnlös)")}</strong></a> — ${formatPrice(r.current_price)} · ${descBadge}</span>`;
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

  // Beskriv de produkter i underlaget som saknar beskrivning. I auto-läge körs
  // det direkt vid inläsning; annars via knapp.
  const missing = currentBistand.filter((r) => !r.description);
  const genWrap = document.getElementById("bistand-generate");
  genWrap.innerHTML = "";
  if (missing.length === 0) return;

  const status = document.createElement("p");
  status.className = "hint";
  genWrap.appendChild(status);

  if (describeMode === "auto") {
    await runDescribeMissing(missing, status);
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `Generera saknade beskrivningar (${missing.length})`;
    btn.onclick = () => { btn.disabled = true; runDescribeMissing(missing, status); };
    genWrap.insertBefore(btn, status);
  }
}

let describing = false;
async function runDescribeMissing(missing, statusEl) {
  if (describing) return;
  describing = true;
  let done = 0;
  for (const r of missing) {
    statusEl.textContent = `Genererar ${done + 1}/${missing.length}…`;
    try {
      await api(`/api/produkt/${r.id}/describe`, { method: "POST" });
      done++;
    } catch (err) {
      statusEl.textContent = `Stannade vid ${done}/${missing.length}: ${err.message}`;
      describing = false;
      await loadBistand();
      return;
    }
  }
  statusEl.textContent = `Klart — ${done} beskrivningar genererade.`;
  describing = false;
  await loadBistand();
}

// Auto-läget: bara tillåtet med egen API-nyckel (eller admin), annars skulle det
// tära på operatörens delade kvot. Annars låst med förklaring.
function setupDescribeToggle() {
  const toggle = document.getElementById("describe-auto-toggle");
  const hint = document.getElementById("describe-auto-hint");
  const allowed = hasOwnKey || isAdmin;
  toggle.checked = describeMode === "auto";
  toggle.disabled = !allowed;
  hint.textContent = allowed
    ? "På: beskrivningar genereras automatiskt för produkter i underlaget. Av: du trycker på knappen själv."
    : "Kräver en egen API-nyckel (annars används on-demand). Lägg till en nyckel för att aktivera.";
  toggle.onchange = async () => {
    const mode = toggle.checked ? "auto" : "on-demand";
    try {
      await api("/api/describe-mode", { method: "POST", body: JSON.stringify({ mode }) });
      describeMode = mode;
      if (mode === "auto") await loadBistand();
    } catch (err) {
      toggle.checked = !toggle.checked;
    }
  };
}

document.getElementById("catalog-search-btn").addEventListener("click", searchCatalog);
document.getElementById("catalog-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); searchCatalog(); }
});

// Pollar jobblistan var 5s medan appen är synlig — motsvarar sidans
// tidigare polling i Flask-versionens index.html. Bara för admin: /api/jobs är
// admin-only, så en poll för vanliga konton gav bara 403 var 5:e sekund.
setInterval(() => {
  if (isAdmin && !document.getElementById("app-view").hidden) loadJobs();
}, 5000);

// ── Avdelningar (hamburgermeny) ───────────────────────────────────────────

function showDept(name) {
  for (const s of document.querySelectorAll(".dept")) s.hidden = s.id !== `dept-${name}`;
  document.getElementById("dept-drawer").hidden = true;
  if (name === "katalog" && !catalogLoaded) { loadCategories(); loadCatalog(); }
  if (name === "bevakning") { loadWatches(); loadChannels(); }
  if (name === "forslag") loadSuggestions();
  if (name === "admin") loadAdmin();
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
const catState = { q: "", offset: 0, category: "" };
const CAT_PAGE = 30;

let catRows = [];

// Liten åtgärdsknapp som postar och visar bock vid lyckat.
function quickBtn(label, doneLabel, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "link-btn";
  b.textContent = label;
  b.onclick = async () => {
    b.disabled = true;
    try { await fn(); b.textContent = doneLabel; } catch { b.disabled = false; b.textContent = "Fel"; }
  };
  return b;
}

async function loadCatalog() {
  catalogLoaded = true;
  catRows = await api(`/api/catalog?q=${encodeURIComponent(catState.q)}&offset=${catState.offset}&category=${encodeURIComponent(catState.category)}`);
  const list = document.getElementById("cat-results");
  list.innerHTML = "";
  for (const p of catRows) {
    const li = document.createElement("li");
    li.className = "catalog-row";
    const info = document.createElement("span");
    info.innerHTML = `<strong>${escapeHtml(p.title ?? "(namnlös)")}</strong> — ${formatPrice(p.current_price)}${p.description ? " ✓" : ""}`;
    li.appendChild(info);
    const actions = document.createElement("span");
    actions.className = "cat-actions";
    const view = document.createElement("button");
    view.type = "button"; view.className = "link-btn"; view.textContent = "Visa";
    view.onclick = () => openProduct(p.id);
    actions.appendChild(view);
    actions.appendChild(quickBtn("+ Underlag", "✓", () => api("/api/bistand", { method: "POST", body: JSON.stringify({ product_id: p.id }) })));
    actions.appendChild(quickBtn("★ Bevaka", "✓", () => api("/api/watch", { method: "POST", body: JSON.stringify({ product_id: p.id }) })));
    li.appendChild(actions);
    list.appendChild(li);
  }
  document.getElementById("cat-prev").hidden = catState.offset === 0;
  document.getElementById("cat-next").hidden = catRows.length < CAT_PAGE;
}

// Bulk: importera alla produkter på nuvarande sida till underlag eller bevakning.
async function bulkImport(path) {
  const btnMsg = document.getElementById("cat-bulk-msg");
  let done = 0;
  for (const p of catRows) {
    try { await api(path, { method: "POST", body: JSON.stringify({ product_id: p.id }) }); done++; } catch {}
    btnMsg.textContent = `Lade till ${done}/${catRows.length}…`;
  }
  btnMsg.textContent = `Klart — ${done} tillagda.`;
  if (path === "/api/bistand" && typeof loadBistand === "function") loadBistand();
}
document.getElementById("cat-bulk-underlag").addEventListener("click", () => bulkImport("/api/bistand"));
document.getElementById("cat-bulk-bevaka").addEventListener("click", () => bulkImport("/api/watch"));

async function loadCategories() {
  const cats = await api("/api/categories");
  const sel = document.getElementById("cat-category");
  sel.innerHTML = '<option value="">Alla kategorier</option>';
  for (const c of cats) {
    const o = document.createElement("option");
    o.value = c.category;
    o.textContent = `${c.category} (${c.n})`;
    sel.appendChild(o);
  }
  sel.value = catState.category;
}
document.getElementById("cat-category").addEventListener("change", (e) => {
  catState.category = e.target.value;
  catState.offset = 0;
  loadCatalog();
});
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

  const watch = document.createElement("button");
  watch.type = "button";
  watch.textContent = "Bevaka pris";
  watch.onclick = async () => {
    watch.disabled = true;
    try {
      await api("/api/watch", { method: "POST", body: JSON.stringify({ product_id: id }) });
      watch.textContent = "✓ Bevakas";
    } catch (err) {
      watch.disabled = false; watch.textContent = "Fel — försök igen";
    }
  };
  body.appendChild(watch);
}

// ── Prisbevakning ─────────────────────────────────────────────────────────

async function loadWatches() {
  const rows = await api("/api/watch");
  const list = document.getElementById("watch-list");
  list.innerHTML = rows.length ? "" : '<li class="hint">Inga bevakade produkter än.</li>';
  for (const r of rows) {
    const li = document.createElement("li");
    li.className = "catalog-row";
    li.innerHTML = `<span><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title ?? "(namnlös)")}</a> — ${formatPrice(r.current_price)}</span>`;
    const rm = document.createElement("button");
    rm.type = "button"; rm.className = "link-btn"; rm.textContent = "Sluta bevaka";
    rm.onclick = async () => { await api(`/api/watch/${r.id}`, { method: "DELETE" }); loadWatches(); };
    li.appendChild(rm);
    list.appendChild(li);
  }
}

async function loadChannels() {
  const rows = await api("/api/channels");
  const list = document.getElementById("channel-list");
  list.innerHTML = rows.length ? "" : '<li class="hint">Inga kanaler än.</li>';
  for (const c of rows) {
    const li = document.createElement("li");
    li.className = "catalog-row";
    const shown = c.target.length > 40 ? c.target.slice(0, 40) + "…" : c.target;
    li.innerHTML = `<span><strong>${escapeHtml(c.kind)}</strong> — ${escapeHtml(shown)}</span>`;
    const rm = document.createElement("button");
    rm.type = "button"; rm.className = "link-btn"; rm.textContent = "Ta bort";
    rm.onclick = async () => { await api(`/api/channels/${c.id}`, { method: "DELETE" }); loadChannels(); };
    li.appendChild(rm);
    list.appendChild(li);
  }
}

document.getElementById("channel-add-btn").addEventListener("click", async () => {
  const kind = document.getElementById("channel-kind").value;
  const target = document.getElementById("channel-target").value;
  const msg = document.getElementById("channel-msg");
  try {
    await api("/api/channels", { method: "POST", body: JSON.stringify({ kind, target }) });
    document.getElementById("channel-target").value = "";
    msg.textContent = "Kanal tillagd.";
    loadChannels();
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById("modal-close").addEventListener("click", () => {
  document.getElementById("product-modal").hidden = true;
});
document.querySelector("#product-modal .modal-backdrop").addEventListener("click", () => {
  document.getElementById("product-modal").hidden = true;
});

const oauthError = new URLSearchParams(location.search).get("error");
if (oauthError) {
  const msg = oauthError === "oauth_state" ? "Inloggningen avbröts (säkerhetskontroll). Försök igen." : "OAuth-inloggning misslyckades. Försök igen.";
  document.getElementById("login-msg").textContent = msg;
  history.replaceState(null, "", location.pathname);
}

// ── Sidförslag ────────────────────────────────────────────────────────────
document.getElementById("suggest-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("suggest-msg");
  const title = document.getElementById("suggest-title").value;
  const description = document.getElementById("suggest-desc").value;
  try {
    await api("/api/suggestions", { method: "POST", body: JSON.stringify({ title, description }) });
    e.target.reset();
    msg.textContent = "Tack! Ditt förslag har skickats för granskning.";
  } catch (err) {
    msg.textContent = err.message;
  }
});
async function loadSuggestions() {
  const card = document.getElementById("suggest-admin-card");
  if (!isAdmin) { card.hidden = true; return; }
  card.hidden = false;
  const rows = await api("/api/suggestions");
  const list = document.getElementById("suggest-list");
  list.innerHTML = rows.length ? "" : '<li class="hint">Inga förslag än.</li>';
  for (const r of rows) {
    const li = document.createElement("li");
    li.className = "bistand-row";
    const head = document.createElement("div");
    head.className = "bistand-head";
    head.innerHTML = `<span><strong>${escapeHtml(r.title)}</strong> — <span class="muted">${escapeHtml(r.status)}</span><br><small class="muted">${escapeHtml(r.email || "")}</small></span>`;
    li.appendChild(head);
    if (r.description) {
      const d = document.createElement("p");
      d.className = "hint";
      d.textContent = r.description;
      li.appendChild(d);
    }
    const actions = document.createElement("div");
    actions.className = "cat-actions";
    for (const st of ["approved", "rejected", "coded"]) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "link-btn"; b.textContent = st;
      b.onclick = async () => { await api(`/api/suggestions/${r.id}`, { method: "PATCH", body: JSON.stringify({ status: st }) }); loadSuggestions(); };
      actions.appendChild(b);
    }
    li.appendChild(actions);
    list.appendChild(li);
  }
}
// ── Admin-panel ───────────────────────────────────────────────────────────

const STAT_LABELS = [
  ["accounts.total", "Konton"],
  ["accounts.new_30d", "Nya konton (30 d)"],
  ["products.total", "Produkter"],
  ["products.described", "Med beskrivning"],
  ["products.with_source", "Med källtext"],
  ["price_points", "Prispunkter"],
  ["watches", "Bevakningar"],
  ["channels", "Larmkanaler"],
  ["bistand", "Underlagsposter"],
  ["sites_enabled", "Aktiva sajter"],
];

function statValue(stats, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), stats) ?? 0;
}

function statusLine(map, labels) {
  return Object.entries(map || {})
    .map(([k, n]) => `${labels[k] ?? k}: ${n}`)
    .join(" · ") || "—";
}

// Enkel SVG-stapelgraf. Fyller ut dagar utan datapunkter med 0 så att
// tidsaxeln blir jämn.
function barChart(el, points, days) {
  const byDay = Object.fromEntries((points || []).map((p) => [p.d, p.n]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push({ d, n: byDay[d] ?? 0 });
  }
  const W = 640, H = 110, pad = 1.5;
  const max = Math.max(...series.map((p) => p.n), 1);
  const bw = W / series.length;
  const bars = series
    .map((p, i) => {
      const h = Math.max(p.n > 0 ? 2 : 0, Math.round((p.n / max) * (H - 14)));
      return `<rect x="${(i * bw + pad).toFixed(1)}" y="${H - h}" width="${(bw - 2 * pad).toFixed(1)}" height="${h}"><title>${p.d}: ${p.n}</title></rect>`;
    })
    .join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart">${bars}</svg><div class="chart-axis"><span>${series[0].d}</span><span>max ${max}</span><span>${series[series.length - 1].d}</span></div>`;
}

async function loadAdmin() {
  let stats;
  try {
    stats = await api("/api/admin/stats");
  } catch (err) {
    document.getElementById("admin-stats").innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const grid = document.getElementById("admin-stats");
  grid.innerHTML = "";
  for (const [path, label] of STAT_LABELS) {
    const box = document.createElement("div");
    box.className = "stat-box";
    box.innerHTML = `<span class="n">${Number(statValue(stats, path)).toLocaleString("sv-SE")}</span><span class="l">${label}</span>`;
    grid.appendChild(box);
  }
  document.getElementById("admin-stat-lines")?.remove();
  const lines = document.createElement("div");
  lines.id = "admin-stat-lines";
  lines.className = "stat-lines hint";
  lines.innerHTML = [
    `<strong>Jobb:</strong> ${escapeHtml(statusLine(stats.jobs, STATUS_LABELS))}`,
    `<strong>Render-kö:</strong> ${escapeHtml(statusLine(stats.render_jobs, { pending: "Väntar", leased: "Pågår", done: "Klara", error: "Fel" }))}`,
    `<strong>Förslag:</strong> ${escapeHtml(statusLine(stats.suggestions, { pending: "Väntar", approved: "Godkända", rejected: "Avslagna", coded: "Kodade" }))}`,
  ].join("<br>");
  grid.after(lines);

  barChart(document.getElementById("chart-accounts"), stats.series.accounts_30d, 30);
  barChart(document.getElementById("chart-descriptions"), stats.series.descriptions_30d, 30);
  barChart(document.getElementById("chart-prices"), stats.series.price_points_14d, 14);

  await loadAdminAccounts();
}

async function loadAdminAccounts() {
  const rows = await api("/api/admin/accounts");
  const tbody = document.getElementById("admin-accounts");
  tbody.innerHTML = "";
  for (const a of rows) {
    const tr = document.createElement("tr");
    const created = new Date(a.created_at).toISOString().slice(0, 10);
    tr.innerHTML = `<td>${escapeHtml(a.email)}</td><td>${escapeHtml(a.role)}</td><td>${created}</td><td>${a.jobs}</td><td>${a.watches}</td><td>${a.bistand}</td>`;
    const td = document.createElement("td");
    const newRole = a.role === "admin" ? "user" : "admin";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-btn";
    btn.textContent = newRole === "admin" ? "Gör till admin" : "Gör till user";
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/api/admin/accounts/${a.id}/role`, { method: "POST", body: JSON.stringify({ role: newRole }) });
        loadAdminAccounts();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = err.message;
      }
    };
    td.appendChild(btn);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

(async function init() {
  try {
    const status = await api("/api/status");
    showApp(status);
  } catch {
    // inte inloggad — auth-view visas redan som default
  }
})();
