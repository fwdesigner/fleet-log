/* Fleet Log frontend — talks to the Express/SQLite backend over the REST API
   defined in server.js. No Firebase, no third-party service: this page and
   that server are the whole system. */

let state = { config: { travellers: [], vehicles: [], places: [], tripTypes: [], fuelTypes: [] }, pinSet: false };
let schedule = { rows: [], locked: false, summary: null };
let fuel = { rows: [], locked: false, summary: null };
let service = { rows: [], locked: false, summary: null };
let reportsSummary = null;
let scheduleDays = [], fuelMonths = [], serviceMonths = [];
let customReport = null;

let activeTab = "schedule";
let selDate = todayISO();
let selMonth = monthKey();
let token = localStorage.getItem("fleetlog_token") || null;
let pollTimer = null;

/* ---------------- API helper ---------------- */
async function api(method, url, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Request failed");
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ---------------- helpers ---------------- */
function todayISO() { return new Date().toISOString().slice(0, 10); }
function monthKey(dateStr) { const d = dateStr ? new Date(dateStr + "T00:00:00") : new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
function prettyDate(iso) { try { const d = new Date(iso + "T00:00:00"); return d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" }); } catch (e) { return iso; } }
function prettyMonth(key) { try { const [y, m] = key.split("-"); const d = new Date(parseInt(y), parseInt(m) - 1, 1); return d.toLocaleDateString(undefined, { month: "long", year: "numeric" }); } catch (e) { return key; } }
function escapeAttr(str) { return String(str || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function escapeHTML(str) { return escapeAttr(str); }
function canEdit() { return !state.pinSet || !!token; }

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove("show"), 2800);
}
function setSaveState(mode) {
  const el = document.getElementById("save-indicator");
  if (!el) return;
  el.className = "save-state " + mode;
  el.querySelector("span").textContent = mode === "saving" ? "Saving…" : mode === "error" ? "Save failed" : "Saved";
}

/* ---------------- init & polling ---------------- */
window.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    await loadConfig();
    await Promise.all([loadSchedule(selDate), loadFuel(selMonth), loadService(selMonth)]);
  } catch (e) {
    toast("Could not reach the server: " + e.message);
  }
  render();
  startPolling();
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      if (activeTab === "schedule") await loadSchedule(selDate, { silent: true });
      else if (activeTab === "fuel") await loadFuel(selMonth, { silent: true });
      else if (activeTab === "service") await loadService(selMonth, { silent: true });
      else if (activeTab === "config") await loadConfig({ silent: true });
    } catch (e) { /* transient network hiccup — ignore, next tick retries */ }
  }, 4000);
}

/* ---------------- data loaders ---------------- */
async function loadConfig(opts) {
  const data = await api("GET", "/api/config");
  state.config = { travellers: data.travellers, vehicles: data.vehicles, places: data.places, tripTypes: data.tripTypes, fuelTypes: data.fuelTypes };
  state.pinSet = data.pinSet;
  if (!(opts && opts.silent)) return;
  if (activeTab === "config" || activeTab === "schedule" || activeTab === "fuel" || activeTab === "service") render();
}
async function loadSchedule(date, opts) {
  const data = await api("GET", "/api/schedule/" + encodeURIComponent(date));
  schedule = data;
  if (!(opts && opts.silent) || activeTab === "schedule") renderSchedule();
}
async function loadFuel(month, opts) {
  const data = await api("GET", "/api/fuel/" + encodeURIComponent(month));
  fuel = data;
  if (!(opts && opts.silent) || activeTab === "fuel") renderFuel();
}
async function loadService(month, opts) {
  const data = await api("GET", "/api/service/" + encodeURIComponent(month));
  service = data;
  if (!(opts && opts.silent) || activeTab === "service") renderService();
}

/* ---------------- edit gate ---------------- */
async function tryUnlock() {
  const entered = window.prompt("Enter the edit PIN to make changes:");
  if (entered === null) return;
  try {
    const res = await api("POST", "/api/auth/unlock", { pin: entered });
    token = res.token; localStorage.setItem("fleetlog_token", token);
    toast("Unlocked — you can edit on this device now");
    render();
  } catch (e) { toast(e.message); }
}
function lockDevice() {
  token = null; localStorage.removeItem("fleetlog_token");
  toast("This device is now view-only");
  render();
}
function viewOnlyBanner() { return `<div class="lock-banner">👁 View only on this device. <button class="btn" style="padding:4px 10px;" onclick="tryUnlock()">Unlock to edit</button></div>`; }

/* ---------------- mutations ---------------- */
async function addScheduleRow(date) {
  try { const row = await api("POST", `/api/schedule/${encodeURIComponent(date)}/entries`, { traveller: "", vehicle: "", start: "", end: "", tripType: "", outTime: "", inTime: "", remark: "" }); schedule.rows.push(row); renderSchedule(); }
  catch (e) { toast("Could not add entry: " + e.message); }
}
async function updateScheduleField(id, field, value) {
  const row = schedule.rows.find((r) => r.id == id); if (row) row[field] = value;
  try { await api("PATCH", `/api/schedule/entries/${id}`, { field, value }); }
  catch (e) { toast("Could not save change: " + e.message); }
}
async function deleteScheduleRow(id) {
  schedule.rows = schedule.rows.filter((r) => r.id != id); renderSchedule();
  try { await api("DELETE", `/api/schedule/entries/${id}`); }
  catch (e) { toast("Could not delete: " + e.message); }
}
async function lockScheduleDay(date) {
  try { const res = await api("POST", `/api/schedule/${encodeURIComponent(date)}/lock`); schedule.locked = true; schedule.summary = res.summary; renderSchedule(); toast("Day locked — totals calculated."); }
  catch (e) { toast("Could not lock: " + e.message); }
}

