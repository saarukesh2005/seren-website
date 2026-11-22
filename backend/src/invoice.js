// Printable bill / GST tax invoice (A4 or 80 mm receipt printer).
import { STATUS } from "./status.js";
import { esc, rupees } from "./util.js";

const money = (p) => esc(rupees(p));
const fmtDate = (ymd) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "");

// credit = true prints the credit note for a refunded bill.
export function invoiceHtml(order, { size = "a4", credit = false } = {}) {
  const seller = order.tax_snapshot.seller;
  const gst = Boolean(seller.gstin);
  const paid = Boolean(order.invoice_no); // only orders whose payment was confirmed have a bill number
  const isCredit = credit && Boolean(order.credit_note_no);
  const title = isCredit ? "Credit Note" : !paid ? "Order summary (not paid yet)" : gst ? "Tax Invoice" : "Bill";
  const docNo = isCredit ? order.credit_note_no : order.invoice_no;
  const docDate = isCredit ? order.credit_note_date : order.invoice_date;
  const rows = [...order.lines, ...(order.tax_snapshot.delivery ? [{ ...order.tax_snapshot.delivery, qty: 1, unit: "" }] : [])];
  const summary = order.tax_snapshot.taxSummary.filter((r) => r.rate > 0);
  const narrow = size === "80mm";

  const lineRows = rows.map((l, i) => `<tr>
      <td>${i + 1}</td>
      <td>${esc(l.name)}${l.unit ? `<small>${esc(l.unit)}</small>` : ""}</td>
      ${gst && !narrow ? `<td>${esc(l.hsn || "")}</td>` : ""}
      <td class="r">${l.qty}</td>
      ${gst && !narrow ? `<td class="r">${money(l.taxable)}</td><td class="r">${l.rate}%</td>` : ""}
      <td class="r">${money(l.listAmount ?? l.gross)}</td>
    </tr>`).join("");
  const discountRows = order.discount
    ? `<tr><td>Subtotal</td><td class="r">${money(order.subtotal + (order.delivery_fee || 0))}</td></tr>
       <tr><td>Discount${order.coupon_code ? ` (${esc(order.coupon_code)})` : ""}${order.points_used ? ` · ${order.points_used} loyalty points` : ""}</td><td class="r">−${money(order.discount)}</td></tr>`
    : "";

  const taxRows = gst ? summary.map((r) => `<tr><td>GST ${r.rate}% on ${money(r.taxable)}</td><td class="r">CGST ${money(r.cgst)} · SGST ${money(r.sgst)}</td></tr>`).join("") : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} ${esc(docNo || order.code)}</title>
