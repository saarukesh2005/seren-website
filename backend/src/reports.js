// Sales reports and the end-of-day closing sheet. All dates are India dates (YYYY-MM-DD).
import { esc, rupees } from "./util.js";

// India local date/hour of a stored UTC time, in SQL.
const IST_DAY = "date(paid_at, '+330 minutes')";
const IST_HOUR = "CAST(strftime('%H', paid_at, '+330 minutes') AS INTEGER)";
// Sales = bills that weren't refunded. (Tab rounds aren't bills; their one combined tab bill is.)
const SOLD = `invoice_no IS NOT NULL AND credit_note_no IS NULL AND ${IST_DAY} BETWEEN ?1 AND ?2`;

export async function salesReport(db, from, to) {
  const q = (sql) => db.prepare(sql).bind(from, to);
  const [totals, byDay, byHour, byMethod, byMode, byChannel, items, refunds, coupons, rating] = await db.batch([
    q(`SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue, COALESCE(SUM(discount), 0) AS discounts, COALESCE(SUM(delivery_fee), 0) AS delivery FROM orders WHERE ${SOLD}`),
    q(`SELECT ${IST_DAY} AS day, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE ${SOLD} GROUP BY day ORDER BY day`),
    q(`SELECT ${IST_HOUR} AS hour, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE ${SOLD} GROUP BY hour ORDER BY hour`),
    q(`SELECT payment_method AS k, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE ${SOLD} GROUP BY k ORDER BY revenue DESC`),
    q(`SELECT mode AS k, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE ${SOLD} GROUP BY k ORDER BY revenue DESC`),
    q(`SELECT channel AS k, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE ${SOLD} GROUP BY k ORDER BY revenue DESC`),
    q(`SELECT json_extract(j.value, '$.name') AS name, SUM(json_extract(j.value, '$.qty')) AS qty, SUM(json_extract(j.value, '$.gross')) AS revenue
       FROM orders o, json_each(o.lines) j WHERE ${SOLD} GROUP BY json_extract(j.value, '$.id') ORDER BY revenue DESC LIMIT 20`),
    q("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM orders WHERE credit_note_no IS NOT NULL AND credit_note_date BETWEEN ?1 AND ?2"),
    q(`SELECT coupon_code AS code, COUNT(*) AS orders, SUM(discount) AS discount FROM orders WHERE ${SOLD} AND coupon_code != '' GROUP BY coupon_code ORDER BY orders DESC`),
    q("SELECT COUNT(*) AS n, AVG(stars) AS avg FROM feedback WHERE date(at, '+330 minutes') BETWEEN ?1 AND ?2"),
  ]);
  const t = totals.results[0];
  return {
    from, to,
    totals: { ...t, average: t.orders ? Math.round(t.revenue / t.orders) : 0 },
    byDay: byDay.results, byHour: byHour.results, byMethod: byMethod.results, byMode: byMode.results, byChannel: byChannel.results,
    topItems: items.results, refunds: refunds.results[0], coupons: coupons.results,
    rating: { count: rating.results[0].n, average: rating.results[0].avg ? Number(rating.results[0].avg.toFixed(1)) : null },
  };
}

// End-of-day closing: what came in by each payment method, refunds, bill numbers used, cash to expect.
export async function dayClose(db, day) {
  const [byMethod, range, refunds, counts] = await db.batch([
    db.prepare(`SELECT payment_method AS k, COUNT(*) AS n, SUM(total) AS amount FROM orders WHERE invoice_no IS NOT NULL AND invoice_date = ?1 GROUP BY k`).bind(day),
    db.prepare("SELECT MIN(invoice_no) AS first, MAX(invoice_no) AS last, COUNT(*) AS n FROM orders WHERE invoice_date = ?1").bind(day),
    db.prepare("SELECT refund_method AS k, COUNT(*) AS n, SUM(total) AS amount FROM orders WHERE credit_note_date = ?1 GROUP BY k").bind(day),
    db.prepare("SELECT mode AS k, COUNT(*) AS n FROM orders WHERE invoice_date = ?1 GROUP BY k").bind(day),
  ]);
  const sum = (rows) => rows.reduce((n, r) => n + (r.amount || 0), 0);
  const cashIn = byMethod.results.find((r) => r.k === "cash")?.amount || 0;
  const cashOut = refunds.results.find((r) => r.k === "cash")?.amount || 0;
  return {
    day, byMethod: byMethod.results, bills: range.results[0], refunds: refunds.results, byMode: counts.results,
    gross: sum(byMethod.results), refunded: sum(refunds.results), net: sum(byMethod.results) - sum(refunds.results), cashExpected: cashIn - cashOut,
  };
}

export function dayCloseHtml(d, storeName, by) {
  const rows = (list, empty) => (list.length ? list.map((r) => `<tr><td>${esc(String(r.k).toUpperCase())}</td><td>${r.n}</td><td class="r">${esc(rupees(r.amount || 0))}</td></tr>`).join("") : `<tr><td colspan="3">${empty}</td></tr>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Day closing ${esc(d.day)}</title>
<style>
  body{margin:0;font:15px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif;background:#f3ece2;color:#140c0e}
  main{max-width:520px;margin:20px auto;background:#fff;padding:24px 26px;box-shadow:0 10px 40px rgba(20,12,14,.12)}
  h1{margin:0;font-size:22px;letter-spacing:.08em;text-transform:uppercase;color:#662937} h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;margin:18px 0 6px;color:#6b5a55}
  table{width:100%;border-collapse:collapse} td{padding:5px 2px;border-bottom:1px solid #e3d6c4} .r{text-align:right}
  .big td{font-size:18px;font-weight:800;border-top:2px solid #140c0e} .sign{margin-top:36px;display:flex;justify-content:space-between;color:#6b5a55}
  .bar{text-align:center;margin-top:14px} button{font:inherit;border:0;border-radius:99px;padding:8px 18px;background:#662937;color:#fff;cursor:pointer}
  @media print{body{background:#fff}main{box-shadow:none;margin:0}.bar{display:none}}
</style></head><body><main>
  <h1>${esc(storeName)} · Day closing</h1>
  <div>${esc(new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }))}</div>
  <h2>Sales by payment</h2><table>${rows(d.byMethod, "No bills today")}</table>
  <h2>Refunds</h2><table>${rows(d.refunds, "No refunds")}</table>
  <h2>Totals</h2><table>
    <tr><td>Bills issued</td><td class="r">${d.bills.n}${d.bills.n ? ` (${esc(d.bills.first)} to ${esc(d.bills.last)})` : ""}</td></tr>
    <tr><td>Gross sales</td><td class="r">${esc(rupees(d.gross))}</td></tr>
    <tr><td>Refunded</td><td class="r">−${esc(rupees(d.refunded))}</td></tr>
    <tr class="big"><td>Net sales</td><td class="r">${esc(rupees(d.net))}</td></tr>
    <tr class="big"><td>Cash that should be in the drawer</td><td class="r">${esc(rupees(d.cashExpected))}</td></tr>
  </table>
  <div class="sign"><span>Prepared by ${esc(by)}</span><span>Signature ____________</span></div>
  <div class="bar"><button onclick="print()">Print</button></div>
</main></body></html>`;
}