async function addFuelRow(month) {
  try { const row = await api("POST", `/api/fuel/${encodeURIComponent(month)}/entries`, { date: todayISO(), traveller: "", vehicle: "", fuel: "", qty: "", price: "", remark: "" }); fuel.rows.push(row); renderFuel(); }
  catch (e) { toast("Could not add entry: " + e.message); }
}
async function updateFuelField(id, field, value) {
  const row = fuel.rows.find((r) => r.id == id); if (row) row[field] = value;
  renderFuel();
  try { await api("PATCH", `/api/fuel/entries/${id}`, { field, value }); }
  catch (e) { toast("Could not save change: " + e.message); }
}
async function deleteFuelRow(id) {
  fuel.rows = fuel.rows.filter((r) => r.id != id); renderFuel();
  try { await api("DELETE", `/api/fuel/entries/${id}`); }
  catch (e) { toast("Could not delete: " + e.message); }
}
async function lockFuelMonth(month) {
  try { const res = await api("POST", `/api/fuel/${encodeURIComponent(month)}/lock`); fuel.locked = true; fuel.summary = res.summary; renderFuel(); toast("Month locked — totals calculated."); }
  catch (e) { toast("Could not lock: " + e.message); }
}

async function addServiceRow(month) {
  try { const row = await api("POST", `/api/service/${encodeURIComponent(month)}/entries`, { givenDate: todayISO(), receivedDate: "", traveller: "", vehicle: "", remark: "", cost: "" }); service.rows.push(row); renderService(); }
  catch (e) { toast("Could not add entry: " + e.message); }
}
async function updateServiceField(id, field, value) {
  const row = service.rows.find((r) => r.id == id); if (row) row[field] = value;
  try { await api("PATCH", `/api/service/entries/${id}`, { field, value }); }
  catch (e) { toast("Could not save change: " + e.message); }
}
async function deleteServiceRow(id) {
  service.rows = service.rows.filter((r) => r.id != id); renderService();
  try { await api("DELETE", `/api/service/entries/${id}`); }
  catch (e) { toast("Could not delete: " + e.message); }
}
async function lockServiceMonth(month) {
  try { const res = await api("POST", `/api/service/${encodeURIComponent(month)}/lock`); service.locked = true; service.summary = res.summary; renderService(); toast("Month locked — totals calculated."); }
  catch (e) { toast("Could not lock: " + e.message); }
}

async function addConfigItem(key, value) {
  if (state.config[key].includes(value)) return;
  state.config[key] = [...state.config[key], value]; renderConfig();
  try { await api("POST", `/api/config/${key}`, { value }); }
  catch (e) { toast("Could not add: " + e.message); await loadConfig(); renderConfig(); }
}
async function removeConfigItem(key, value) {
  state.config[key] = state.config[key].filter((v) => v !== value); renderConfig();
  try { await api("DELETE", `/api/config/${key}/${encodeURIComponent(value)}`); }
  catch (e) { toast("Could not remove: " + e.message); await loadConfig(); renderConfig(); }
}

