// Sales reports and the end-of-day closing sheet. All dates are India dates (YYYY-MM-DD).
import { esc, rupees } from "./util.js";

// India local date/hour of a stored UTC time, in SQL.
const IST_DAY = "date(paid_at, '+330 minutes')";
const IST_HOUR = "CAST(strftime('%H', paid_at, '+330 minutes') AS INTEGER)";
// Sales = bills that weren't refunded. (Tab rounds aren't bills; their one combined tab bill is.)
const SOLD = `invoice_no IS NOT NULL AND credit_note_no IS NULL AND ${IST_DAY} BETWEEN ?1 AND ?2`;
// The same, for the payments table (money in / out), by the India day it happened.
const PAID_DAY = "date(at, '+330 minutes')";

export const METHOD_NAMES = { cash: "Cash", upi: "UPI", card: "Card", platform: "Delivery apps", store_credit: "Store credit" };
const methodName = (k) => METHOD_NAMES[k] || String(k || "other").toUpperCase();

// One delivery app's sales, what it keeps, and what it will pay you.
function appRow(r, platforms) {
  const p = platforms.find((x) => x.id === r.k);
  const commission = p ? Number(p.commission) || 0 : 0;
  const commissionAmount = Math.round((r.revenue * commission) / 100);
  return { k: r.k, name: p ? p.name : String(r.k).toUpperCase(), orders: r.orders, revenue: r.revenue, commission, commissionAmount, appPays: r.revenue - commissionAmount };
}

export async function salesReport(db, from, to, platforms = []) {
  const q = (sql) => db.prepare(sql).bind(from, to);
  const [totals, byDay, byHour, byMethod, byMode, byChannel, items, refunds, coupons, rating, byPlatform] = await db.batch([
    q(`SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue, COALESCE(SUM(discount), 0) AS discounts, COALESCE(SUM(delivery_fee), 0) AS delivery FROM orders WHERE ${SOLD}`),
    q(`SELECT ${IST_DAY} AS day, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE ${SOLD} GROUP BY day ORDER BY day`),
    q(`SELECT ${IST_HOUR} AS hour, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE ${SOLD} GROUP BY hour ORDER BY hour`),
    // money received (bills and advances) less money refunded, by how it was paid
    q(`SELECT method AS k, COUNT(DISTINCT CASE WHEN kind != 'refund' THEN order_id END) AS orders,
         SUM(CASE WHEN kind = 'refund' THEN -amount ELSE amount END) AS revenue
       FROM payments WHERE ${PAID_DAY} BETWEEN ?1 AND ?2 GROUP BY method HAVING revenue != 0 ORDER BY revenue DESC`),
    q(`SELECT mode AS k, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE ${SOLD} GROUP BY k ORDER BY revenue DESC`),
    q(`SELECT channel AS k, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE ${SOLD} GROUP BY k ORDER BY revenue DESC`),
    q(`SELECT json_extract(j.value, '$.name') AS name, SUM(json_extract(j.value, '$.qty')) AS qty, SUM(json_extract(j.value, '$.gross')) AS revenue
       FROM orders o, json_each(o.lines) j WHERE ${SOLD} GROUP BY json_extract(j.value, '$.id') ORDER BY revenue DESC LIMIT 20`),
    q("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM orders WHERE credit_note_no IS NOT NULL AND credit_note_date BETWEEN ?1 AND ?2"),
    q(`SELECT coupon_code AS code, COUNT(*) AS orders, SUM(discount) AS discount FROM orders WHERE ${SOLD} AND coupon_code != '' GROUP BY coupon_code ORDER BY orders DESC`),
    q("SELECT COUNT(*) AS n, AVG(stars) AS avg FROM feedback WHERE date(at, '+330 minutes') BETWEEN ?1 AND ?2"),
    q(`SELECT platform AS k, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE ${SOLD} AND platform != '' GROUP BY platform ORDER BY revenue DESC`),
  ]);
  const t = totals.results[0];
  return {
    from, to,
    totals: { ...t, average: t.orders ? Math.round(t.revenue / t.orders) : 0 },
    byDay: byDay.results, byHour: byHour.results, byMethod: byMethod.results, byMode: byMode.results, byChannel: byChannel.results,
    byPlatform: byPlatform.results.map((r) => appRow(r, platforms)),
    topItems: items.results, refunds: refunds.results[0], coupons: coupons.results,
    rating: { count: rating.results[0].n, average: rating.results[0].avg ? Number(rating.results[0].avg.toFixed(1)) : null },
  };
}