<style>
  :root{--ink:#140c0e;--plum:#662937;--line:#e3d6c4;--muted:#6b5a55}
  *{box-sizing:border-box} body{margin:0;background:#f3ece2;color:var(--ink);font:14px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif}
  .sheet{max-width:${narrow ? "80mm" : "210mm"};margin:24px auto;background:#fff;padding:${narrow ? "10px" : "36px 40px"};box-shadow:0 10px 40px rgba(20,12,14,.12)}
  h1{font-size:${narrow ? "16px" : "22px"};letter-spacing:.06em;text-transform:uppercase;color:var(--plum);margin:0 0 4px}
  .brand{font-size:${narrow ? "20px" : "30px"};font-weight:800;letter-spacing:.12em}
  .top{display:flex;${narrow ? "flex-direction:column;" : "justify-content:space-between;"}gap:16px;border-bottom:2px solid var(--plum);padding-bottom:14px;margin-bottom:14px}
  .muted{color:var(--muted)} small{display:block;color:var(--muted);font-size:12px}
  .meta{display:grid;grid-template-columns:${narrow ? "1fr" : "1fr 1fr"};gap:12px;margin-bottom:14px}
  table{width:100%;border-collapse:collapse} th,td{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)} .r{text-align:right;white-space:nowrap}
  .totals td{border:0;padding:3px 4px} .grand td{font-size:${narrow ? "16px" : "18px"};font-weight:800;border-top:2px solid var(--ink);padding-top:8px}
  .stamp{display:inline-block;border:2px solid var(--plum);color:var(--plum);padding:2px 10px;font-weight:800;letter-spacing:.1em;transform:rotate(-4deg)}
  .foot{margin-top:18px;font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:12px;${narrow ? "flex-direction:column" : ""}}
  .bar{max-width:${narrow ? "80mm" : "210mm"};margin:16px auto 0;display:flex;gap:8px;justify-content:flex-end;padding:0 8px}
  .bar button,.bar a{font:inherit;border:0;border-radius:99px;padding:8px 16px;background:var(--plum);color:#fff;cursor:pointer;text-decoration:none}
  .bar a{background:#fff;color:var(--ink)}
  @media print{body{background:#fff}.sheet{box-shadow:none;margin:0;max-width:none}.bar{display:none}@page{size:${narrow ? "80mm auto" : "A4"};margin:${narrow ? "2mm" : "12mm"}}}
</style></head><body>
<div class="bar"><a href="?${new URLSearchParams({ ...(order._token ? { t: order._token } : {}), size: narrow ? "a4" : "80mm" })}">${narrow ? "A4 size" : "Receipt size"}</a><button onclick="print()">Print / Save PDF</button></div>
<main class="sheet">
  <div class="top">
    <div>
      <div class="brand">${esc(seller.storeName)}</div>
      ${seller.legalName ? `<div>${esc(seller.legalName)}</div>` : ""}
      ${seller.address ? `<div class="muted">${esc(seller.address)}</div>` : ""}
      ${seller.phone ? `<div class="muted">${esc(seller.phone)}</div>` : ""}
      ${gst ? `<div><b>GSTIN</b> ${esc(seller.gstin)}</div>` : ""}
    </div>
    <div ${narrow ? "" : 'style="text-align:right"'}>
      <h1>${esc(title)}</h1>
      ${docNo ? `<div><b>No.</b> ${esc(docNo)}</div><div><b>Date</b> ${esc(fmtDate(docDate))}</div>` : ""}
      ${isCredit ? `<div><b>Against bill</b> ${esc(order.invoice_no)} of ${esc(fmtDate(order.invoice_date))}</div>` : ""}
      <div><b>Order</b> ${esc(order.code)}</div>
      ${isCredit ? `<div class="stamp">Refunded</div>` : order.credit_note_no ? `<div class="stamp">Refunded · ${esc(order.credit_note_no)}</div>` : order.status === "cancelled" ? `<div class="stamp">Cancelled</div>` : paid ? `<div class="stamp">Paid</div>` : ""}
    </div>
  </div>
  <div class="meta">
    <div><small>Billed to</small>${esc(order.customer_name || "Walk-in customer")}${order.customer_phone ? `<br>${esc(order.customer_phone)}` : ""}
      ${order.customer_gstin ? `<br>GSTIN ${esc(order.customer_gstin)}` : ""}${order.address ? `<br><span class="muted">${esc(order.address)} ${esc(order.pincode)}</span>` : ""}</div>
    <div><small>${{ delivery: "Delivery", pickup: "Pickup", dinein: "Dine-in", counter: "At the counter" }[order.mode]}</small>
      ${order.table_no ? `Table ${esc(order.table_no)}<br>` : ""}
      ${order.slot_date ? `${esc(fmtDate(order.slot_date))} · ${esc(order.slot_time)}<br>` : ""}
      ${gst && seller.stateName ? `Place of supply: ${esc(seller.stateName)}<br>` : ""}
      Payment: ${esc(order.payment_method.toUpperCase())}${order.utr ? ` · Ref ${esc(order.utr)}` : ""}
      ${isCredit ? `<br>Refund: ${esc(String(order.refund_method).toUpperCase())}${order.refund_ref ? ` · ${esc(order.refund_ref)}` : ""}` : ""}</div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Item</th>${gst && !narrow ? "<th>HSN</th>" : ""}<th class="r">Qty</th>${gst && !narrow ? '<th class="r">Taxable</th><th class="r">GST</th>' : ""}<th class="r">Amount</th></tr></thead>
    <tbody>${lineRows}</tbody>
  </table>
  <table class="totals" style="margin-top:8px">
    ${discountRows}
    ${taxRows}
    ${gst ? `<tr><td>${seller.pricesIncludeGst ? "Prices include GST" : "GST added to prices"}</td><td class="r">Total GST ${money(summary.reduce((n, r) => n + r.tax, 0))}</td></tr>` : ""}
    <tr class="grand"><td>${isCredit ? "Amount refunded" : "Total"}</td><td class="r">${money(order.total)}</td></tr>
  </table>
  <div class="foot">
    <span>${esc(seller.invoiceNote || "")}</span>
    <span>${gst ? `This is a computer-generated ${isCredit ? "credit note" : "invoice"}.` : esc(STATUS[order.status] || "")}</span>
  </div>
</main></body></html>`;
}