/* ---------------- render shell ---------------- */
function render() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <header class="top">
      <div class="brand"><h1>Fleet Log</h1><span class="tag">v4</span></div>
      <div class="status-cluster">
        <span class="access-pill ${canEdit() ? "editor" : "viewer"}" onclick="${canEdit() ? "lockDevice()" : "tryUnlock()"}">${canEdit() ? "✎ Can edit" : "👁 View only"}</span>
        <div class="save-state saved" id="save-indicator"><span class="dot"></span><span>Saved</span></div>
      </div>
    </header>
    <nav class="tabs">
      ${tabBtn("schedule", "Travel Schedule")}
      ${tabBtn("fuel", "Fuel")}
      ${tabBtn("service", "Service")}
      ${tabBtn("config", "Travellers & Lists")}
      ${tabBtn("reports", "Reports")}
      ${tabBtn("setup", "Setup")}
    </nav>
    <section class="view ${activeTab === "schedule" ? "active" : ""}" id="view-schedule"></section>
    <section class="view ${activeTab === "fuel" ? "active" : ""}" id="view-fuel"></section>
    <section class="view ${activeTab === "service" ? "active" : ""}" id="view-service"></section>
    <section class="view ${activeTab === "config" ? "active" : ""}" id="view-config"></section>
    <section class="view ${activeTab === "reports" ? "active" : ""}" id="view-reports"></section>
    <section class="view ${activeTab === "setup" ? "active" : ""}" id="view-setup"></section>
  `;
  document.querySelectorAll("nav.tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      activeTab = b.dataset.tab; render();
      if (activeTab === "reports") loadReportsTab();
    });
  });
  renderSchedule(); renderFuel(); renderService(); renderConfig(); renderReports(); renderSetup();
}
function tabBtn(id, label) { return `<button data-tab="${id}" class="${activeTab === id ? "active" : ""}">${label}</button>`; }
function selectHTML(field, id, options, value) {
  return `<select data-field="${field}" data-id="${id}">
    <option value=""></option>
    ${options.map((o) => `<option value="${escapeAttr(o)}" ${o === value ? "selected" : ""}>${o}</option>`).join("")}
  </select>`;
}

/* ================= SCHEDULE ================= */
function renderSchedule() {
  const el = document.getElementById("view-schedule");
  const editableNow = canEdit();
  const readOnly = schedule.locked || !editableNow;
  el.innerHTML = `
    <div class="panel">
      <h2>Travel Schedule</h2>
      <p class="sub">Pick a date, then add who's travelling. Lock the day once everyone's accounted for.</p>
      <div class="toolbar"><div class="picker"><label>Date</label><input type="date" id="sch-date" value="${selDate}"></div><button class="btn ghost" id="sch-today">Today</button></div>
      ${schedule.locked ? `<div class="lock-banner">🔒 ${prettyDate(selDate)} is locked. Totals below are final.</div>` : (!editableNow ? viewOnlyBanner() : "")}
      <div class="row-actions">
        <button class="btn primary" id="sch-add" ${readOnly ? "disabled" : ""}>+ Add entry</button>
        <button class="btn" id="sch-lock" ${readOnly || !schedule.rows.length ? "disabled" : ""}>Lock &amp; total this day</button>
        <button class="btn ghost" id="sch-print">Print / Save as PDF</button>
      </div>
      <div class="table-scroll"><table><thead><tr><th>Traveller</th><th>Vehicle</th><th>Start</th><th>End</th><th>Status</th><th>Out</th><th>In</th><th>Remark</th><th></th></tr></thead><tbody id="sch-body"></tbody></table></div>
      ${!schedule.rows.length ? `<div class="empty">No entries for ${prettyDate(selDate)} yet.</div>` : ""}
      ${schedule.summary ? renderScheduleSummary(schedule.summary) : ""}
    </div>
  `;
  const body = document.getElementById("sch-body");
  body.innerHTML = schedule.rows.map((r) => (readOnly ? scheduleRowStatic(r) : scheduleRowEdit(r))).join("");
  document.getElementById("sch-date").addEventListener("change", async (e) => { selDate = e.target.value || todayISO(); await loadSchedule(selDate); renderSchedule(); });
  document.getElementById("sch-today").addEventListener("click", async () => { selDate = todayISO(); await loadSchedule(selDate); renderSchedule(); });
  if (!readOnly) {
    document.getElementById("sch-add").onclick = () => addScheduleRow(selDate);
    body.querySelectorAll("[data-field]").forEach((inp) => inp.addEventListener("change", (e) => updateScheduleField(e.target.dataset.id, e.target.dataset.field, e.target.value)));
    body.querySelectorAll(".icon-btn").forEach((b) => b.addEventListener("click", () => deleteScheduleRow(b.dataset.id)));
  }
  const lockBtn = document.getElementById("sch-lock"); if (lockBtn) lockBtn.onclick = () => lockScheduleDay(selDate);
  document.getElementById("sch-print").onclick = () => printSchedule(selDate, schedule);
}
function scheduleRowEdit(r) {
  return `<tr>
    <td>${selectHTML("traveller", r.id, state.config.travellers, r.traveller)}</td>
    <td>${selectHTML("vehicle", r.id, state.config.vehicles, r.vehicle)}</td>
    <td>${selectHTML("start", r.id, state.config.places, r.start)}</td>
    <td>${selectHTML("end", r.id, state.config.places, r.end)}</td>
    <td>${selectHTML("tripType", r.id, state.config.tripTypes, r.tripType)}</td>
    <td><input type="time" data-field="outTime" data-id="${r.id}" value="${r.outTime || ""}"></td>
    <td><input type="time" data-field="inTime" data-id="${r.id}" value="${r.inTime || ""}"></td>
    <td><input type="text" data-field="remark" data-id="${r.id}" value="${escapeAttr(r.remark)}" placeholder="—"></td>
    <td><button class="icon-btn" data-id="${r.id}" title="Remove">✕</button></td>
  </tr>`;
}
function scheduleRowStatic(r) {
  return `<tr><td class="cell-text">${escapeHTML(r.traveller) || "—"}</td><td class="cell-text">${escapeHTML(r.vehicle) || "—"}</td><td class="cell-text">${escapeHTML(r.start) || "—"}</td><td class="cell-text">${escapeHTML(r.end) || "—"}</td><td class="cell-text">${escapeHTML(r.tripType) || "—"}</td><td class="cell-text">${escapeHTML(r.outTime) || "—"}</td><td class="cell-text">${escapeHTML(r.inTime) || "—"}</td><td class="cell-text">${escapeHTML(r.remark) || "—"}</td><td></td></tr>`;
}
function renderScheduleSummary(sum) {
  const rows = Object.entries(sum.people || {}).map(([n, v]) => `<tr><td>${escapeHTML(n)}</td><td class="num">${v.trip}</td><td class="num">${v.noTrip}</td></tr>`).join("");
  return `<div class="summary-grid">
      <div class="summary-card"><div class="label">Trips</div><div class="value">${sum.trip}</div></div>
      <div class="summary-card"><div class="label">No trip</div><div class="value">${sum.noTrip}</div></div>
      <div class="summary-card"><div class="label">Taxi</div><div class="value">${sum.taxi}</div></div>
    </div>
    <div class="detail-table table-scroll"><table><thead><tr><th>Traveller</th><th>Trip</th><th>No trip</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="empty">—</td></tr>'}</tbody></table></div>`;
}