// End-of-day closing: money in by method (bills and advances), refunds, expenses, drawer shifts, delivery apps, bill numbers used.
export async function dayClose(db, day, settings = {}) {
  const platforms = settings.platforms || [];
  const one = (sql) => db.prepare(sql).bind(day);
  const [moneyIn, refunds, range, modes, expenses, shiftRows, moves, apps] = await db.batch([
    one(`SELECT method AS k, COUNT(*) AS n, SUM(amount) AS amount, SUM(CASE WHEN kind = 'advance' THEN amount ELSE 0 END) AS advance
         FROM payments WHERE kind IN ('payment', 'advance') AND ${PAID_DAY} = ?1 GROUP BY method ORDER BY amount DESC`),
    one(`SELECT method AS k, COUNT(*) AS n, SUM(amount) AS amount FROM payments WHERE kind = 'refund' AND ${PAID_DAY} = ?1 GROUP BY method ORDER BY amount DESC`),
    one("SELECT MIN(invoice_no) AS first, MAX(invoice_no) AS last, COUNT(*) AS n FROM orders WHERE invoice_date = ?1"),
    one("SELECT mode AS k, COUNT(*) AS n FROM orders WHERE invoice_date = ?1 GROUP BY mode"),
    one("SELECT method AS k, COUNT(*) AS n, SUM(amount) AS amount FROM expenses WHERE day = ?1 GROUP BY method"),
    one(`SELECT id, opened_by, opened_at, closed_by, closed_at, float, counted, expected FROM shifts
         WHERE date(opened_at, '+330 minutes') = ?1 OR date(closed_at, '+330 minutes') = ?1 ORDER BY id`),
    one("SELECT kind, COALESCE(SUM(amount), 0) AS amount FROM cash_moves WHERE date(at, '+330 minutes') = ?1 GROUP BY kind"),
    one(`SELECT platform AS k, COUNT(*) AS orders, SUM(total) AS revenue FROM orders
         WHERE invoice_no IS NOT NULL AND credit_note_no IS NULL AND invoice_date = ?1 AND platform != '' GROUP BY platform ORDER BY revenue DESC`),
  ]);
  const sum = (rows, k = "amount") => rows.reduce((n, r) => n + (r[k] || 0), 0);
  const amountOf = (rows, k) => rows.find((r) => r.k === k)?.amount || 0;
  const moved = (kind) => moves.results.find((r) => r.kind === kind)?.amount || 0;
  const gross = sum(moneyIn.results);
  const refunded = sum(refunds.results);
  const owedByApps = amountOf(moneyIn.results, "platform") - amountOf(refunds.results, "platform");
  const appRows = apps.results.map((r) => appRow(r, platforms));
  return {
    day, bills: range.results[0], byMode: modes.results,
    byMethod: moneyIn.results, advances: sum(moneyIn.results, "advance"), refunds: refunds.results,
    gross, refunded, net: gross - refunded, inHand: gross - refunded - owedByApps,
    // cash movement today: cash taken less cash refunded, plus money put in, less money taken out of the drawer
    cashExpected: amountOf(moneyIn.results, "cash") - amountOf(refunds.results, "cash") + moved("in") - moved("out"),
    cashIn: moved("in"), cashOut: moved("out"),
    expenses: { rows: expenses.results, total: sum(expenses.results), cash: amountOf(expenses.results, "cash") },
    shifts: shiftRows.results.map((s) => ({ ...s, variance: s.closed_at ? s.counted - s.expected : null })),
    apps: appRows, appSales: sum(appRows, "revenue"), appCommission: sum(appRows, "commissionAmount"), appPays: sum(appRows, "appPays"),
  };
}

const istClock = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "");
const overShort = (v) => (v === 0 ? "Exact" : v > 0 ? `Over ${rupees(v)}` : `Short ${rupees(-v)}`);

