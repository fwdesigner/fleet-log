const express = require("express");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");
const { computeScheduleSummary, computeFuelSummary, computeServiceSummary } = require("./lib/summary");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const LIST_NAMES = ["travellers", "vehicles", "places", "tripTypes", "fuelTypes"];

function requireAuth(req, res, next) {
  const pin = db.getSetting("edit_pin");
  if (!pin) return next(); // no PIN configured yet -> editing is open
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || !db.isValidSession(token)) return res.status(401).json({ error: "Unauthorized" });
  next();
}

/* ---------------- auth ---------------- */
app.get("/api/auth/status", (req, res) => {
  res.json({ pinSet: !!db.getSetting("edit_pin") });
});
app.post("/api/auth/unlock", (req, res) => {
  const pin = db.getSetting("edit_pin");
  if (!pin) return res.status(400).json({ error: "No PIN is set on this server" });
  if ((req.body.pin || "") !== pin) return res.status(401).json({ error: "Incorrect PIN" });
  const token = crypto.randomBytes(24).toString("hex");
  db.createSession(token);
  res.json({ token });
});
app.post("/api/auth/set-pin", (req, res) => {
  const existing = db.getSetting("edit_pin");
  if (existing) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token || !db.isValidSession(token)) return res.status(401).json({ error: "Unauthorized" });
  }
  const pin = (req.body.pin || "").trim();
  if (pin.length < 4) return res.status(400).json({ error: "PIN must be at least 4 characters" });
  db.setSetting("edit_pin", pin);
  const token = crypto.randomBytes(24).toString("hex");
  db.createSession(token);
  res.json({ token });
});
app.post("/api/auth/remove-pin", requireAuth, (req, res) => {
  db.deleteSetting("edit_pin");
  res.json({ ok: true });
});

/* ---------------- config / lists ---------------- */
app.get("/api/config", (req, res) => {
  res.json({ ...db.getLists(), pinSet: !!db.getSetting("edit_pin") });
});
app.post("/api/config/:list", requireAuth, (req, res) => {
  const { list } = req.params;
  if (!LIST_NAMES.includes(list)) return res.status(400).json({ error: "Unknown list" });
  const value = (req.body.value || "").trim();
  if (!value) return res.status(400).json({ error: "Value required" });
  db.addListItem(list, value);
  res.json({ ok: true });
});
app.delete("/api/config/:list/:value", requireAuth, (req, res) => {
  const { list, value } = req.params;
  if (!LIST_NAMES.includes(list)) return res.status(400).json({ error: "Unknown list" });
  db.removeListItem(list, decodeURIComponent(value));
  res.json({ ok: true });
});

/* ---------------- schedule ---------------- */
app.get("/api/schedule/:date", (req, res) => {
  const day = db.getScheduleDay(req.params.date);
  const rows = db.getScheduleEntries(req.params.date);
  res.json({ ...day, rows });
});
app.post("/api/schedule/:date/entries", requireAuth, (req, res) => {
  res.json(db.addScheduleEntry(req.params.date, req.body));
});
app.patch("/api/schedule/entries/:id", requireAuth, (req, res) => {
  try { db.updateScheduleEntry(req.params.id, req.body.field, req.body.value); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/schedule/entries/:id", requireAuth, (req, res) => {
  db.deleteScheduleEntry(req.params.id);
  res.json({ ok: true });
});
app.post("/api/schedule/:date/lock", requireAuth, (req, res) => {
  const rows = db.getScheduleEntries(req.params.date);
  const summary = computeScheduleSummary(rows);
  db.setScheduleDayLock(req.params.date, true, summary);
  res.json({ locked: true, summary });
});

/* ---------------- fuel ---------------- */
app.get("/api/fuel/:month", (req, res) => {
  const m = db.getFuelMonth(req.params.month);
  const rows = db.getFuelEntries(req.params.month);
  res.json({ ...m, rows });
});
app.post("/api/fuel/:month/entries", requireAuth, (req, res) => {
  res.json(db.addFuelEntry(req.params.month, req.body));
});
app.patch("/api/fuel/entries/:id", requireAuth, (req, res) => {
  try { db.updateFuelEntry(req.params.id, req.body.field, req.body.value); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/fuel/entries/:id", requireAuth, (req, res) => {
  db.deleteFuelEntry(req.params.id);
  res.json({ ok: true });
});
app.post("/api/fuel/:month/lock", requireAuth, (req, res) => {
  const rows = db.getFuelEntries(req.params.month);
  const summary = computeFuelSummary(rows);
  db.setFuelMonthLock(req.params.month, true, summary);
  res.json({ locked: true, summary });
});

/* ---------------- service ---------------- */
app.get("/api/service/:month", (req, res) => {
  const m = db.getServiceMonth(req.params.month);
  const rows = db.getServiceEntries(req.params.month);
  res.json({ ...m, rows });
});
app.post("/api/service/:month/entries", requireAuth, (req, res) => {
  res.json(db.addServiceEntry(req.params.month, req.body));
});
app.patch("/api/service/entries/:id", requireAuth, (req, res) => {
  try { db.updateServiceEntry(req.params.id, req.body.field, req.body.value); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/service/entries/:id", requireAuth, (req, res) => {
  db.deleteServiceEntry(req.params.id);
  res.json({ ok: true });
});
app.post("/api/service/:month/lock", requireAuth, (req, res) => {
  const rows = db.getServiceEntries(req.params.month);
  const summary = computeServiceSummary(rows);
  db.setServiceMonthLock(req.params.month, true, summary);
  res.json({ locked: true, summary });
});

/* ---------------- reports (computed on demand from the database) ---------------- */
app.get("/api/reports/schedule-days", (req, res) => res.json(db.listScheduleDays()));
app.get("/api/reports/fuel-months", (req, res) => res.json(db.listFuelMonths()));
app.get("/api/reports/service-months", (req, res) => res.json(db.listServiceMonths()));

app.get("/api/reports/summary", (req, res) => {
  res.json({
    schedule: computeScheduleSummary(db.allScheduleEntries()),
    fuel: computeFuelSummary(db.allFuelEntries()),
    service: computeServiceSummary(db.allServiceEntries()),
  });
});
app.get("/api/reports/range", (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to are required" });
  res.json({
    schedule: computeScheduleSummary(db.scheduleEntriesInRange(from, to)),
    fuel: computeFuelSummary(db.fuelEntriesInRange(from, to)),
    service: computeServiceSummary(db.serviceEntriesInRange(from, to)),
  });
});

/* ---------------- backup ---------------- */
app.get("/api/backup", (req, res) => res.json(db.fullDump()));
app.post("/api/backup/restore", requireAuth, (req, res) => {
  try { db.restoreDump(req.body); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: "Invalid backup file: " + e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fleet Log running on http://localhost:${PORT}`));
