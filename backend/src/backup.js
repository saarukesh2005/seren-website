// Backups: everything in the database as one JSON file (photos left out to keep it small).
// Downloadable from the dashboard, and sent to the owner's Telegram every night if Telegram is set up.
import { istParts } from "./util.js";

const TABLES = ["settings", "prices", "orders", "order_events", "counters", "coupons", "customers", "points_log", "tabs", "table_calls", "feedback", "products", "audit"];

export async function backupJson(db) {
  const results = await db.batch(TABLES.map((t) => db.prepare(`SELECT * FROM ${t}`)));
  const data = Object.fromEntries(TABLES.map((t, i) => [t, results[i].results]));
  // never put login secrets in a backup file
  data.settings = data.settings.filter((r) => r.key !== "auth");
  const staff = await db.prepare("SELECT id, name, role, active, created_at FROM staff").all();
  data.staff = staff.results;
  return JSON.stringify({ app: "seren-orders", version: 2, at: new Date().toISOString(), data });
}

export const backupName = () => `seren-backup-${istParts().date}.json`;

export async function sendBackupToTelegram(env, db) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const form = new FormData();
  form.append("chat_id", env.TELEGRAM_CHAT_ID);
  form.append("caption", "SEREN nightly backup. Keep this file somewhere safe.");
  form.append("document", new Blob([await backupJson(db)], { type: "application/json" }), backupName());
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
    if (!res.ok) console.error("backup to telegram failed", res.status);
    return res.ok;
  } catch (e) {
    console.error("backup to telegram failed", e.message);
    return false;
  }
}
