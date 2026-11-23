// Cash drawer: shifts (open / close with a blind count), cash in and out, and shop expenses.
// Money is whole paise. Every payment taken while a shift is open is tagged with that shift (see store.js),
// so "cash that should be in the drawer" = float + cash taken - cash refunded + money put in - money taken out.
import { HttpError } from "./http.js";
import { audit } from "./staff.js";
import { istParts, rupees } from "./util.js";

export const EXPENSE_CATEGORIES = ["Milk & dairy", "Groceries", "Packaging", "Gas", "Electricity", "Rent", "Salaries", "Repairs", "Other"];
export const EXPENSE_METHODS = ["cash", "upi", "card", "bank"];
const MAX_PAISE = 1_000_000_000; // ₹1 crore: anything bigger is a typing mistake
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const now = () => new Date().toISOString();

// A whole number of paise between min and max, or a friendly 400.
export function paise(value, what, min = 0) {
  if (!Number.isInteger(value) || value < min || value > MAX_PAISE) {
    throw new HttpError(400, min > 0 ? `${what}: enter an amount above zero` : `${what}: enter an amount (0 or more)`);
  }
  return value;
}

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/* ---------- the drawer ---------- */
export async function currentShift(db) {
  return db.prepare("SELECT id, opened_by, opened_at, float FROM shifts WHERE closed_at IS NULL").first();
}

export async function openShift(db, user, float) {
  try {
    const res = await db.prepare("INSERT INTO shifts (opened_by, opened_at, float) VALUES (?1, ?2, ?3)").bind(user.name, now(), float).run();
    return res.meta.last_row_id;
  } catch (e) {
    if (!String(e.message).includes("UNIQUE")) throw e;
    const open = await currentShift(db);
    throw new HttpError(409, open ? `A drawer is already open (opened by ${open.opened_by}). Close it first.` : "A drawer is already open. Close it first.");
  }
}

// What happened in one shift, and (for people allowed to see it) the cash that should be in the drawer.
export async function shiftSummary(db, shift) {
  const [pay, moveTotals, bills, moves] = await db.batch([
    db.prepare("SELECT kind, method, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM payments WHERE shift_id = ?1 GROUP BY kind, method").bind(shift.id),
    db.prepare("SELECT kind, COALESCE(SUM(amount), 0) AS amount FROM cash_moves WHERE shift_id = ?1 GROUP BY kind").bind(shift.id),
    db.prepare("SELECT COUNT(DISTINCT order_id) AS n FROM payments WHERE shift_id = ?1 AND kind = 'payment'").bind(shift.id),
    db.prepare("SELECT id, kind, amount, reason, actor, at FROM cash_moves WHERE shift_id = ?1 ORDER BY id").bind(shift.id),
  ]);
  const methods = new Map();
  for (const r of pay.results) {
    const m = methods.get(r.method) || { method: r.method, received: 0, refunded: 0 };
    if (r.kind === "refund") m.refunded += r.amount; else m.received += r.amount;
    methods.set(r.method, m);
  }
  const cash = methods.get("cash") || { received: 0, refunded: 0 };
  const moved = (kind) => moveTotals.results.find((r) => r.kind === kind)?.amount || 0;
  const cashIn = moved("in");
  const cashOut = moved("out");
  return {
    byMethod: [...methods.values()].sort((a, b) => b.received - a.received),
    bills: bills.results[0].n,
    moves: moves.results,
    cashReceived: cash.received, cashRefunded: cash.refunded, cashIn, cashOut,
    expected: shift.float + cash.received - cash.refunded + cashIn - cashOut,
  };
}

// Same formula as shiftSummary, worked out inside the closing statement so a bill rung at that very moment can't be missed.
const EXPECTED_SQL = `float
  + COALESCE((SELECT SUM(amount) FROM payments WHERE shift_id = shifts.id AND method = 'cash' AND kind IN ('payment', 'advance')), 0)
  - COALESCE((SELECT SUM(amount) FROM payments WHERE shift_id = shifts.id AND method = 'cash' AND kind = 'refund'), 0)
  + COALESCE((SELECT SUM(amount) FROM cash_moves WHERE shift_id = shifts.id AND kind = 'in'), 0)
  - COALESCE((SELECT SUM(amount) FROM cash_moves WHERE shift_id = shifts.id AND kind = 'out'), 0)`;

// Blind close: the person types what they counted; only afterwards do we say what was expected.
export async function closeShift(env, db, user, { counted, note }) {
  const open = await currentShift(db);
  if (!open) throw new HttpError(409, "There is no open drawer to close.");
  const res = await db.prepare(`UPDATE shifts SET closed_by = ?1, closed_at = ?2, counted = ?3, note = ?4, expected = ${EXPECTED_SQL}
    WHERE id = ?5 AND closed_at IS NULL`).bind(user.name, now(), counted, note, open.id).run();
  if (!res.meta.changes) throw new HttpError(409, "That drawer was just closed by someone else.");
  const row = await db.prepare("SELECT id, opened_by, opened_at, float, closed_by, closed_at, counted, expected, note FROM shifts WHERE id = ?1").bind(open.id).first();
  const variance = row.counted - row.expected;
  const verdict = variance === 0 ? "exact" : variance > 0 ? `over by ${rupees(variance)}` : `short by ${rupees(-variance)}`;
  // the owner is alerted on their phone only when the count doesn't match
  await audit(db, user, "shift closed", `Drawer #${row.id}: counted ${rupees(row.counted)}, expected ${rupees(row.expected)} (${verdict})`, variance !== 0 ? env : null);
  return shiftOut(row);
}