/* ================= FUEL ================= */
function renderFuel() {
  const el = document.getElementById("view-fuel");
  const editableNow = canEdit();
  const readOnly = fuel.locked || !editableNow;
  el.innerHTML = `
    <div class="panel">
      <h2>Fuel Log</h2>
      <p class="sub">Pick a month, then track fills by traveller and vehicle. Subtotal is quantity × price, calculated automatically.</p>
      <div class="toolbar"><div class="picker"><label>Month</label><input type="month" id="fuel-month" value="${selMonth}"></div><button class="btn ghost" id="fuel-thismonth">This month</button></div>
      ${fuel.locked ? `<div class="lock-banner">🔒 ${prettyMonth(selMonth)} is locked. Totals below are final.</div>` : (!editableNow ? viewOnlyBanner() : "")}
      <div class="row-actions">
        <button class="btn primary" id="fuel-add" ${readOnly ? "disabled" : ""}>+ Add entry</button>
        <button class="btn" id="fuel-lock" ${readOnly || !fuel.rows.length ? "disabled" : ""}>Lock &amp; total this month</button>
        <button class="btn ghost" id="fuel-print">Print / Save as PDF</button>
      </div>
      <div class="table-scroll"><table><thead><tr><th>Date</th><th>Traveller</th><th>Vehicle</th><th>Fuel</th><th>Qty</th><th>Price</th><th>Subtotal</th><th>Remarks</th><th></th></tr></thead><tbody id="fuel-body"></tbody></table></div>
      ${!fuel.rows.length ? `<div class="empty">No fuel entries for ${prettyMonth(selMonth)} yet.</div>` : ""}
      ${fuel.summary ? renderFuelSummary(fuel.summary) : ""}
    </div>
  `;
  const body = document.getElementById("fuel-body");
  body.innerHTML = fuel.rows.map((r) => (readOnly ? fuelRowStatic(r) : fuelRowEdit(r))).join("");
  document.getElementById("fuel-month").addEventListener("change", async (e) => { selMonth = e.target.value || monthKey(); await loadFuel(selMonth); renderFuel(); });
  document.getElementById("fuel-thismonth").addEventListener("click", async () => { selMonth = monthKey(); await loadFuel(selMonth); renderFuel(); });
  if (!readOnly) {
    document.getElementById("fuel-add").onclick = () => addFuelRow(selMonth);
    body.querySelectorAll("[data-field]").forEach((inp) => inp.addEventListener("change", (e) => updateFuelField(e.target.dataset.id, e.target.dataset.field, e.target.value)));
    body.querySelectorAll(".icon-btn").forEach((b) => b.addEventListener("click", () => deleteFuelRow(b.dataset.id)));
  }
  const lockBtn = document.getElementById("fuel-lock"); if (lockBtn) lockBtn.onclick = () => lockFuelMonth(selMonth);
  document.getElementById("fuel-print").onclick = () => printFuel(selMonth, fuel);
}
function fuelRowEdit(r) {
  return `<tr>
    <td><input type="date" data-field="date" data-id="${r.id}" value="${r.date || ""}"></td>
    <td>${selectHTML("traveller", r.id, state.config.travellers, r.traveller)}</td>
    <td>${selectHTML("vehicle", r.id, state.config.vehicles, r.vehicle)}</td>
    <td>${selectHTML("fuel", r.id, state.config.fuelTypes, r.fuel)}</td>
    <td><input type="number" step="0.01" data-field="qty" data-id="${r.id}" value="${r.qty ?? ""}"></td>
    <td><input type="number" step="0.01" data-field="price" data-id="${r.id}" value="${r.price ?? ""}"></td>
    <td class="subtotal">${fuelSubtotal(r)}</td>
    <td><input type="text" data-field="remark" data-id="${r.id}" value="${escapeAttr(r.remark)}" placeholder="—"></td>
    <td><button class="icon-btn" data-id="${r.id}" title="Remove">✕</button></td>
  </tr>`;
}
function fuelRowStatic(r) { return `<tr><td class="cell-text">${r.date || "—"}</td><td class="cell-text">${escapeHTML(r.traveller) || "—"}</td><td class="cell-text">${escapeHTML(r.vehicle) || "—"}</td><td class="cell-text">${escapeHTML(r.fuel) || "—"}</td><td class="num">${r.qty ?? "—"}</td><td class="num">${r.price ?? "—"}</td><td class="subtotal">${fuelSubtotal(r)}</td><td class="cell-text">${escapeHTML(r.remark) || "—"}</td><td></td></tr>`; }
function fuelSubtotal(r) { const qty = parseFloat(r.qty) || 0, price = parseFloat(r.price) || 0; return (r.qty !== "" && r.qty != null && r.price !== "" && r.price != null) ? (qty * price).toFixed(2) : ""; }
function renderFuelSummary(sum) {
  const cards = state.config.fuelTypes.map((t) => { const v = (sum.totals || {})[t.toLowerCase()] || 0; return `<div class="summary-card"><div class="label">${escapeHTML(t)}</div><div class="value">${v.toFixed(2)}</div></div>`; }).join("");
  return `<div class="summary-grid"><div class="summary-card"><div class="label">Grand total</div><div class="value">${sum.grand.toFixed(2)}</div></div>${cards}</div>`;
}