export function dayCloseHtml(d, storeName, by) {
  const rows = (list, empty) => (list.length ? list.map((r) => `<tr><td>${esc(methodName(r.k))}</td><td>${r.n}</td><td class="r">${esc(rupees(r.amount || 0))}</td></tr>`).join("") : `<tr><td colspan="3">${empty}</td></tr>`);
  const shiftRows = d.shifts.length ? d.shifts.map((s) => `<tr><td>#${s.id} ${esc(s.opened_by)}<br><small>${esc(istClock(s.opened_at))}${s.closed_at ? ` to ${esc(istClock(s.closed_at))}` : " (still open)"}</small></td>
    <td class="r">${s.closed_at ? `${esc(rupees(s.expected))}<br><small>expected</small>` : "—"}</td>
    <td class="r">${s.closed_at ? `${esc(rupees(s.counted))}<br><small>counted</small>` : "—"}</td>
    <td class="r ${s.variance ? "off" : ""}">${s.closed_at ? esc(overShort(s.variance)) : ""}</td></tr>`).join("") : `<tr><td colspan="4">No cash drawer was opened today</td></tr>`;
  const appRows = d.apps.length ? d.apps.map((a) => `<tr><td>${esc(a.name)}<br><small>${a.orders} order${a.orders === 1 ? "" : "s"} · app keeps ${esc(a.commission)}%</small></td>
    <td class="r">${esc(rupees(a.revenue))}</td><td class="r">−${esc(rupees(a.commissionAmount))}</td><td class="r"><b>${esc(rupees(a.appPays))}</b></td></tr>`).join("") : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Day closing ${esc(d.day)}</title>
<style>
  body{margin:0;font:15px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif;background:#f3ece2;color:#140c0e}
  main{max-width:520px;margin:20px auto;background:#fff;padding:24px 26px;box-shadow:0 10px 40px rgba(20,12,14,.12)}
  h1{margin:0;font-size:22px;letter-spacing:.08em;text-transform:uppercase;color:#662937} h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;margin:18px 0 6px;color:#6b5a55}
  table{width:100%;border-collapse:collapse} td{padding:5px 2px;border-bottom:1px solid #e3d6c4;vertical-align:top} .r{text-align:right} small{color:#6b5a55}
  .off{color:#b3261e;font-weight:700}
  .big td{font-size:18px;font-weight:800;border-top:2px solid #140c0e} .sign{margin-top:36px;display:flex;justify-content:space-between;color:#6b5a55}
  .bar{text-align:center;margin-top:14px} button{font:inherit;border:0;border-radius:99px;padding:8px 18px;background:#662937;color:#fff;cursor:pointer}
  @media print{body{background:#fff}main{box-shadow:none;margin:0}.bar{display:none}}
</style></head><body><main>
  <h1>${esc(storeName)} · Day closing</h1>
  <div>${esc(new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }))}</div>
  <h2>Money in${d.advances ? ` (includes ${esc(rupees(d.advances))} advances)` : ""}</h2><table>${rows(d.byMethod, "No money taken today")}</table>
  <h2>Refunds</h2><table>${rows(d.refunds, "No refunds")}</table>
  <h2>Expenses</h2><table>
    <tr><td>Paid in cash</td><td class="r">${esc(rupees(d.expenses.cash))}</td></tr>
    <tr><td>Paid other ways (UPI, card, bank)</td><td class="r">${esc(rupees(d.expenses.total - d.expenses.cash))}</td></tr></table>
  <h2>Cash drawer</h2><table>${shiftRows}</table>
  ${d.apps.length ? `<h2>Delivery apps</h2><table><tr><td></td><td class="r"><small>Sales</small></td><td class="r"><small>App keeps</small></td><td class="r"><small>App pays you</small></td></tr>${appRows}
    <tr><td><b>Total</b></td><td class="r">${esc(rupees(d.appSales))}</td><td class="r">−${esc(rupees(d.appCommission))}</td><td class="r"><b>${esc(rupees(d.appPays))}</b></td></tr></table>` : ""}
  <h2>Totals</h2><table>
    <tr><td>Bills issued</td><td class="r">${d.bills.n}${d.bills.n ? ` (${esc(d.bills.first)} to ${esc(d.bills.last)})` : ""}</td></tr>
    <tr><td>Money in</td><td class="r">${esc(rupees(d.gross))}</td></tr>
    <tr><td>Refunded</td><td class="r">−${esc(rupees(d.refunded))}</td></tr>
    <tr class="big"><td>Net money in</td><td class="r">${esc(rupees(d.net))}</td></tr>
    <tr><td>Of this, still to come from delivery apps</td><td class="r">${esc(rupees(d.net - d.inHand))}</td></tr>
    <tr><td>Cash added to the drawer today (after refunds and pay-outs)</td><td class="r">${esc(rupees(d.cashExpected))}</td></tr>
  </table>
  <div class="sign"><span>Prepared by ${esc(by)}</span><span>Signature ____________</span></div>
  <div class="bar"><button id="printBtn">Print</button></div><script>document.getElementById("printBtn").addEventListener("click", () => print());</script>
</main></body></html>`;
}
