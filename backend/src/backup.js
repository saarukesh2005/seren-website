// Backups: everything in the database as one JSON file (photos left out to keep it small).
// Downloadable from the dashboard, and sent to the owner's Telegram every night if Telegram is set up.
import { istParts } from "./util.js";

const TABLES = ["settings", "prices", "orders", "order_events", "counters", "coupons", "customers", "points_log", "tabs", "table_calls", "feedback", "products", "audit",
  "payments", "shifts", "cash_moves", "expenses", "ingredients", "recipes", "vendors", "purchases", "stock_moves"];

export async function backupJson(db) {
  const results = await db.batch(TABLES.map((t) => db.prepare(`SELECT * FROM ${t}`)));
  const data = Object.fromEntries(TABLES.map((t, i) => [t, results[i].results]));
  // never put login secrets in a backup file
  data.settings = data.settings.filter((r) => r.key !== "auth");
  data.tabs = data.tabs.map(({ bill_token: _bt, pin: _pin, ...t }) => t); // table bill links and PINs stay out of backups
  const staff = await db.prepare("SELECT id, name, role, active, created_at FROM staff").all();
  data.staff = staff.results;
  return JSON.stringify({ app: "seren-orders", version: 2, at: new Date().toISOString(), data });
}

export const backupName = (locked = false) => `seren-backup-${istParts().date}.json${locked ? ".locked" : ""}`;

// Cloudflare's crypto allows at most 100,000 PBKDF2 rounds; a long BACKUP_PASSWORD (12+ characters) makes up for it.
const ROUNDS = 100000;

/**
 * Locks the backup with the owner's BACKUP_PASSWORD (AES-256-GCM, key from PBKDF2-SHA256), so the
 * file sitting in Telegram is useless to anyone else. Open it with: node tools/open-backup.mjs <file>
 */
export async function lockBackup(text, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ROUNDS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  const b64 = (u) => btoa(String.fromCharCode(...u));
  let body = "";
  for (let i = 0; i < data.length; i += 0x8000) body += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return JSON.stringify({ app: "seren-orders", locked: "aes-256-gcm/pbkdf2-sha256", iterations: ROUNDS, salt: b64(salt), iv: b64(iv), data: btoa(body) });
}

// The nightly backup is only sent LOCKED: without a BACKUP_PASSWORD the owner gets a reminder instead of the data.
export async function sendBackupToTelegram(env, db) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const password = String(env.BACKUP_PASSWORD || "");
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  try {
    if (password.length < 12) {
      await fetch(`${api}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: "SEREN: tonight's backup was NOT sent, because it would travel unlocked. Set a backup password (npx wrangler secret put BACKUP_PASSWORD, 12+ characters) to get locked nightly backups. You can still download one from the dashboard." }) });
      return false;
    }
    const form = new FormData();
    form.append("chat_id", env.TELEGRAM_CHAT_ID);
    form.append("caption", "SEREN nightly backup (locked with your backup password). Open it with tools/open-backup.mjs.");
    form.append("document", new Blob([await lockBackup(await backupJson(db), password)], { type: "application/json" }), backupName(true));
    const res = await fetch(`${api}/sendDocument`, { method: "POST", body: form });
    if (!res.ok) console.error("backup to telegram failed", res.status);
    return res.ok;
  } catch (e) {
    console.error("backup to telegram failed", e.message);
    return false;
  }
}