/* ================= SERVICE ================= */
function renderService() {
  const el = document.getElementById("view-service");
  const editableNow = canEdit();
  const readOnly = service.locked || !editableNow;
  el.innerHTML = `
    <div class="panel">
      <h2>Service Log</h2>
      <p class="sub">Pick a month, then log vehicle maintenance — given/received dates and cost.</p>
      <div class="toolbar"><div class="picker"><label>Month</label><input type="month" id="svc-month" value="${selMonth}"></div><button class="btn ghost" id="svc-thismonth">This month</button></div>
      ${service.locked ? `<div class="lock-banner">🔒 ${prettyMonth(selMonth)} is locked. Totals below are final.</div>` : (!editableNow ? viewOnlyBanner() : "")}
      <div class="row-actions">
        <button class="btn primary" id="svc-add" ${readOnly ? "disabled" : ""}>+ Add entry</button>
        <button class="btn" id="svc-lock" ${readOnly || !service.rows.length ? "disabled" : ""}>Lock &amp; total this month</button>
        <button class="btn ghost" id="svc-print">Print / Save as PDF</button>
      </div>
      <div class="table-scroll"><table><thead><tr><th>Given</th><th>Received</th><th>Traveller</th><th>Vehicle</th><th>Remark</th><th>Cost</th><th></th></tr></thead><tbody id="svc-body"></tbody></table></div>
      ${!service.rows.length ? `<div class="empty">No service entries for ${prettyMonth(selMonth)} yet.</div>` : ""}
      ${service.summary ? renderServiceSummary(service.summary) : ""}
    </div>
  `;
  const body = document.getElementById("svc-body");
  body.innerHTML = service.rows.map((r) => (readOnly ? serviceRowStatic(r) : serviceRowEdit(r))).join("");
  document.getElementById("svc-month").addEventListener("change", async (e) => { selMonth = e.target.value || monthKey(); await loadService(selMonth); renderService(); });
  document.getElementById("svc-thismonth").addEventListener("click", async () => { selMonth = monthKey(); await loadService(selMonth); renderService(); });
  if (!readOnly) {
    document.getElementById("svc-add").onclick = () => addServiceRow(selMonth);
    body.querySelectorAll("[data-field]").forEach((inp) => inp.addEventListener("change", (e) => updateServiceField(e.target.dataset.id, e.target.dataset.field, e.target.value)));
    body.querySelectorAll(".icon-btn").forEach((b) => b.addEventListener("click", () => deleteServiceRow(b.dataset.id)));
  }
  const lockBtn = document.getElementById("svc-lock"); if (lockBtn) lockBtn.onclick = () => lockServiceMonth(selMonth);
  document.getElementById("svc-print").onclick = () => printService(selMonth, service);
}
function serviceRowEdit(r) {
  return `<tr>
    <td><input type="date" data-field="givenDate" data-id="${r.id}" value="${r.givenDate || ""}"></td>
    <td><input type="date" data-field="receivedDate" data-id="${r.id}" value="${r.receivedDate || ""}"></td>
    <td>${selectHTML("traveller", r.id, state.config.travellers, r.traveller)}</td>
    <td>${selectHTML("vehicle", r.id, state.config.vehicles, r.vehicle)}</td>
    <td><input type="text" data-field="remark" data-id="${r.id}" value="${escapeAttr(r.remark)}" placeholder="—"></td>
    <td><input type="number" step="0.01" data-field="cost" data-id="${r.id}" value="${r.cost ?? ""}"></td>
    <td><button class="icon-btn" data-id="${r.id}" title="Remove">✕</button></td>
  </tr>`;
}
function serviceRowStatic(r) { return `<tr><td class="cell-text">${r.givenDate || "—"}</td><td class="cell-text">${r.receivedDate || "—"}</td><td class="cell-text">${escapeHTML(r.traveller) || "—"}</td><td class="cell-text">${escapeHTML(r.vehicle) || "—"}</td><td class="cell-text">${escapeHTML(r.remark) || "—"}</td><td class="num">${r.cost ?? "—"}</td><td></td></tr>`; }
function renderServiceSummary(sum) {
  const rows = Object.entries(sum.totals || {}).map(([veh, v]) => `<tr><td>${escapeHTML(veh)}</td><td class="num">${v.toFixed(2)}</td></tr>`).join("");
  return `<div class="summary-grid"><div class="summary-card"><div class="label">Grand total</div><div class="value">${sum.grand.toFixed(2)}</div></div></div>
    <div class="detail-table table-scroll"><table><thead><tr><th>Vehicle</th><th>Cost</th></tr></thead><tbody>${rows || '<tr><td colspan="2" class="empty">—</td></tr>'}</tbody></table></div>`;
}

/* ================= CONFIG ================= */
function renderConfig() {
  const el = document.getElementById("view-config");
  const editableNow = canEdit();
  el.innerHTML = `
    <div class="panel">
      <h2>Travellers &amp; lists</h2>
      <p class="sub">These lists feed every dropdown across Schedule, Fuel and Service. Add or remove entries any time.</p>
      ${!editableNow ? viewOnlyBanner() : ""}
      <div class="config-grid">
        ${configList("travellers", "Travellers", editableNow)}
        ${configList("vehicles", "Vehicles", editableNow)}
        ${configList("places", "Places", editableNow)}
        ${configList("tripTypes", "Trip statuses", editableNow)}
        ${configList("fuelTypes", "Fuel types", editableNow)}
      </div>
    </div>
  `;
  if (!editableNow) return;
  ["travellers", "vehicles", "places", "tripTypes", "fuelTypes"].forEach((key) => {
    el.querySelectorAll(`.chips[data-list="${key}"] .chip button`).forEach((b) => b.addEventListener("click", () => removeConfigItem(key, b.dataset.val)));
    const input = el.querySelector(`#add-${key}`);
    const addBtn = el.querySelector(`#addbtn-${key}`);
    const doAdd = () => { const v = input.value.trim(); if (v) addConfigItem(key, v); input.value = ""; };
    addBtn.addEventListener("click", doAdd);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });
  });
}
function configList(key, label, editableNow) {
  const items = state.config[key];
  return `<div>
      <div style="font-size:13px;font-weight:700;margin-bottom:8px;">${label}</div>
      <div class="chips" data-list="${key}">
        ${items.map((v) => `<div class="chip">${escapeHTML(v)}${editableNow ? `<button data-val="${escapeAttr(v)}">✕</button>` : ""}</div>`).join("") || '<span class="empty" style="padding:0;">None yet</span>'}
      </div>
      ${editableNow ? `<div class="add-inline"><input type="text" id="add-${key}" placeholder="Add new…"><button class="btn" id="addbtn-${key}">Add</button></div>` : ""}
    </div>`;
}

