/* Taking payment: cash (with change due), UPI (QR with the exact amount, also on the customer screen)
   or card. Then the bill is saved (or queued if offline), the receipt prints, and the counter clears. */
window.POSPay = (function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const { money, receiptModel } = SerenReceipt;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let busy = false;

  function payload(method) {
    const ex = POSUI.extras();
    return {
      items: POSUI.lines().map((l) => (l.opts.length ? { id: l.id, qty: l.qty, opts: l.opts } : { id: l.id, qty: l.qty })), method,
      name: ex.name, phone: ex.phone, table: ex.table, coupon: ex.coupon, points: ex.points, packing: ex.packing, notes: ex.notes,
      ...(ex.discount ? { discount: ex.discount } : {}),
    };
  }

  // The UPI QR. Online, the UPI ID comes from the order system with the price (not from what this PC remembers).
  function upiLink(amount, ref, upi) {
    const id = upi ? upi.id : (POS.settings || {}).upiId;
    if (!id) return "";
    const p = new URLSearchParams({ pa: id, pn: (upi ? upi.name : (POS.settings || {}).upiName) || "SEREN", am: (amount / 100).toFixed(2), cu: "INR", tn: `SEREN bill ${ref}` });
    return `upi://pay?${p.toString().replace(/\+/g, "%20")}`;
  }

  // The exact amount (after coupon, points, discount, packing, round-off) from the order system; offline, the shelf prices.
  async function amountFor(body) {
    if (POS.online) {
      try {
        const { quote, body: approved } = await POS.quote(body);
        POSUI.setQuote(quote.total);
        return { total: quote.total, exact: true, upi: quote.upi, body: approved };
      } catch (e) {
        if (!(e instanceof POS.NetworkError)) throw e;
      }
    }
    if (body.coupon || body.points || body.discount) throw new Error("Coupons, points and discounts need the internet. Remove them to bill offline.");
    return { total: POSUI.estimate(), exact: false, upi: null, body };
  }

  async function start(method) {
    if (busy || !POSUI.lines().length) return;
    const d = $("#payDlg");
    let amount;
    try { amount = await amountFor(payload(method === "split" ? "cash" : method)); }
    catch (e) { POSUI.toast(e.message, true); return; }
    const body = amount.body;
    if (method === "split") { split(body, amount); return; }
    const ref = `${Date.now().toString(36)}`.toUpperCase();
    const head = `<div class="dlg-head"><h2 id="payTitle">${{ cash: "Cash", upi: "UPI", card: "Card" }[method]}</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>
      <p class="due"><span>To pay</span><b>${esc(money(amount.total))}</b></p>${amount.exact ? "" : `<p class="hint">Offline: shelf prices. The bill number is given when it syncs.</p>`}`;
    if (method === "cash") {
      // what customers actually hand over: exact, then the next ₹10, ₹50, ₹100 and ₹500 above the bill
      const up = (step) => Math.ceil(amount.total / step) * step;
      const quick = [...new Set([amount.total, up(1000), up(5000), up(10000), up(50000)].filter((v) => v >= amount.total))].slice(0, 5);
      d.innerHTML = `<form class="dlg-in pay-cash">${head}
        <label>Cash given (₹)<input id="tendered" inputmode="decimal" autocomplete="off" value="${(amount.total / 100).toFixed(0)}"></label>
        <div class="quick">${quick.map((v) => `<button class="btn ghost small" type="button" data-tender="${v}">${esc(money(v))}</button>`).join("")}</div>
        <p class="change">Change: <b id="change">₹0</b></p>
        <button class="btn primary big" type="submit">Complete bill <kbd>Enter</kbd></button></form>`;
      const t = d.querySelector("#tendered");
      const upd = () => { const v = Math.round(Number(t.value) * 100) || 0; d.querySelector("#change").textContent = v >= amount.total ? money(v - amount.total) : "not enough"; };
      t.addEventListener("input", upd);
      d.querySelector(".quick").addEventListener("click", (e) => { const b = e.target.closest("[data-tender]"); if (b) { t.value = (Number(b.dataset.tender) / 100).toFixed(0); upd(); } });
      d.querySelector("form").addEventListener("submit", (e) => {
        e.preventDefault();
        const v = Math.round(Number(t.value) * 100) || 0;
        if (v < amount.total) { t.focus(); POSUI.toast("Cash given is less than the bill", true); return; }
        complete(body, amount, { tendered: v });
      });
      d.showModal(); upd(); t.select();
    } else if (method === "upi") {
      const link = upiLink(amount.total, ref, amount.upi);
      const payee = amount.upi ? amount.upi.id : (POS.settings || {}).upiId || "";
      d.innerHTML = `<form class="dlg-in pay-upi">${head}
        ${link ? `<div class="qr" id="qr"></div><p class="payee">Pays to <b>${esc(payee)}</b>${amount.upi ? "" : " (offline: check this is your shop's UPI ID)"}</p>
          <p class="hint">Customer scans this (it's also on the customer screen). Wait for the soundbox or check your UPI app, then press "Money received".</p>`
          : `<p class="err">Add your UPI ID in the dashboard (Settings) to show a QR here.</p>`}
        <label>UPI ref <span class="opt">(${((POS.settings || {}).approvals || {}).counterUpiNeedsRef ? "needed" : "optional"}, 12 digits)</span><input id="utr" inputmode="numeric" maxlength="14" autocomplete="off"></label>
        <button class="btn primary big" type="submit">Money received ✓ <kbd>Enter</kbd></button></form>`;
      if (link && window.qrcode) {
        const qr = window.qrcode(0, "M"); qr.addData(link); qr.make();
        d.querySelector("#qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      }
      POSUI.broadcast({ type: "upi", upi: link, payee, total: amount.total });
      d.querySelector("form").addEventListener("submit", (e) => {
        e.preventDefault();
        const utr = d.querySelector("#utr").value.replace(/\s+/g, "");
        if (utr && !/^\d{12}$/.test(utr)) { POSUI.toast("UPI ref is 12 digits (or leave it empty)", true); return; }
        complete({ ...body, utr }, amount, {});
      });
      d.addEventListener("close", () => POSUI.broadcast({ type: "cartback" }), { once: true });
      d.showModal();
    } else {
      d.innerHTML = `<form class="dlg-in">${head}<p class="hint">Take the card payment on your card machine first.</p>
        <button class="btn primary big" type="submit">Card approved ✓ <kbd>Enter</kbd></button></form>`;
      d.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); complete(body, amount, {}); });
      d.showModal();
    }
  }

  // One bill paid in parts, e.g. ₹300 cash + the rest by UPI.
  function split(body, amount) {
    const d = $("#payDlg");
    const methods = [["cash", "Cash"], ["upi", "UPI"], ["card", "Card"]];
    d.innerHTML = `<form class="dlg-in pay-split"><div class="dlg-head"><h2 id="payTitle">Split payment</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>
      <p class="due"><span>To pay</span><b>${esc(money(amount.total))}</b></p>
      <div id="parts">${[0, 1].map((i) => partRow(i, methods, i === 0 ? amount.total : 0)).join("")}</div>
      <button class="btn ghost small" type="button" id="addPart">+ Add a part</button>
      <p class="change">Left to share: <b id="left">₹0</b></p>
      <label>UPI ref <span class="opt">(for the UPI part, 12 digits)</span><input id="utr" inputmode="numeric" maxlength="14" autocomplete="off"></label>
      <button class="btn primary big" type="submit">Complete bill <kbd>Enter</kbd></button></form>`;
    const parts = d.querySelector("#parts");
    const read = () => [...parts.querySelectorAll(".part")].map((r) => ({ method: r.querySelector("select").value, amount: Math.round(Number(r.querySelector("input").value) * 100) || 0 })).filter((p) => p.amount > 0);
    const upd = () => { const left = amount.total - read().reduce((n, p) => n + p.amount, 0); d.querySelector("#left").textContent = left === 0 ? "₹0 ✓" : left > 0 ? money(left) : `${money(-left)} too much`; };
    parts.addEventListener("input", upd);
    d.querySelector("#addPart").addEventListener("click", () => { if (parts.children.length < 4) parts.insertAdjacentHTML("beforeend", partRow(parts.children.length, methods, 0)); });
    d.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const list = read();
      if (list.reduce((n, p) => n + p.amount, 0) !== amount.total) { POSUI.toast("The parts must add up to the bill", true); return; }
      if (!amount.exact) { POSUI.toast("Split payments need the internet", true); return; }
      const utr = d.querySelector("#utr").value.replace(/\s+/g, "");
      if (utr && !/^\d{12}$/.test(utr)) { POSUI.toast("UPI ref is 12 digits (or leave it empty)", true); return; }
      const withRef = list.map((p) => (p.method === "upi" && utr ? { ...p, ref: utr } : p));
      const cash = list.filter((p) => p.method === "cash").reduce((n, p) => n + p.amount, 0);
      complete({ ...body, method: list[0].method, split: withRef }, amount, cash ? { tendered: 0 } : {});
    });
    d.showModal(); upd();
  }
  const partRow = (i, methods, value) => `<div class="part"><select aria-label="Part ${i + 1}: how">${methods.map(([k, l], j) => `<option value="${k}" ${j === Math.min(i, 2) ? "selected" : ""}>${l}</option>`).join("")}</select>
    <input inputmode="decimal" aria-label="Part ${i + 1}: amount in rupees" value="${value ? (value / 100).toFixed(2) : ""}" autocomplete="off"></div>`;

  async function complete(body, amount, extra) {
    if (busy) return;
    busy = true;
    const d = $("#payDlg");
    const btn = d.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      const res = await POS.withApproval((b) => POS.sendBill(b), { ...body, estimate: amount.total });
      const shop = POS.settings || {};
      const who = (window.POSApp && POSApp.user && POSApp.user.name) || "";
      const model = res.offline
        ? receiptModel({ offline: true, ref: res.bill.clientRef, at: res.bill.offlineAt, method: body.method, total: amount.total, table: body.table, name: body.name,
            lines: POSUI.lines().map((l) => ({ name: l.choices.length ? `${l.name} (${l.choices.join(", ")})` : l.name, qty: l.qty, amount: l.price * l.qty })) }, shop, { ...extra, cashier: who })
        : receiptModel(res.order, shop, { ...extra, cashier: who, payments: res.order._payments || body.split || null });
      POS.countSale(POSUI.lines());
      d.close();
      POSUI.broadcast({ type: "thanks", total: model.total, change: model.change });
      POSUI.clear();
      POSUI.toast(res.offline ? "Offline: bill saved on this PC, it will be sent when the internet is back" : `Bill ${res.order.invoice_no} done${model.change ? ` · change ${money(model.change)}` : ""}`);
      if (POS.prefs().autoPrint) {
        try { await POSPrint.printReceipt(model); } catch (e) { POSUI.toast(`Bill saved, but printing failed: ${e.message}`, true); }
      }
      window.POSLast = model; // for "reprint last receipt"
      POSUI.rememberLast(body.items);
      if (!res.offline && res.order.customer_phone && window.POSX) POSX.offerWhatsApp(res.order);
    } catch (e) {
      POSUI.toast(e.message, true);
      if (btn) { btn.disabled = false; btn.textContent = "Try again"; }
    } finally {
      busy = false;
    }
  }

  return { start };
})();
