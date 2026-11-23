// Dashboard API: cash drawer shifts, cash in/out, expenses, and the GST pack for the accountant.
import { can } from "./auth.js";
import { HttpError, json, readJson } from "./http.js";
import { PARTS, buildGstReport, csvText, dateRange, gstCsv, loadGstData } from "./gst-report.js";
import * as shifts from "./shifts.js";
import { audit } from "./staff.js";
import * as store from "./store.js";
import { istParts, rupees } from "./util.js";

/* ---------- the drawer ---------- */
// Cashiers get a blind view: no expected cash and no cash totals, so they must count honestly.
export async function getShift({ env, user }) {
  const open = await shifts.currentShift(env.DB);
  if (!open) return json({ shift: null });
  const s = await shifts.shiftSummary(env.DB, open);
  const trusted = can(user, "reports");
  return json({
    shift: {
      id: open.id, openedBy: open.opened_by, openedAt: open.opened_at, float: open.float, bills: s.bills, moves: s.moves,
      ...(trusted ? { byMethod: s.byMethod, cashIn: s.cashIn, cashOut: s.cashOut } : {}),
    },
    blind: !trusted,
  });
}

export async function open({ env, request, user }) {
  const body = await readJson(request);
  const float = shifts.paise(body.float, "Cash to start with");
  const id = await shifts.openShift(env.DB, user, float);
  await audit(env.DB, user, "shift opened", `Drawer #${id} with ${rupees(float)}`);
  return json({ id }, 201);
}

export async function close({ env, request, user }) {
  const body = await readJson(request);
  const counted = shifts.paise(body.counted, "Cash counted");
  const note = String(body.note ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  const shift = await shifts.closeShift(env, env.DB, user, { counted, note });
  const verdict = shift.variance === 0 ? "exact" : shift.variance > 0 ? "over" : "short";
  return json({ shift, verdict });
}

export async function cash({ env, request, user }) {
  const move = shifts.checkCashMove(await readJson(request));
  const saved = await shifts.addCashMove(env.DB, user, move);
  const text = `${move.kind === "in" ? "Cash in" : "Cash out"} ${rupees(move.amount)}: ${saved.reason}`;
  // money taken out of the drawer is told to the owner (when someone else does it)
  await audit(env.DB, user, move.kind === "out" ? "cash taken out" : "cash put in", text, move.kind === "out" ? env : null);
  return json({ id: saved.id, expense: saved.expense }, 201);
}

export async function history({ env, url }) {
  const limit = Number(url.searchParams.get("limit")) || 30;
  return json({ shifts: await shifts.shiftHistory(env.DB, limit) });
}

/* ---------- expenses ---------- */
export async function expenses({ env, url }) {
  const { from, to } = dateRange(url, istParts().date, 30);
  return json(await shifts.listExpenses(env.DB, from, to));
}

export async function addExpense({ env, request, user }) {
  const e = shifts.checkExpense(await readJson(request), istParts().date);
  const id = await shifts.addExpense(env.DB, user, e);
  await audit(env.DB, user, "expense added", `${e.category} ${rupees(e.amount)} by ${e.method} on ${e.day}`);
  return json({ id }, 201);
}

export async function deleteExpense({ env, params, user }) {
  const row = await shifts.deleteExpense(env.DB, user, Number(params[0]));
  await audit(env.DB, user, "expense deleted", `${row.category} ${rupees(row.amount)} on ${row.day}`);
  return json({ ok: true });
}

/* ---------- GST for the accountant ---------- */
async function report(env, url) {
  const { from, to } = dateRange(url, istParts().date, 30);
  const [data, settings] = await Promise.all([loadGstData(env.DB, store, from, to), store.getSettings(env.DB)]);
  return buildGstReport(from, to, { invoices: data.invoices, credits: data.credits, receipts: data.receipts, advances: data.advances, settings }, data.turnover);
}

export async function gst({ env, url }) {
  return json({ report: await report(env, url) });
}

export async function gstCsvDownload({ env, url, user }) {
  const part = url.searchParams.get("part") || "";
  if (!PARTS.includes(part)) throw new HttpError(400, `Choose one part: ${PARTS.join(", ")}`);
  const r = await report(env, url);
  await audit(env.DB, user, "gst csv exported", `${part} ${r.from} to ${r.to}`);
  return new Response(csvText(gstCsv(r, part)), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="seren-gst-${part}-${r.from}-to-${r.to}.csv"`, "Cache-Control": "no-store" },
  });
}