/* ================= REPORTS ================= */
async function loadReportsTab() {
  try {
    const [summary, days, months, svcMonths] = await Promise.all([
      api("GET", "/api/reports/summary"),
      api("GET", "/api/reports/schedule-days"),
      api("GET", "/api/reports/fuel-months"),
      api("GET", "/api/reports/service-months"),
    ]);
    reportsSummary = summary; scheduleDays = days; fuelMonths = months; serviceMonths = svcMonths;
  } catch (e) { toast("Could not load reports: " + e.message); }
  renderReports();
}
function renderReports() {
  const el = document.getElementById("view-reports");
  if (!reportsSummary) { el.innerHTML = `<div class="panel"><div class="empty">Loading report data…</div></div>`; return; }
  const s = reportsSummary.schedule, f = reportsSummary.fuel, sv = reportsSummary.service;
  el.innerHTML = `
    <div class="panel">
      <h2>All-time report</h2>
      <p class="sub">Computed live from the database.</p>
      <div class="row-actions"><button class="btn" id="rep-refresh">Refresh from database</button><button class="btn primary" id="rep-print-all">Print full report</button></div>
      <div class="summary-grid">
        <div class="summary-card"><div class="label">Total trips</div><div class="value">${s.trip}</div></div>
        <div class="summary-card"><div class="label">Total no trip</div><div class="value">${s.noTrip}</div></div>
        <div class="summary-card"><div class="label">Total taxi</div><div class="value">${s.taxi}</div></div>
        <div class="summary-card"><div class="label">Fuel spend</div><div class="value">${f.grand.toFixed(2)}</div></div>
        <div class="summary-card"><div class="label">Service spend</div><div class="value">${sv.grand.toFixed(2)}</div></div>
      </div>
    </div>
    <div class="panel">
      <h2>Custom date range</h2>
      <p class="sub">Pull a report for just the period you need — queried straight from the database.</p>
      <div class="field-grid">
        <div class="field"><label>From</label><input type="date" id="rep-from" value="${customReport ? customReport.from : ""}"></div>
        <div class="field"><label>To</label><input type="date" id="rep-to" value="${customReport ? customReport.to : ""}"></div>
      </div>
      <div class="row-actions"><button class="btn primary" id="rep-run">Run report</button>${customReport ? '<button class="btn ghost" id="rep-print-range">Print this range</button>' : ""}</div>
      ${customReport ? renderRangeReport(customReport) : ""}
    </div>
    <div class="panel">
      <h2>Backup</h2>
      <p class="sub">Download everything as a file, or restore the database from one.</p>
      <div class="row-actions">
        <button class="btn" id="rep-export">Download backup (.json)</button>
        ${canEdit() ? `<button class="btn ghost" id="rep-import-btn">Restore from backup</button><input type="file" id="rep-import-file" accept="application/json" style="display:none;">` : ""}
      </div>
    </div>
    <div class="panel"><h2>Travel Schedule — by day</h2>
      ${scheduleDays.map((d) => archiveItemHTML(prettyDate(d.date), scheduleSubline(d), d.locked, "schedule", d.date)).join("") || '<div class="empty">No days recorded yet.</div>'}
    </div>
    <div class="panel"><h2>Fuel — by month</h2>
      ${fuelMonths.map((m) => archiveItemHTML(prettyMonth(m.month), fuelSubline(m), m.locked, "fuel", m.month)).join("") || '<div class="empty">No months recorded yet.</div>'}
    </div>
    <div class="panel"><h2>Service — by month</h2>
      ${serviceMonths.map((m) => archiveItemHTML(prettyMonth(m.month), serviceSubline(m), m.locked, "service", m.month)).join("") || '<div class="empty">No months recorded yet.</div>'}
    </div>
  `;
  document.getElementById("rep-refresh").onclick = loadReportsTab;
  document.getElementById("rep-print-all").onclick = () => printFullReport(s, f, sv);
  document.getElementById("rep-export").onclick = exportBackup;
  document.getElementById("rep-run").onclick = async () => {
    const from = document.getElementById("rep-from").value;
    const to = document.getElementById("rep-to").value;
    if (!from || !to) { toast("Pick both a from and to date"); return; }
    try { const res = await api("GET", `/api/reports/range?from=${from}&to=${to}`); customReport = { from, to, ...res }; renderReports(); }
    catch (e) { toast("Could not run report: " + e.message); }
  };
  const printRangeBtn = document.getElementById("rep-print-range");
  if (printRangeBtn) printRangeBtn.onclick = () => printRangeReport(customReport);
  const importBtn = document.getElementById("rep-import-btn");
  if (importBtn) { importBtn.onclick = () => document.getElementById("rep-import-file").click(); document.getElementById("rep-import-file").addEventListener("change", importBackup); }
  el.querySelectorAll(".archive-item [data-open]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (b.dataset.type === "schedule") { selDate = b.dataset.key; activeTab = "schedule"; await loadSchedule(selDate); }
      else if (b.dataset.type === "fuel") { selMonth = b.dataset.key; activeTab = "fuel"; await loadFuel(selMonth); }
      else { selMonth = b.dataset.key; activeTab = "service"; await loadService(selMonth); }
      render();
    });
  });
  el.querySelectorAll(".archive-item [data-print]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (b.dataset.type === "schedule") { const d = await api("GET", "/api/schedule/" + b.dataset.key); printSchedule(b.dataset.key, d); }
      else if (b.dataset.type === "fuel") { const d = await api("GET", "/api/fuel/" + b.dataset.key); printFuel(b.dataset.key, d); }
      else { const d = await api("GET", "/api/service/" + b.dataset.key); printService(b.dataset.key, d); }
    });
  });
}
function scheduleSubline(d) { return (d.summary ? `${d.summary.trip} trip · ${d.summary.noTrip} no trip · ${d.summary.taxi} taxi` : "not locked yet"); }
function fuelSubline(m) { return m.summary ? `total ${m.summary.grand.toFixed(2)}` : "not locked yet"; }
function serviceSubline(m) { return m.summary ? `total ${m.summary.grand.toFixed(2)}` : "not locked yet"; }
function archiveItemHTML(title, sub, locked, type, key) {
  return `<div class="archive-item">
    <div class="meta">${title} <span class="lock-tag ${locked ? "locked" : "open"}">${locked ? "Locked" : "Open"}</span><span class="sub">${sub}</span></div>
    <div class="btns"><button class="btn ghost" data-open data-type="${type}" data-key="${escapeAttr(key)}">Open</button><button class="btn" data-print data-type="${type}" data-key="${escapeAttr(key)}">Print</button></div>
  </div>`;
}
function renderRangeReport(cr) {
  return `<div style="margin-top:10px;">
    <div class="summary-grid">
      <div class="summary-card"><div class="label">Trips</div><div class="value">${cr.schedule.trip}</div></div>
      <div class="summary-card"><div class="label">No trip</div><div class="value">${cr.schedule.noTrip}</div></div>
      <div class="summary-card"><div class="label">Taxi</div><div class="value">${cr.schedule.taxi}</div></div>
      <div class="summary-card"><div class="label">Fuel spend</div><div class="value">${cr.fuel.grand.toFixed(2)}</div></div>
      <div class="summary-card"><div class="label">Service spend</div><div class="value">${cr.service.grand.toFixed(2)}</div></div>
    </div>
  </div>`;
}

