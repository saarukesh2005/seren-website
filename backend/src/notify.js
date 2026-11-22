// Optional phone alerts to the owner through a free Telegram bot.
// Set TELEGRAM_BOT_TOKEN (secret) and TELEGRAM_CHAT_ID (variable) to switch it on.
import { rupees } from "./util.js";

export async function notifyOwner(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    if (!res.ok) console.error("telegram alert failed", res.status);
  } catch (e) {
    console.error("telegram alert failed", e.message);
  }
}

export const newOrderText = (o, adminUrl) =>
  `New SEREN order ${o.code}: ${rupees(o.total)}\n${o.name} · ${o.mode === "dinein" ? `dine-in, table ${o.table}` : `${o.mode} ${o.date} ${o.time}`}\n` +
  `${o.lines.map((l) => `${l.qty} × ${l.name}`).join("\n")}\nWaiting for UPI payment.\n${adminUrl}`;

export const paidClaimText = (o, utr, adminUrl) =>
  `${o.code}: customer says they paid ${rupees(o.total)} (UPI ref ${utr}). Check your bank app, then confirm.\n${adminUrl}`;
