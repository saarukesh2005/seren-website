// Dashboard API: tables, running tabs, waiter calls and the printable table QR links.
import { HttpError, json, readJson } from "./http.js";
import { billExtras, checkCart, priceOrder, summarise } from "./pricing.js";
import { loadCatalog, orderable } from "./products.js";
import { reserveStmts, shortage } from "./stock.js";
import { audit } from "./staff.js";
import * as store from "./store.js";
import { billToken, finishCall, mergeLines, moveTab, openCalls, openTab, openTabs, seatTable, tableKey, tabOrders } from "./tables.js";
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
  const tab = await seatTable(env.DB, table, { reseat: true }); // seating again gives a new PIN (and unlocks a locked tab)
  await audit(env.DB, user, "table seated", `Table ${table}`);
  return json({ ok: true, pin: tab.pin }, 201);
}

// Move guests to another table (or join two tables' tabs into one).
export async function moveTable({ env, params, request, user }) {
  const from = tableParam(params[0]);
  const body = await readJson(request);
  const to = tableParam(encodeURIComponent(String(body.to || "")));
  if (from.toLowerCase() === to.toLowerCase()) throw new HttpError(400, "Pick a different table");
  const how = await moveTab(env.DB, from, to);
  await audit(env.DB, user, how === "merged" ? "tables joined" : "table moved", `Table ${from} → ${to}`);
  return json({ ok: true, how });
}

// A waiter takes the order at the table on their phone: it goes to the kitchen as a round on the tab.
export async function captainOrder(c) {
  const { env, params, request, user } = c;
  const table = tableParam(params[0]);
  const body = await readJson(request);
  const tab = (await openTab(env.DB, table)) || (await seatTable(env.DB, table));
  if (tab.status !== "open") throw new HttpError(409, "This table's bill has already been made");
  const cart = checkCart(body.items);
  if (cart.error) throw new HttpError(400, cart.error);
  const settings = await store.getSettings(env.DB);
  const [prices, catalog] = await Promise.all([store.getPrices(env.DB), loadCatalog(env.DB)]);
  const priced = priceOrder(cart.value, orderable(catalog), prices, { ...settings, charges: { ...settings.charges, roundOff: false } }, "dinein", { service: false });
  if (priced.error) throw new HttpError(409, priced.error);
  const code = `SRN-${randomCode()}`;
  const today = istParts();
  const saved = await store.createOrder(env.DB, {
    code, tokenHash: await sha256hex(randomToken()), source: "counter", status: "on_tab", name: `Table ${table}`, mode: "dinein", table,
    date: today.date, time: today.time, notes: String(body.notes || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200),
    lines: priced.value.lines, subtotal: priced.value.subtotal, total: priced.value.total, taxSnapshot: snapshot(settings, priced.value),
    channel: "table", tabId: tab.id, actor: user.name,
  }, reserveStmts(env.DB, code, priced.value.lines, today.date, prices));
  if (saved.error === "tab") throw new HttpError(409, "This table's bill was just made. Re-open it to add more.");
  if (saved.error) throw new HttpError(409, (await shortage(env.DB, priced.value.lines, today.date, prices)) || "Something is sold out");
  await audit(env.DB, user, "waiter order", `Table ${table} ${code}`);
  return json({ code, pin: tab.pin }, 201);
}

// Turns a table's rounds into one bill. Guests then see it on their phones and can pay by UPI, or staff take cash/card.
export async function billTab({ env, params, request, user }) {
  const table = tableParam(params[0]);
  const tab = await openTab(env.DB, table);
  if (!tab) throw new HttpError(404, "No open tab for that table");
  if (tab.status !== "open") throw new HttpError(409, "This table's bill has already been made");
  const rounds = await tabOrders(env.DB, tab.id);
  if (!rounds.length) throw new HttpError(409, "Nothing has been ordered on this tab yet");
  const merged = mergeLines(rounds);
  const settings = await store.getSettings(env.DB);
  const body = request.headers.get("Content-Type")?.includes("json") ? await readJson(request) : {};
  const extras = billExtras(settings, merged.lines, "dinein", { service: body.service !== false });
  const code = `SRN-${randomCode()}`;
  const token = await billToken(env, code);
  const today = istParts();
  const saved = await store.createOrder(env.DB, {
    code, tokenHash: await sha256hex(token), source: "counter", status: "awaiting_payment",
    name: `Table ${table}`, mode: "dinein", table, date: today.date, time: today.time,
    lines: merged.lines, subtotal: merged.total, total: extras.total,
    taxSnapshot: snapshot(settings, { delivery: null, charges: extras.charges, roundOff: extras.roundOff, taxSummary: summarise([...merged.lines, ...extras.charges]) }),
    channel: "tab", tabId: tab.id, actor: user.name,
  }, [
    env.DB.prepare("UPDATE tabs SET status = 'billed', billed_at = ?1, bill_order_id = (SELECT id FROM orders WHERE code = ?2), bill_token = NULL WHERE id = ?3 AND status = 'open'")
      .bind(new Date().toISOString(), code, tab.id),
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