/* ---------------- backup ---------------- */
async function exportBackup() {
  try {
    const dump = await api("GET", "/api/backup");
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `fleet-log-backup-${todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast("Backup downloaded");
  } catch (e) { toast("Could not download backup: " + e.message); }
}
function importBackup(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!window.confirm("This replaces all current data on the server with the contents of this backup. Continue?")) return;
      await api("POST", "/api/backup/restore", parsed);
      toast("Backup restored");
      await loadConfig(); await loadSchedule(selDate); await loadFuel(selMonth); await loadService(selMonth);
      await loadReportsTab();
    } catch (err) { toast("Could not restore: " + err.message); }
  };
  reader.readAsText(file); e.target.value = "";
}

/* ================= SETUP ================= */
function renderSetup() {
  const el = document.getElementById("view-setup");
  el.innerHTML = `
    <div class="panel">
      <h2>Backend &amp; database</h2>
      <p class="sub">This app is a plain Node.js + Express server backed by a SQLite database (fleet-log.db). No third-party service is involved — every device that opens this same server's address shares the same data automatically.</p>
      <div class="conn-badge on"><span class="dot"></span>Connected to this server's database</div>
      <div class="arch-note">
        <b>Tables in use</b>
        <div class="schema-row"><span class="coll">lists / settings</span><span class="desc">travellers, vehicles, places, statuses, fuel types, edit PIN</span></div>
        <div class="schema-row"><span class="coll">schedule_days / schedule_entries</span><span class="desc">one row per day, one row per travel entry</span></div>
        <div class="schema-row"><span class="coll">fuel_months / fuel_entries</span><span class="desc">one row per month, one row per fuel entry</span></div>
        <div class="schema-row"><span class="coll">service_months / service_entries</span><span class="desc">one row per month, one row per service entry</span></div>
      </div>
      <p class="note">To run this on a server others can reach, deploy the whole folder (e.g. to a small VPS) and put it behind a reverse proxy with HTTPS. The SQLite file (fleet-log.db) is the entire database — back it up by copying that file, in addition to the in-app backup below.</p>
    </div>
    <div class="panel">
      <h2>Who can edit</h2>
      <p class="sub">Set a shared PIN so entries only come from people who know it. Everyone else still sees updates — they just can't add, change, or delete. The server checks this PIN on every write, not just the page you're looking at.</p>
      ${state.pinSet ? `
        <div class="lock-banner">${canEdit() ? "🔓 This device can edit." : "🔒 This device is view-only."} ${canEdit() ? `<button class="btn" id="pin-lock" style="padding:4px 10px;">Switch to view-only</button>` : `<button class="btn" id="pin-unlock" style="padding:4px 10px;">Enter PIN to edit</button>`}</div>
        ${canEdit() ? `
          <div class="field-grid"><div class="field"><label>New PIN</label><input type="password" id="pin-new" placeholder="4+ characters"></div></div>
          <div class="row-actions"><button class="btn" id="pin-change">Change PIN</button><button class="btn danger" id="pin-remove">Remove PIN (everyone can edit)</button></div>
        ` : ""}
      ` : `
        <p class="note" style="margin-top:0;">No PIN set yet — anyone using this app can edit.</p>
        <div class="field-grid"><div class="field"><label>Set a PIN</label><input type="password" id="pin-set" placeholder="4+ characters"></div></div>
        <div class="row-actions"><button class="btn primary" id="pin-save">Set PIN</button></div>
      `}
    </div>
  `;
  const pinSave = document.getElementById("pin-save");
  if (pinSave) pinSave.onclick = async () => {
    const v = document.getElementById("pin-set").value;
    if (v.length < 4) { toast("Use at least 4 characters"); return; }
    try { const res = await api("POST", "/api/auth/set-pin", { pin: v }); token = res.token; localStorage.setItem("fleetlog_token", token); await loadConfig(); render(); toast("PIN set — share it with people who should be able to edit"); }
    catch (e) { toast(e.message); }
  };
  const pinChange = document.getElementById("pin-change");
  if (pinChange) pinChange.onclick = async () => {
    const v = document.getElementById("pin-new").value;
    if (v.length < 4) { toast("Use at least 4 characters"); return; }
    try { const res = await api("POST", "/api/auth/set-pin", { pin: v }); token = res.token; localStorage.setItem("fleetlog_token", token); toast("PIN changed"); }
    catch (e) { toast(e.message); }
  };
  const pinRemove = document.getElementById("pin-remove");
  if (pinRemove) pinRemove.onclick = async () => {
    try { await api("POST", "/api/auth/remove-pin"); await loadConfig(); render(); toast("PIN removed — everyone can edit now"); }
    catch (e) { toast(e.message); }
  };
  const pinLock = document.getElementById("pin-lock"); if (pinLock) pinLock.onclick = lockDevice;
  const pinUnlock = document.getElementById("pin-unlock"); if (pinUnlock) pinUnlock.onclick = tryUnlock;
}

/* ================= print ================= */
function printSchedule(date, s) {
  document.getElementById("print-root").innerHTML = `
    <h2>Travel Schedule — ${prettyDate(date)}</h2><p class="sub">${s.locked ? "Locked" : "Not yet locked"} · ${s.rows.length} entries</p>
    <table><thead><tr><th>Traveller</th><th>Vehicle</th><th>Start</th><th>End</th><th>Status</th><th>Out</th><th>In</th><th>Remark</th></tr></thead>
    <tbody>${s.rows.map((r) => `<tr><td>${escapeHTML(r.traveller) || "—"}</td><td>${escapeHTML(r.vehicle) || "—"}</td><td>${escapeHTML(r.start) || "—"}</td><td>${escapeHTML(r.end) || "—"}</td><td>${escapeHTML(r.tripType) || "—"}</td><td>${r.outTime || "—"}</td><td>${r.inTime || "—"}</td><td>${escapeHTML(r.remark) || "—"}</td></tr>`).join("")}</tbody></table>
    ${s.summary ? renderScheduleSummary(s.summary) : ""}`;
  window.print();
}
function printFuel(month, f) {
  document.getElementById("print-root").innerHTML = `
    <h2>Fuel Log — ${prettyMonth(month)}</h2><p class="sub">${f.locked ? "Locked" : "Not yet locked"} · ${f.rows.length} entries</p>
    <table><thead><tr><th>Date</th><th>Traveller</th><th>Vehicle</th><th>Fuel</th><th>Qty</th><th>Price</th><th>Subtotal</th><th>Remarks</th></tr></thead>
    <tbody>${f.rows.map((r) => `<tr><td>${r.date || "—"}</td><td>${escapeHTML(r.traveller) || "—"}</td><td>${escapeHTML(r.vehicle) || "—"}</td><td>${escapeHTML(r.fuel) || "—"}</td><td>${r.qty ?? "—"}</td><td>${r.price ?? "—"}</td><td>${fuelSubtotal(r)}</td><td>${escapeHTML(r.remark) || "—"}</td></tr>`).join("")}</tbody></table>
    ${f.summary ? renderFuelSummary(f.summary) : ""}`;
  window.print();
}
function printService(month, sv) {
  document.getElementById("print-root").innerHTML = `
    <h2>Service Log — ${prettyMonth(month)}</h2><p class="sub">${sv.locked ? "Locked" : "Not yet locked"} · ${sv.rows.length} entries</p>
    <table><thead><tr><th>Given</th><th>Received</th><th>Traveller</th><th>Vehicle</th><th>Remark</th><th>Cost</th></tr></thead>
    <tbody>${sv.rows.map((r) => `<tr><td>${r.givenDate || "—"}</td><td>${r.receivedDate || "—"}</td><td>${escapeHTML(r.traveller) || "—"}</td><td>${escapeHTML(r.vehicle) || "—"}</td><td>${escapeHTML(r.remark) || "—"}</td><td>${r.cost ?? "—"}</td></tr>`).join("")}</tbody></table>
    ${sv.summary ? renderServiceSummary(sv.summary) : ""}`;
  window.print();
}
function printFullReport(s, f, sv) {
  const peopleRows = Object.entries(s.people || {}).map(([n, v]) => `<tr><td>${escapeHTML(n)}</td><td>${v.trip}</td><td>${v.noTrip}</td></tr>`).join("");
  const fuelRows = Object.entries(f.totals || {}).map(([k, v]) => `<tr><td>${escapeHTML(k)}</td><td>${v.toFixed(2)}</td></tr>`).join("");
  const serviceRows = Object.entries(sv.totals || {}).map(([k, v]) => `<tr><td>${escapeHTML(k)}</td><td>${v.toFixed(2)}</td></tr>`).join("");
  document.getElementById("print-root").innerHTML = `
    <h2>Fleet Log — All-time report</h2><p class="sub">Generated ${prettyDate(todayISO())}</p>
    <div class="summary-grid">
      <div class="summary-card"><div class="label">Total trips</div><div class="value">${s.trip}</div></div>
      <div class="summary-card"><div class="label">Total no trip</div><div class="value">${s.noTrip}</div></div>
      <div class="summary-card"><div class="label">Total taxi</div><div class="value">${s.taxi}</div></div>
      <div class="summary-card"><div class="label">Fuel spend</div><div class="value">${f.grand.toFixed(2)}</div></div>
      <div class="summary-card"><div class="label">Service spend</div><div class="value">${sv.grand.toFixed(2)}</div></div>
    </div>
    <h2 style="margin-top:20px;">Trips by traveller</h2><table><thead><tr><th>Traveller</th><th>Trip</th><th>No trip</th></tr></thead><tbody>${peopleRows || "<tr><td colspan=3>—</td></tr>"}</tbody></table>
    <h2 style="margin-top:20px;">Fuel by type</h2><table><thead><tr><th>Fuel type</th><th>Total</th></tr></thead><tbody>${fuelRows || "<tr><td colspan=2>—</td></tr>"}</tbody></table>
    <h2 style="margin-top:20px;">Service by vehicle</h2><table><thead><tr><th>Vehicle</th><th>Total</th></tr></thead><tbody>${serviceRows || "<tr><td colspan=2>—</td></tr>"}</tbody></table>`;
  window.print();
}
function printRangeReport(cr) {
  document.getElementById("print-root").innerHTML = `<h2>Fleet Log — Report: ${prettyDate(cr.from)} to ${prettyDate(cr.to)}</h2>${renderRangeReport(cr)}`;
  window.print();
}
