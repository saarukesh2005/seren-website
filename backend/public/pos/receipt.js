/* Receipt for the counter: one model, printed as an 80 mm (or 58 mm) page.
   Works for a paid bill from the order system, and for a bill taken while offline (bill number comes later). */
(function (root) {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

  /**
   * @param {object} bill  a paid order from the server, or { offline: true, ref, lines, total, method, at }
   * @param {object} shop  settings: storeName, legalName, gstin, address, phone, invoiceNote
   */
  function receiptModel(bill, shop, extra = {}) {
    const offline = Boolean(bill.offline);
    const lines = (bill.lines || []).map((l) => ({ name: l.name, qty: Number(l.qty) || 0, amount: Number(l.listAmount ?? l.gross ?? l.amount) || 0 }));
    const snap = bill.tax_snapshot || {};
    const charges = (snap.charges || []).map((c) => ({ name: c.name, amount: Number(c.gross) || 0 }));
    const parts = Array.isArray(extra.payments) && extra.payments.length > 1 ? extra.payments.map((p) => ({ method: String(p.method || "").toUpperCase(), amount: Number(p.amount) || 0 })) : [];
    const tax = offline ? [] : ((bill.tax_snapshot && bill.tax_snapshot.taxSummary) || []).filter((r) => r.rate > 0);
    const at = new Date(offline ? bill.at : bill.paid_at || bill.created_at || Date.now());
    return {
      title: offline ? "ORDER SLIP" : shop.gstin ? "TAX INVOICE" : "BILL",
      shop: { name: shop.storeName || "SEREN", legal: shop.legalName || "", gstin: shop.gstin || "", address: shop.address || "", phone: shop.phone || "", fssai: shop.fssaiNo || "" },
      number: offline ? "" : bill.invoice_no || "",
      ref: offline ? bill.ref : bill.code,
      when: at.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }),
      table: bill.table_no || bill.table || "",
      customer: bill.customer_name || bill.name || "",
      lines,
      subtotal: bill.subtotal ?? lines.reduce((n, l) => n + l.amount, 0),
      discount: bill.discount || 0,
      coupon: bill.coupon_code || "",
      points: bill.points_used || 0,
      total: Number(bill.total) || 0,
      charges,
      roundOff: Number(snap.roundOff) || 0,
      parts,
      app: snap.platform ? `${snap.platform.name} ${bill.external_id || ""}`.trim() : "",
      tax,
      method: snap.platform ? snap.platform.name.toUpperCase() : parts.length ? "SPLIT" : String(bill.payment_method || bill.method || "").toUpperCase(),
      tendered: extra.tendered || 0,
      change: extra.tendered ? Math.max(extra.tendered - bill.total, 0) : 0,
      note: offline ? "Bill number will be issued when the shop is back online. Keep this slip." : shop.invoiceNote || "",
      cashier: extra.cashier || "",
    };
  }

  function receiptHtml(m, { width = 80 } = {}) {
    const row = (left, right, cls = "") => `<div class="r ${cls}"><span>${left}</span><b>${right}</b></div>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.title)} ${esc(m.number || m.ref)}</title><style>
      @page{size:${width}mm auto;margin:2mm}
      *{box-sizing:border-box} body{margin:0;width:${width - 4}mm;font:12px/1.35 Arial,Helvetica,sans-serif;color:#000}
      .c{text-align:center} .shop{font-size:18px;font-weight:900;letter-spacing:.12em} .t{font-weight:700;letter-spacing:.08em;margin-top:4px}
      .muted{font-size:10.5px} hr{border:0;border-top:1px dashed #000;margin:5px 0}
      .r{display:flex;justify-content:space-between;gap:6px} .r span{flex:1} .r b{white-space:nowrap;font-weight:600}
      .it{margin:2px 0} .it .q{font-size:11px} .big{font-size:16px;font-weight:900} .big b{font-weight:900}
      .slip{border:2px solid #000;padding:3px;margin:4px 0;text-align:center;font-weight:700}
    </style></head><body>
      <div class="c"><div class="shop">${esc(m.shop.name)}</div>
        ${m.shop.legal ? `<div class="muted">${esc(m.shop.legal)}</div>` : ""}
        ${m.shop.address ? `<div class="muted">${esc(m.shop.address)}</div>` : ""}
        ${m.shop.phone ? `<div class="muted">${esc(m.shop.phone)}</div>` : ""}
        ${m.shop.gstin && m.number ? `<div class="muted">GSTIN ${esc(m.shop.gstin)}</div>` : ""}
        ${m.shop.fssai ? `<div class="muted">FSSAI Lic. No. ${esc(m.shop.fssai)}</div>` : ""}
        <div class="t">${esc(m.title)}</div></div>
      <hr>
      ${m.number ? row("Bill no.", esc(m.number)) : ""}
      ${row("Ref", esc(m.ref))}
      ${row("Date", esc(m.when))}
      ${m.table ? row("Table", esc(m.table)) : ""}
      ${m.customer ? row("Customer", esc(m.customer)) : ""}
      <hr>
      ${m.lines.map((l) => `<div class="it">${row(`${esc(l.name)}<div class="q">${Number(l.qty) || 0} ×</div>`, esc(money(l.amount)))}</div>`).join("")}
      ${(m.charges || []).map((c) => row(esc(c.name), esc(money(c.amount)))).join("")}
      <hr>
      ${m.discount ? row("Subtotal", esc(money(m.subtotal))) + row(`Discount${m.coupon ? ` (${esc(m.coupon)})` : ""}${m.points ? ` · ${Number(m.points) || 0} pts` : ""}`, `−${esc(money(m.discount))}`) : ""}
      ${m.tax.map((r) => row(`GST ${Number(r.rate) || 0}% (CGST ${esc(money(r.cgst))} + SGST ${esc(money(r.sgst))})`, esc(money(r.tax)), "muted")).join("")}
      ${m.roundOff ? row("Round off", `${m.roundOff > 0 ? "+" : "−"}${esc(money(Math.abs(m.roundOff)))}`, "muted") : ""}
      ${row("TOTAL", esc(money(m.total)), "big")}
      ${m.method ? row("Paid by", esc(m.method)) : ""}
      ${(m.parts || []).map((p) => row(`· ${esc(p.method)}`, esc(money(p.amount)))).join("")}
      ${m.app ? `<div class="c muted">${esc(m.app)} order · GST paid by the app</div>` : ""}
      ${m.tendered ? row("Cash given", esc(money(m.tendered))) + row("Change", esc(money(m.change))) : ""}
      ${m.number === "" && m.title === "ORDER SLIP" ? `<div class="slip">NOT A TAX INVOICE</div>` : ""}
      <hr>
      <div class="c muted">${esc(m.note)}</div>
      ${m.cashier ? `<div class="c muted">Served by ${esc(m.cashier)}</div>` : ""}
      <div class="c muted">Thank you · SEREN</div>
    </body></html>`;
  }

  root.SerenReceipt = { receiptModel, receiptHtml, money };
})(typeof window !== "undefined" ? window : globalThis);
