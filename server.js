import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import * as cheerio from "cheerio";
import nodemailer from "nodemailer";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
const PORT = process.env.PORT || 3000;
const EVENTS = ["Triftern", "Tettenweis", "Neuötting", "Eggenfelden", "Wurmannsquick", "Peterskirchen"];
const dataDir = process.env.DATA_DIR || "./data";
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "fasching.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS emails (
 id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT UNIQUE, received_at TEXT,
 from_addr TEXT, subject TEXT, body TEXT, parsed_json TEXT, status TEXT DEFAULT 'Prüfen'
);
CREATE TABLE IF NOT EXISTS participants (
 id INTEGER PRIMARY KEY AUTOINCREMENT, email_id INTEGER, name TEXT, age TEXT,
 parade TEXT, contact_email TEXT, phone TEXT, notes TEXT, confidence TEXT,
 FOREIGN KEY(email_id) REFERENCES emails(id)
);
`);
const insertEmail = db.prepare(`INSERT OR IGNORE INTO emails(uid,received_at,from_addr,subject,body,parsed_json,status)
 VALUES(@uid,@received_at,@from_addr,@subject,@body,@parsed_json,@status)`);
const insertParticipant = db.prepare(`INSERT INTO participants(email_id,name,age,parade,contact_email,phone,notes,confidence)
 VALUES(?,?,?,?,?,?,?,?)`);
const selectEmail = db.prepare("SELECT id FROM emails WHERE uid=?");

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 60 * 60 * 1000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET || "missing-secret").update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function authenticated(req) {
  const token = (req.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith("fasching_session="))?.split("=")[1];
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = crypto.createHmac("sha256", process.env.SESSION_SECRET || "missing-secret").update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now(); } catch { return false; }
}
function requireAuth(req, res, next) {
  if (!authenticated(req)) return res.status(401).json({ error: "Bitte zuerst anmelden." });
  next();
}
app.post("/api/login", (req, res) => {
  if (!process.env.DASHBOARD_PASSWORD) return res.status(503).json({ error: "Dashboard-Passwort ist noch nicht eingerichtet." });
  if (!safeEqual(req.body.password, process.env.DASHBOARD_PASSWORD)) return res.status(401).json({ error: "Passwort stimmt nicht." });
  res.setHeader("Set-Cookie", `fasching_session=${makeToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`);
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "fasching_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/health", (req, res) => res.json({ ok: true, service: "Fasching 2027" }));

function clean(s = "") { return String(s).replace(/\s+/g, " ").trim(); }
function extractRows(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const rows = [];
  $("tr").each((_, tr) => {
    const cells = $(tr).find("th,td").map((__, td) => clean($(td).text())).get().filter(Boolean);
    if (cells.length) rows.push(cells.join(" | "));
  });
  return rows;
}
function parseMessage(text, html) {
  const tableRows = extractRows(html);
  const combined = [text || "", ...tableRows].join("\n");
  const foundEvents = EVENTS.filter(e => new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(combined));
  const nameMatch = combined.match(/(?:name|vorname\s*und\s*nachname|teilnehmer(?:name)?)\s*[:=|]\s*([^\n|,;]{3,70})/i);
  const ageMatch = combined.match(/(?:alter|age)\s*[:=|]\s*(\d{1,3})\b/i);
  const mailMatch = combined.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phoneMatch = combined.match(/(?:telefon(?:nummer)?|handy|phone|mobil)\s*[:=|]\s*([+()\d][+()\d\s./-]{5,})/i);
  const notesMatch = combined.match(/(?:anmerkungen?|bemerkungen?|notizen?)\s*[:=|]\s*([^\n]+)/i);
  const records = [];
  // Tabellenzeilen mit Name | Alter | Umzug bzw. ähnlichen Spalten erkennen.
  for (const row of tableRows) {
    const cells = row.split(" | ").map(clean);
    if (cells.length >= 2 && !/name|alter|umzug|fasching/i.test(cells.join(" "))) {
      const event = EVENTS.find(e => cells.some(c => c.toLowerCase().includes(e.toLowerCase())));
      const age = cells.find(c => /^\d{1,3}$/.test(c));
      const candidateName = cells.find(c => /[A-Za-zÄÖÜäöüß]{2,}\s+[A-Za-zÄÖÜäöüß]{2,}/.test(c));
      if (candidateName && (age || event)) {
        records.push({ name: candidateName, age: age || "", parade: event || "", email: mailMatch?.[0] || "", phone: "", notes: "", confidence: event && age ? "Hoch" : "Prüfen" });
      }
    }
  }
  if (!records.length) {
    records.push({
      name: clean(nameMatch?.[1] || ""), age: ageMatch?.[1] || "",
      parade: foundEvents.length === 1 ? foundEvents[0] : "",
      email: mailMatch?.[0] || "", phone: clean(phoneMatch?.[1] || ""),
      notes: clean(notesMatch?.[1] || ""),
      confidence: nameMatch && ageMatch && foundEvents.length === 1 ? "Mittel" : "Prüfen"
    });
  }
  return { records, foundEvents, tableRows };
}
let lastRefresh = null;
let refreshing = false;
async function refreshMailbox() {
  if (refreshing) return { skipped: true, message: "Abruf läuft bereits." };
  const required = ["GMX_EMAIL", "GMX_APP_PASSWORD"];
  if (required.some(k => !process.env[k])) throw new Error("GMX-Zugangsdaten fehlen in den Server-Einstellungen.");
  refreshing = true;
  let client;
  try {
    client = new ImapFlow({
      host: process.env.GMX_IMAP_HOST || "imap.gmx.net",
      port: Number(process.env.GMX_IMAP_PORT || 993),
      secure: true,
      auth: { user: process.env.GMX_EMAIL, pass: process.env.GMX_APP_PASSWORD },
      logger: false
    });
    await client.connect();
    const mailboxLock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ all: true }, { uid: true });
      for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true, internalDate: true }, { uid: true })) {
        const uid = String(msg.uid);
        if (selectEmail.get(uid)) continue;
        const parsed = await simpleParser(msg.source);
        const subject = clean(parsed.subject || "");
        const from = parsed.from?.text || "";
        const body = parsed.text || "";
        const html = typeof parsed.html === "string" ? parsed.html : "";
        const content = `${subject}\n${body}\n${html}`;
        // Ausschließlich Nachrichten mit Fasching-/Umzugsbezug speichern.
        if (!/fasching|faschings|umzug|faschingszug/i.test(content)) continue;
        const extracted = parseMessage(body, html);
        const tx = db.transaction(() => {
          const result = insertEmail.run({
            uid, received_at: (msg.internalDate || new Date()).toISOString(),
            from_addr: from, subject, body: body.slice(0, 30000),
            parsed_json: JSON.stringify(extracted), status: extracted.records.some(r => r.confidence === "Prüfen") ? "Prüfen" : "Ausgewertet"
          });
          if (!result.changes) return;
          const emailId = selectEmail.get(uid).id;
          for (const r of extracted.records) {
            const parades = r.parade ? [r.parade] : extracted.foundEvents;
            if (parades.length) for (const parade of parades) insertParticipant.run(emailId, r.name, r.age, parade, r.email, r.phone, r.notes, r.confidence);
            else insertParticipant.run(emailId, r.name, r.age, "", r.email, r.phone, r.notes, "Prüfen");
          }
        });
        tx();
      }
    } finally { mailboxLock.release(); }
    lastRefresh = new Date().toISOString();
    return { ok: true, refreshedAt: lastRefresh };
  } finally {
    try { await client?.logout(); } catch {}
    refreshing = false;
  }
}
app.post("/api/refresh", requireAuth, async (req, res) => {
  try { res.json(await refreshMailbox()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/dashboard", requireAuth, (req, res) => {
  const participants = db.prepare(`SELECT p.*, e.subject, e.received_at, e.from_addr
    FROM participants p JOIN emails e ON e.id=p.email_id ORDER BY e.received_at DESC`).all();
  const emails = db.prepare("SELECT id,received_at,from_addr,subject,status FROM emails ORDER BY received_at DESC").all();
  res.json({ events: EVENTS, participants, emails, lastRefresh });
});
app.post("/api/register", async (req, res) => {
  const { name, age, email, phone, events, notes } = req.body || {};
  if (!name || !email || !phone || !Number.isInteger(Number(age)) || Number(age) < 18 ||
      !Array.isArray(events) || !events.length || events.some(e => !EVENTS.includes(e))) {
    return res.status(400).json({ error: "Bitte prüfe deine Angaben. Teilnahme erst ab 18 Jahren." });
  }
  if (!process.env.GMX_EMAIL || !process.env.GMX_APP_PASSWORD) return res.status(503).json({ error: "Anmeldung ist noch nicht vollständig eingerichtet." });
  const body = `Neue Faschings-Anmeldung 2027\n\nName: ${clean(name)}\nFaschingsumzüge: ${events.join(", ")}\nE-Mail: ${clean(email)}\nTelefonnummer: ${clean(phone)}\nAlter: ${Number(age)}${notes ? `\nAnmerkungen: ${clean(notes)}` : ""}`;
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.GMX_SMTP_HOST || "mail.gmx.net",
      port: Number(process.env.GMX_SMTP_PORT || 587),
      secure: false,
      auth: { user: process.env.GMX_EMAIL, pass: process.env.GMX_APP_PASSWORD }
    });
    await transporter.sendMail({ from: process.env.GMX_EMAIL, to: process.env.GMX_EMAIL, replyTo: email, subject: "Neue Faschings-Anmeldung 2027", text: body });
    res.json({ ok: true, message: "Danke! Deine Anmeldung wurde übermittelt." });
  } catch (e) { res.status(500).json({ error: "Die Anmeldung konnte gerade nicht versendet werden." }); }
});
app.use(express.static("public"));
app.listen(PORT, () => {
  console.log(`Fasching 2027 läuft auf Port ${PORT}`);
  const minutes = Math.max(5, Number(process.env.AUTO_REFRESH_MINUTES || 5));
  setInterval(() => refreshMailbox().catch(e => console.error("GMX-Abruf:", e.message)), minutes * 60 * 1000);
  setTimeout(() => refreshMailbox().catch(e => console.error("Erster GMX-Abruf:", e.message)), 8000);
});