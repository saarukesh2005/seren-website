// Kitchen ticket (KOT): what to make, for which table or customer. No prices. Prints on an 80 mm receipt printer.
import { esc } from "./util.js";

export function kotHtml(order, { autoprint = false } = {}) {
  const where = order.mode === "dinein" ? `TABLE ${order.table_no}` : order.mode === "delivery" ? "DELIVERY" : order.mode === "pickup" ? "PICKUP" : "COUNTER";
  const when = order.mode === "pickup" || order.mode === "delivery" ? `${order.slot_date} · ${order.slot_time}` : new Date(order.created_at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KOT ${esc(order.code)}</title>
<style>
  *{box-sizing:border-box} body{margin:0;font:16px/1.35 -apple-system,"Segoe UI",Roboto,sans-serif;color:#000;background:#fff}
  .t{max-width:80mm;margin:0 auto;padding:6px}
  .w{font-size:26px;font-weight:900;letter-spacing:.04em;border:3px solid #000;text-align:center;padding:4px;margin:4px 0}
  .c{display:flex;justify-content:space-between;font-weight:700} ul{list-style:none;margin:8px 0;padding:0}
  li{display:flex;gap:10px;font-size:20px;font-weight:700;padding:5px 0;border-bottom:1px dashed #000} li b{min-width:36px}
  .n{border:2px solid #000;padding:6px;font-weight:700;margin-top:8px} .s{font-size:12px;margin-top:8px}
  @media print{@page{size:80mm auto;margin:2mm}}
</style></head><body><main class="t">
  <div class="c"><span>KOT · ${esc(order.code)}</span><span>${esc(when)}</span></div>
  <div class="w">${esc(where)}</div>
  ${order.customer_name ? `<div>${esc(order.customer_name)}</div>` : ""}
  <ul>${order.lines.map((l) => `<li><b>${l.qty}×</b><span>${esc(l.name)}</span></li>`).join("")}</ul>
  ${order.notes ? `<div class="n">NOTE: ${esc(order.notes)}</div>` : ""}
  <div class="s">${order.channel === "table" ? "Pay at the end (tab)" : order.invoice_no ? "Paid" : "Not paid yet"}</div>
</main>${autoprint ? "<script>addEventListener('load',()=>{print();setTimeout(()=>close(),500)})</script>" : ""}</body></html>`;
}