export function shiftOut(r) {
  const closed = r.closed_at !== null && r.closed_at !== undefined;
  return {
    id: r.id, openedBy: r.opened_by, openedAt: r.opened_at, float: r.float,
    closedBy: r.closed_by || null, closedAt: r.closed_at || null,
    counted: closed ? r.counted : null, expected: closed ? r.expected : null,
    variance: closed ? r.counted - r.expected : null, note: r.note || "",
  };
}

export async function shiftHistory(db, limit = 30) {
  const { results } = await db.prepare("SELECT id, opened_by, opened_at, float, closed_by, closed_at, counted, expected, note FROM shifts ORDER BY id DESC LIMIT ?1")
    .bind(Math.min(Math.max(limit, 1), 100)).all();
  return results.map(shiftOut);
}

/* ---------- cash in / out ---------- */
// "expense" as the reason also records a cash expense, in the same transaction.
export async function addCashMove(db, user, { kind, amount, reason, category, note }) {
  const isExpense = kind === "out" && reason.toLowerCase() === "expense";
  const cat = EXPENSE_CATEGORIES.includes(category) ? category : "Other";
  const why = isExpense ? `Expense: ${cat}${note ? ` - ${note}` : ""}`.slice(0, 120) : reason;
  const at = now();
  const open = "EXISTS (SELECT 1 FROM shifts WHERE closed_at IS NULL)";
  const stmts = [db.prepare(`INSERT INTO cash_moves (shift_id, kind, amount, reason, actor, at)
    SELECT id, ?1, ?2, ?3, ?4, ?5 FROM shifts WHERE closed_at IS NULL`).bind(kind, amount, why, user.name, at)];
  if (isExpense) {
    stmts.push(db.prepare(`INSERT INTO expenses (day, category, amount, method, note, actor, at) SELECT ?1, ?2, ?3, 'cash', ?4, ?5, ?6 WHERE ${open}`)
      .bind(istParts().date, cat, amount, note || "Paid from the drawer", user.name, at));
  }
  const res = await db.batch(stmts);
  if (!res[0].meta.changes) throw new HttpError(409, "Open the drawer first (Cash tab), then put money in or take it out.");
  return { id: res[0].meta.last_row_id, reason: why, expense: isExpense };
}

export function checkCashMove(body) {
  if (body.kind !== "in" && body.kind !== "out") throw new HttpError(400, "Say whether money goes in or out");
  const reason = clean(body.reason, 80);
  if (reason.length < 2) throw new HttpError(400, "Write a short reason");
  return { kind: body.kind, amount: paise(body.amount, "Amount", 1), reason, category: clean(body.category, 30), note: clean(body.note, 100) };
}

/* ---------- expenses ---------- */
export function checkExpense(body, today) {
  const day = body.day === undefined || body.day === "" ? today : String(body.day);
  if (!YMD.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new HttpError(400, "That date doesn't look right");
  if (day > today) throw new HttpError(400, "An expense can't be dated in the future");
  if (!EXPENSE_CATEGORIES.includes(body.category)) throw new HttpError(400, `Pick a category: ${EXPENSE_CATEGORIES.join(", ")}`);
  if (!EXPENSE_METHODS.includes(body.method)) throw new HttpError(400, "How was it paid? cash, UPI, card or bank");
  return { day, category: body.category, amount: paise(body.amount, "Amount", 1), method: body.method, note: clean(body.note, 200) };
}

export async function addExpense(db, user, e) {
  const res = await db.prepare("INSERT INTO expenses (day, category, amount, method, note, actor, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(e.day, e.category, e.amount, e.method, e.note, user.name, now()).run();
  return res.meta.last_row_id;
}

export async function listExpenses(db, from, to) {
  const [rows, byCategory, total] = await db.batch([
    db.prepare("SELECT id, day, category, amount, method, note, actor, at FROM expenses WHERE day BETWEEN ?1 AND ?2 ORDER BY day DESC, id DESC LIMIT 1000").bind(from, to),
    db.prepare("SELECT category AS k, COUNT(*) AS n, SUM(amount) AS amount FROM expenses WHERE day BETWEEN ?1 AND ?2 GROUP BY category ORDER BY amount DESC").bind(from, to),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM expenses WHERE day BETWEEN ?1 AND ?2").bind(from, to),
  ]);
  const today = istParts().date;
  return {
    from, to, total: total.results[0], byCategory: byCategory.results, categories: EXPENSE_CATEGORIES,
    expenses: rows.results.map((r) => ({ ...r, canDelete: istParts(new Date(r.at)).date === today })),
  };
}

// Owner or manager, and only on the day it was entered.
export async function deleteExpense(db, user, id) {
  if (user.role !== "owner" && user.role !== "manager") throw new HttpError(403, "Only the owner or a manager can delete an expense");
  const row = await db.prepare("SELECT id, day, category, amount, at FROM expenses WHERE id = ?1").bind(id).first();
  if (!row) throw new HttpError(404, "Expense not found");
  if (istParts(new Date(row.at)).date !== istParts().date) throw new HttpError(409, "An expense can only be deleted on the day it was entered");
  await db.prepare("DELETE FROM expenses WHERE id = ?1").bind(id).run();
  return row;
}
