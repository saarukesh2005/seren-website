// Dashboard API: settings, sales reports, day closing, accounts export and backups.
import { backupJson, backupName, lockBackup } from "./backup.js";
import { CATEGORIES } from "./catalog.js";
import { dateRange, csvCell } from "./gst-report.js";
import { HttpError, json, readJson } from "./http.js";
import { dayClose, dayCloseHtml, salesReport } from "./reports.js";
import { checkSettings } from "./settings.js";
import { audit } from "./staff.js";
import * as store from "./store.js";
import { addDays, istParts } from "./util.js";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function getSettings({ env }) {
  return json({ settings: await store.getSettings(env.DB), categories: CATEGORIES, hasWhatsappToken: Boolean(env.WHATSAPP_TOKEN), hasTelegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) });
}

export async function putSettings({ env, request, user }) {
  const current = await store.getSettings(env.DB);
  const checked = checkSettings(await readJson(request), current);
  if (checked.error) throw new HttpError(400, checked.error);
  await store.saveSettings(env.DB, checked.value);
  const changed = Object.keys(checked.value).filter((k) => JSON.stringify(checked.value[k]) !== JSON.stringify(current[k]));
  if (changed.length) await audit(env.DB, user, "settings changed", changed.join(", "));
  return json({ settings: checked.value });
}

export async function report({ env, url }) {
  const today = istParts().date;
  const from = YMD.test(url.searchParams.get("from") || "") ? url.searchParams.get("from") : addDays(today, -6);
  const to = YMD.test(url.searchParams.get("to") || "") ? url.searchParams.get("to") : today;
  if (to < from) throw new HttpError(400, "The end date is before the start date");
  return json({ report: await salesReport(env.DB, from, to, (await store.getSettings(env.DB)).platforms) });
}

export async function closing({ env, url, user }, renderHtml) {
  const day = YMD.test(url.searchParams.get("date") || "") ? url.searchParams.get("date") : istParts().date;
  const settings = await store.getSettings(env.DB);
  await audit(env.DB, user, "day closing printed", day);
  return renderHtml(dayCloseHtml(await dayClose(env.DB, day, settings), settings.storeName, user.name));
}

// Bills and credit notes for a date range, one row per GST rate, ready for the accountant.
export async function exportCsv({ env, url, user }) {
  // at most 366 days at a time; with no dates it is the last 366 days
  const { from, to } = dateRange(url, istParts().date, 366);
  const [bills, credits] = await Promise.all([store.listInvoices(env.DB, from, to), store.listCreditNotes(env.DB, from, to)]);
  const rows = [["Document", "Number", "Date", "Against bill", "Order", "Source", "Customer", "Phone", "Customer GSTIN", "Payment", "UPI ref", "Discount", "GST rate %", "Taxable value", "CGST", "SGST", "Document total"]];
  const push = (o, kind) => {
    const sign = kind === "Credit note" ? -1 : 1;
    const m = (p) => ((sign * p) / 100).toFixed(2);
    const summary = o.tax_snapshot.taxSummary.length ? o.tax_snapshot.taxSummary : [{ rate: 0, taxable: o.total, cgst: 0, sgst: 0 }];
    summary.forEach((r, i) => rows.push([
      kind, kind === "Bill" ? o.invoice_no : o.credit_note_no, kind === "Bill" ? o.invoice_date : o.credit_note_date, kind === "Bill" ? "" : o.invoice_no,
      o.code, o.source, o.customer_name, o.customer_phone, o.customer_gstin, kind === "Bill" ? o.payment_method : o.refund_method, o.utr,
      i === 0 ? m(o.discount || 0) : "", r.rate, m(r.taxable), m(r.cgst), m(r.sgst), i === 0 ? m(o.total) : "",
    ]));
  };
  bills.forEach((o) => push(o, "Bill"));
  credits.forEach((o) => push(o, "Credit note"));
  await audit(env.DB, user, "accounts exported", `${from} to ${to}`);
  return new Response(rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="seren-bills.csv"', "Cache-Control": "no-store" },
  });
}

// ?locked=1 gives the same file locked with BACKUP_PASSWORD (as sent to Telegram each night).
export async function backup({ env, user, url }) {
  const locked = url.searchParams.get("locked") === "1";
  if (locked && String(env.BACKUP_PASSWORD || "").length < 12) throw new HttpError(409, "Set a backup password first (BACKUP_PASSWORD, 12+ characters)");
  await audit(env.DB, user, locked ? "locked backup downloaded" : "backup downloaded");
  const text = locked ? await lockBackup(await backupJson(env.DB), env.BACKUP_PASSWORD) : await backupJson(env.DB);
  return new Response(text, {
    headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${backupName(locked)}"`, "Cache-Control": "no-store" },
  });
}
