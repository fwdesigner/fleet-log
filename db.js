const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "fleet-log.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS lists (
  list_name TEXT NOT NULL,
  value TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (list_name, value)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS schedule_days (
  date TEXT PRIMARY KEY,
  locked INTEGER DEFAULT 0,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS schedule_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  traveller TEXT, vehicle TEXT, start TEXT, end TEXT,
  trip_type TEXT, out_time TEXT, in_time TEXT, remark TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_schedule_entries_date ON schedule_entries(date);

CREATE TABLE IF NOT EXISTS fuel_months (
  month TEXT PRIMARY KEY,
  locked INTEGER DEFAULT 0,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS fuel_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  date TEXT, traveller TEXT, vehicle TEXT, fuel TEXT,
  qty REAL, price REAL, remark TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fuel_entries_month ON fuel_entries(month);
CREATE INDEX IF NOT EXISTS idx_fuel_entries_date ON fuel_entries(date);

CREATE TABLE IF NOT EXISTS service_months (
  month TEXT PRIMARY KEY,
  locked INTEGER DEFAULT 0,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS service_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  given_date TEXT, received_date TEXT, traveller TEXT, vehicle TEXT,
  remark TEXT, cost REAL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_service_entries_month ON service_entries(month);
CREATE INDEX IF NOT EXISTS idx_service_entries_given_date ON service_entries(given_date);
`);

// ---- seed default lists on first run ----
const DEFAULT_LISTS = {
  travellers: ["Anus", "Ashraf", "Asif", "Balaji", "Lateef", "No Driver", "Qadeer", "Sabir", "Sakeer", "Shahab", "Shanawaz", "Zakaria"],
  vehicles: ["25049", "29563", "31716", "42678", "43920", "60219", "73157", "73529", "79664", "82718", "94412", "99350", "Taxi"],
  places: ["Abu Dhabi", "Ajman", "Cargo", "Dubai", "Factory", "R.A.K", "Sharjah", "U.A.Q"],
  tripTypes: ["Trip", "No Trip", "Taxi"],
  fuelTypes: ["Petrol", "Barrel Petrol", "Diesel", "Barrel Diesel"],
};
const listCount = db.prepare("SELECT COUNT(*) c FROM lists").get().c;
if (listCount === 0) {
  const insert = db.prepare("INSERT INTO lists (list_name, value, position) VALUES (?,?,?)");
  const seed = db.transaction(() => {
    Object.entries(DEFAULT_LISTS).forEach(([listName, values]) => {
      values.forEach((v, i) => insert.run(listName, v, i));
    });
  });
  seed();
}

/* ---------------- lists / config ---------------- */
function getLists() {
  const rows = db.prepare("SELECT list_name, value FROM lists ORDER BY list_name, position").all();
  const out = { travellers: [], vehicles: [], places: [], tripTypes: [], fuelTypes: [] };
  rows.forEach((r) => { if (out[r.list_name]) out[r.list_name].push(r.value); });
  return out;
}
function addListItem(listName, value) {
  const maxPos = db.prepare("SELECT COALESCE(MAX(position),-1) m FROM lists WHERE list_name=?").get(listName).m;
  db.prepare("INSERT OR IGNORE INTO lists (list_name, value, position) VALUES (?,?,?)").run(listName, value, maxPos + 1);
}
function removeListItem(listName, value) {
  db.prepare("DELETE FROM lists WHERE list_name=? AND value=?").run(listName, value);
}

/* ---------------- settings / auth ---------------- */
function getSetting(key) {
  const r = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
function deleteSetting(key) {
  db.prepare("DELETE FROM settings WHERE key=?").run(key);
}
function createSession(token) {
  db.prepare("INSERT INTO sessions (token, created_at) VALUES (?,?)").run(token, Date.now());
}
function isValidSession(token) {
  return !!db.prepare("SELECT 1 FROM sessions WHERE token=?").get(token);
}

/* ---------------- schedule ---------------- */
function mapScheduleRow(r) {
  return { id: r.id, date: r.date, traveller: r.traveller, vehicle: r.vehicle, start: r.start, end: r.end, tripType: r.trip_type, outTime: r.out_time, inTime: r.in_time, remark: r.remark };
}
function getScheduleDay(date) {
  const row = db.prepare("SELECT locked, summary FROM schedule_days WHERE date=?").get(date);
  return { locked: row ? !!row.locked : false, summary: row && row.summary ? JSON.parse(row.summary) : null };
}
function setScheduleDayLock(date, locked, summary) {
  db.prepare(`INSERT INTO schedule_days (date, locked, summary) VALUES (?,?,?)
    ON CONFLICT(date) DO UPDATE SET locked=excluded.locked, summary=excluded.summary`)
    .run(date, locked ? 1 : 0, summary ? JSON.stringify(summary) : null);
}
function getScheduleEntries(date) {
  return db.prepare("SELECT * FROM schedule_entries WHERE date=? ORDER BY created_at").all(date).map(mapScheduleRow);
}
function addScheduleEntry(date, data) {
  const info = db.prepare(`INSERT INTO schedule_entries (date,traveller,vehicle,start,end,trip_type,out_time,in_time,remark,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(date, data.traveller || "", data.vehicle || "", data.start || "", data.end || "", data.tripType || "", data.outTime || "", data.inTime || "", data.remark || "", Date.now());
  return mapScheduleRow(db.prepare("SELECT * FROM schedule_entries WHERE id=?").get(info.lastInsertRowid));
}
const SCHEDULE_FIELD_MAP = { traveller: "traveller", vehicle: "vehicle", start: "start", end: "end", tripType: "trip_type", outTime: "out_time", inTime: "in_time", remark: "remark" };
function updateScheduleEntry(id, field, value) {
  const col = SCHEDULE_FIELD_MAP[field];
  if (!col) throw new Error("Unknown field: " + field);
  db.prepare(`UPDATE schedule_entries SET ${col}=? WHERE id=?`).run(value, id);
}
function deleteScheduleEntry(id) {
  db.prepare("DELETE FROM schedule_entries WHERE id=?").run(id);
}
function listScheduleDays() {
  return db.prepare("SELECT date, locked, summary FROM schedule_days ORDER BY date DESC").all()
    .map((r) => ({ date: r.date, locked: !!r.locked, summary: r.summary ? JSON.parse(r.summary) : null }));
}
function allScheduleEntries() {
  return db.prepare("SELECT * FROM schedule_entries").all().map(mapScheduleRow);
}
function scheduleEntriesInRange(from, to) {
  return db.prepare("SELECT * FROM schedule_entries WHERE date>=? AND date<=?").all(from, to).map(mapScheduleRow);
}

/* ---------------- fuel ---------------- */
function mapFuelRow(r) {
  return { id: r.id, month: r.month, date: r.date, traveller: r.traveller, vehicle: r.vehicle, fuel: r.fuel, qty: r.qty, price: r.price, remark: r.remark };
}
function getFuelMonth(month) {
  const row = db.prepare("SELECT locked, summary FROM fuel_months WHERE month=?").get(month);
  return { locked: row ? !!row.locked : false, summary: row && row.summary ? JSON.parse(row.summary) : null };
}
function setFuelMonthLock(month, locked, summary) {
  db.prepare(`INSERT INTO fuel_months (month, locked, summary) VALUES (?,?,?)
    ON CONFLICT(month) DO UPDATE SET locked=excluded.locked, summary=excluded.summary`)
    .run(month, locked ? 1 : 0, summary ? JSON.stringify(summary) : null);
}
function getFuelEntries(month) {
  return db.prepare("SELECT * FROM fuel_entries WHERE month=? ORDER BY created_at").all(month).map(mapFuelRow);
}
function addFuelEntry(month, data) {
  const info = db.prepare(`INSERT INTO fuel_entries (month,date,traveller,vehicle,fuel,qty,price,remark,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(month, data.date || "", data.traveller || "", data.vehicle || "", data.fuel || "", data.qty || null, data.price || null, data.remark || "", Date.now());
  return mapFuelRow(db.prepare("SELECT * FROM fuel_entries WHERE id=?").get(info.lastInsertRowid));
}
const FUEL_FIELD_MAP = { date: "date", traveller: "traveller", vehicle: "vehicle", fuel: "fuel", qty: "qty", price: "price", remark: "remark" };
function updateFuelEntry(id, field, value) {
  const col = FUEL_FIELD_MAP[field];
  if (!col) throw new Error("Unknown field: " + field);
  db.prepare(`UPDATE fuel_entries SET ${col}=? WHERE id=?`).run(value, id);
}
function deleteFuelEntry(id) {
  db.prepare("DELETE FROM fuel_entries WHERE id=?").run(id);
}
function listFuelMonths() {
  return db.prepare("SELECT month, locked, summary FROM fuel_months ORDER BY month DESC").all()
    .map((r) => ({ month: r.month, locked: !!r.locked, summary: r.summary ? JSON.parse(r.summary) : null }));
}
function allFuelEntries() {
  return db.prepare("SELECT * FROM fuel_entries").all().map(mapFuelRow);
}
function fuelEntriesInRange(from, to) {
  return db.prepare("SELECT * FROM fuel_entries WHERE date>=? AND date<=?").all(from, to).map(mapFuelRow);
}

/* ---------------- service ---------------- */
function mapServiceRow(r) {
  return { id: r.id, month: r.month, givenDate: r.given_date, receivedDate: r.received_date, traveller: r.traveller, vehicle: r.vehicle, remark: r.remark, cost: r.cost };
}
function getServiceMonth(month) {
  const row = db.prepare("SELECT locked, summary FROM service_months WHERE month=?").get(month);
  return { locked: row ? !!row.locked : false, summary: row && row.summary ? JSON.parse(row.summary) : null };
}
function setServiceMonthLock(month, locked, summary) {
  db.prepare(`INSERT INTO service_months (month, locked, summary) VALUES (?,?,?)
    ON CONFLICT(month) DO UPDATE SET locked=excluded.locked, summary=excluded.summary`)
    .run(month, locked ? 1 : 0, summary ? JSON.stringify(summary) : null);
}
function getServiceEntries(month) {
  return db.prepare("SELECT * FROM service_entries WHERE month=? ORDER BY created_at").all(month).map(mapServiceRow);
}
function addServiceEntry(month, data) {
  const info = db.prepare(`INSERT INTO service_entries (month,given_date,received_date,traveller,vehicle,remark,cost,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(month, data.givenDate || "", data.receivedDate || "", data.traveller || "", data.vehicle || "", data.remark || "", data.cost || null, Date.now());
  return mapServiceRow(db.prepare("SELECT * FROM service_entries WHERE id=?").get(info.lastInsertRowid));
}
const SERVICE_FIELD_MAP = { givenDate: "given_date", receivedDate: "received_date", traveller: "traveller", vehicle: "vehicle", remark: "remark", cost: "cost" };
function updateServiceEntry(id, field, value) {
  const col = SERVICE_FIELD_MAP[field];
  if (!col) throw new Error("Unknown field: " + field);
  db.prepare(`UPDATE service_entries SET ${col}=? WHERE id=?`).run(value, id);
}
function deleteServiceEntry(id) {
  db.prepare("DELETE FROM service_entries WHERE id=?").run(id);
}
function listServiceMonths() {
  return db.prepare("SELECT month, locked, summary FROM service_months ORDER BY month DESC").all()
    .map((r) => ({ month: r.month, locked: !!r.locked, summary: r.summary ? JSON.parse(r.summary) : null }));
}
function allServiceEntries() {
  return db.prepare("SELECT * FROM service_entries").all().map(mapServiceRow);
}
function serviceEntriesInRange(from, to) {
  return db.prepare("SELECT * FROM service_entries WHERE given_date>=? AND given_date<=?").all(from, to).map(mapServiceRow);
}

/* ---------------- backup ---------------- */
function fullDump() {
  return {
    lists: getLists(),
    scheduleDays: db.prepare("SELECT * FROM schedule_days").all(),
    scheduleEntries: db.prepare("SELECT * FROM schedule_entries").all(),
    fuelMonths: db.prepare("SELECT * FROM fuel_months").all(),
    fuelEntries: db.prepare("SELECT * FROM fuel_entries").all(),
    serviceMonths: db.prepare("SELECT * FROM service_months").all(),
    serviceEntries: db.prepare("SELECT * FROM service_entries").all(),
  };
}
function restoreDump(dump) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM schedule_entries").run();
    db.prepare("DELETE FROM schedule_days").run();
    db.prepare("DELETE FROM fuel_entries").run();
    db.prepare("DELETE FROM fuel_months").run();
    db.prepare("DELETE FROM service_entries").run();
    db.prepare("DELETE FROM service_months").run();
    db.prepare("DELETE FROM lists").run();

    if (dump.lists) {
      Object.entries(dump.lists).forEach(([listName, values]) => {
        (values || []).forEach((v, i) => db.prepare("INSERT INTO lists (list_name,value,position) VALUES (?,?,?)").run(listName, v, i));
      });
    }
    (dump.scheduleDays || []).forEach((r) => db.prepare("INSERT INTO schedule_days (date,locked,summary) VALUES (?,?,?)").run(r.date, r.locked, r.summary));
    (dump.scheduleEntries || []).forEach((r) => db.prepare(`INSERT INTO schedule_entries (id,date,traveller,vehicle,start,end,trip_type,out_time,in_time,remark,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(r.id, r.date, r.traveller, r.vehicle, r.start, r.end, r.trip_type, r.out_time, r.in_time, r.remark, r.created_at));
    (dump.fuelMonths || []).forEach((r) => db.prepare("INSERT INTO fuel_months (month,locked,summary) VALUES (?,?,?)").run(r.month, r.locked, r.summary));
    (dump.fuelEntries || []).forEach((r) => db.prepare(`INSERT INTO fuel_entries (id,month,date,traveller,vehicle,fuel,qty,price,remark,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(r.id, r.month, r.date, r.traveller, r.vehicle, r.fuel, r.qty, r.price, r.remark, r.created_at));
    (dump.serviceMonths || []).forEach((r) => db.prepare("INSERT INTO service_months (month,locked,summary) VALUES (?,?,?)").run(r.month, r.locked, r.summary));
    (dump.serviceEntries || []).forEach((r) => db.prepare(`INSERT INTO service_entries (id,month,given_date,received_date,traveller,vehicle,remark,cost,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(r.id, r.month, r.given_date, r.received_date, r.traveller, r.vehicle, r.remark, r.cost, r.created_at));
  });
  tx();
}

module.exports = {
  getLists, addListItem, removeListItem,
  getSetting, setSetting, deleteSetting, createSession, isValidSession,
  getScheduleDay, setScheduleDayLock, getScheduleEntries, addScheduleEntry, updateScheduleEntry, deleteScheduleEntry, listScheduleDays, allScheduleEntries, scheduleEntriesInRange,
  getFuelMonth, setFuelMonthLock, getFuelEntries, addFuelEntry, updateFuelEntry, deleteFuelEntry, listFuelMonths, allFuelEntries, fuelEntriesInRange,
  getServiceMonth, setServiceMonthLock, getServiceEntries, addServiceEntry, updateServiceEntry, deleteServiceEntry, listServiceMonths, allServiceEntries, serviceEntriesInRange,
  fullDump, restoreDump,
};
