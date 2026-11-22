// Dashboard API: tables, running tabs, waiter calls and the printable table QR links.
import { HttpError, json } from "./http.js";
import { audit } from "./staff.js";
import * as store from "./store.js";
import { finishCall, mergeLines, openCalls, openTab, openTabs, seatTable, tableKey, tabOrders } from "./tables.js";
import { TABLE } from "./settings.js";
import { snapshot } from "./routes-public.js";
import { istParts, randomCode, randomToken, sha256hex } from "./util.js";

export async function overview({ env }) {
  const [tabs, calls] = await Promise.all([openTabs(env.DB), openCalls(env.DB)]);
  return json({ tabs, calls });
}

export async function callDone({ env, params, user }) {
  await finishCall(env.DB, Number(params[0]), user);
  return json({ ok: true });
}

// Decodes a table name from the URL, or refuses it.
export function tableParam(raw) {
  let t;
  try { t = decodeURIComponent(raw); } catch { throw new HttpError(400, "Unknown table"); }
  if (!TABLE.test(t)) throw new HttpError(400, "Unknown table");
  return t;
}

export async function seat({ env, params, user }) {
  const table = tableParam(params[0]);
  await seatTable(env.DB, table);
  await audit(env.DB, user, "table seated", `Table ${table}`);
  return json({ ok: true }, 201);
}

// Turns a table's rounds into one bill. Guests then see it on their phones and can pay by UPI, or staff take cash/card.
export async function billTab({ env, params, user }) {
  const table = tableParam(params[0]);
  const tab = await openTab(env.DB, table);
  if (!tab) throw new HttpError(404, "No open tab for that table");
  if (tab.status !== "open") throw new HttpError(409, "This table's bill has already been made");
  const rounds = await tabOrders(env.DB, tab.id);
  if (!rounds.length) throw new HttpError(409, "Nothing has been ordered on this tab yet");
  const merged = mergeLines(rounds);
  const settings = await store.getSettings(env.DB);
  const token = randomToken();
  const code = `SRN-${randomCode()}`;
  const today = istParts();
  const saved = await store.createOrder(env.DB, {
    code, tokenHash: await sha256hex(token), source: "counter", status: "awaiting_payment",
    name: `Table ${table}`, mode: "dinein", table, date: today.date, time: today.time,
    lines: merged.lines, subtotal: merged.total, total: merged.total,
    taxSnapshot: snapshot(settings, { delivery: null, taxSummary: merged.taxSummary }),
    channel: "tab", tabId: tab.id, actor: user.name,
  }, [
    env.DB.prepare("UPDATE tabs SET status = 'billed', billed_at = ?1, bill_order_id = (SELECT id FROM orders WHERE code = ?2), bill_token = ?3 WHERE id = ?4 AND status = 'open'")
      .bind(new Date().toISOString(), code, token, tab.id),
  ]);
  if (saved.error) throw new HttpError(409, "Couldn't make the bill. Try again.");
  // the bill covers the rounds now, so their calls for the bill are done
  await env.DB.prepare("UPDATE table_calls SET done_at = ?1, done_by = ?2 WHERE table_no = ?3 AND kind = 'bill' AND done_at IS NULL").bind(new Date().toISOString(), user.name, table).run();
  await audit(env.DB, user, "table bill made", `Table ${table} ${code}`);
  return json({ code }, 201);
}

// Guests left without ordering: close the empty tab.
export async function closeEmpty({ env, params, user }) {
  const table = tableParam(params[0]);
  const tab = await openTab(env.DB, table);
  if (!tab || tab.status !== "open") throw new HttpError(409, "This table has no open tab");
  if ((await tabOrders(env.DB, tab.id)).length) throw new HttpError(409, "This table has orders. Make the bill instead.");
  await env.DB.prepare("UPDATE tabs SET status = 'closed', closed_at = ?1 WHERE id = ?2").bind(new Date().toISOString(), tab.id).run();
  await audit(env.DB, user, "empty table closed", `Table ${table}`);
  return json({ ok: true });
}

// Re-open a tab whose bill was made too early (the unpaid bill is cancelled).
export async function reopenTab({ env, params, user }) {
  const table = tableParam(params[0]);
  const tab = await openTab(env.DB, table);
  if (!tab || tab.status !== "billed") throw new HttpError(409, "This table has no bill to undo");
  const bill = await store.getOrderById(env.DB, tab.bill_order_id);
  if (bill.invoice_no) throw new HttpError(409, "The bill is already paid");
  await store.moveStatus(env.DB, bill, "cancelled", "Tab re-opened", user.name);
  await env.DB.prepare("UPDATE tabs SET status = 'open', bill_order_id = NULL, bill_token = NULL, billed_at = NULL WHERE id = ?1").bind(tab.id).run();
  await audit(env.DB, user, "table tab re-opened", `Table ${table}`);
  return json({ ok: true });
}

// Signed links for the printed table cards.
export async function tableLinks({ env }) {
  const settings = await store.getSettings(env.DB);
  const names = settings.dineInTables.split(",").map((t) => t.trim()).filter(Boolean);
  const list = names.length ? names : ["1", "2", "3", "4", "5", "6"];
  const base = settings.siteUrl.replace(/\/?$/, "/");
  const links = await Promise.all(list.map(async (t) => {
    const u = new URL(base);
    u.searchParams.set("table", t);
    u.searchParams.set("k", await tableKey(env, settings, t));
    return { table: t, url: u.toString() };
  }));
  return json({ links, custom: !names.length });
}
