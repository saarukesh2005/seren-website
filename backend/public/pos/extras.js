/* SEREN Counter extras: a manager's OK (name + PIN), choosing sizes / add-ons, cake & advance orders,
   orders from delivery apps (Swiggy, Zomato, ONDC…), and sending the bill on WhatsApp. */
window.POSX = (function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const { money, receiptModel } = SerenReceipt;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const head = (id, title) => `<div class="dlg-head"><h2 id="${id}">${esc(title)}</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>`;

  /* ---------- a manager's OK ---------- */
  function askManager(what, message) {
    return new Promise((resolve) => {
      const d = $("#mgrDlg");
      d.innerHTML = `<form class="dlg-in" id="mgrForm">${head("mgrTitle", "Manager's OK")}
        <p class="hint">${esc(what)}. ${message && /Wrong/.test(message) ? `<b class="err">${esc(message)}</b>` : "A manager types their name and PIN."}</p>
        <label>Manager <span class="opt">(owner: type "owner")</span><input name="name" autocomplete="off" maxlength="30" required></label>
        <label>PIN<input name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="100" required></label>
        <button class="btn primary big" type="submit">Approve</button></form>`;
      let answer = null;
      d.querySelector("form").addEventListener("submit", (e) => {
        e.preventDefault();
        const f = e.target.elements;
        answer = { name: f.namedItem("name").value.trim(), pin: f.namedItem("pin").value };
        d.close();
      });
      d.addEventListener("close", () => { d.innerHTML = ""; resolve(answer); }, { once: true }); // the PIN is not kept on screen
      d.showModal();
      setTimeout(() => d.querySelector("input").focus(), 30);
    });
  }

  /* ---------- sizes, flavours, add-ons ---------- */
  function pickOptions(item) {
    return new Promise((resolve) => {
      const d = $("#optDlg");
      const groups = item.options || [];
      d.innerHTML = `<form class="dlg-in opt-form">${head("optTitle", item.name)}
        ${groups.map((g) => `<fieldset class="opt-group"><legend>${esc(g.name)}${g.required ? " <span class='opt'>(choose one)</span>" : g.pick === "many" ? " <span class='opt'>(any)</span>" : ""}</legend>
          ${g.choices.map((c, i) => `<label class="opt-choice"><input type="${g.pick === "many" ? "checkbox" : "radio"}" name="${esc(g.id)}" value="${esc(`${g.id}-${c.id}`)}" data-price="${Number(c.price) || 0}" ${g.required && i === 0 ? "checked" : ""}>
            <span>${esc(c.name)}</span><b>${c.price ? `+${esc(money(c.price))}` : ""}</b></label>`).join("")}</fieldset>`).join("")}
        <p class="due"><span>Price</span><b id="optPrice"></b></p>
        <button class="btn primary big" type="submit">Add to bill</button></form>`;
      const form = d.querySelector("form");
      const upd = () => { const extra = [...form.querySelectorAll("input:checked")].reduce((n, x) => n + Number(x.dataset.price), 0); d.querySelector("#optPrice").textContent = money(item.price + extra); };
      form.addEventListener("change", upd);
      let answer = null;
      form.addEventListener("submit", (e) => { e.preventDefault(); answer = [...form.querySelectorAll("input:checked")].map((x) => x.value); d.close(); });
      d.addEventListener("close", () => resolve(answer), { once: true });
      d.showModal(); upd();
    });
  }

  const items = () => POSUI.lines().map((l) => (l.opts.length ? { id: l.id, qty: l.qty, opts: l.opts } : { id: l.id, qty: l.qty }));
  const ymd = (days) => new Date(Date.now() + 330 * 60000 + days * 86400000).toISOString().slice(0, 10);

  /* ---------- cake & advance orders ---------- */
  function advanceOrder() {
    if (!POSUI.lines().length) { POSUI.toast("Add the items first (the cake, its size, add-ons)", true); return; }
    if (!POS.online) { POSUI.toast("Advance orders need the internet", true); return; }
    const ex = POSUI.extras();
    const d = $("#moreDlg");
    d.innerHTML = `<form class="dlg-in" id="advForm">${head("moreTitle", "Cake / advance order")}
      <div class="two"><label>Customer name<input name="name" maxlength="60" required value="${esc(ex.name)}"></label>
      <label>Mobile<input name="phone" inputmode="tel" maxlength="14" required value="${esc(ex.phone)}"></label></div>
      <div class="two"><label>Pickup date<input name="date" type="date" min="${ymd(0)}" value="${ymd(1)}" required></label>
      <label>Time<input name="time" type="time" value="17:00" required></label></div>
      <label>Message on the cake <span class="opt">(optional)</span><input name="cakeMessage" maxlength="80"></label>
      <label>Notes for the kitchen <span class="opt">(optional)</span><input name="notes" maxlength="300"></label>
      <p class="due"><span>Bill total</span><b id="advTotal">…</b></p>
      <div class="two"><label>Advance now (₹)<input name="amount" inputmode="decimal" required></label>
      <label>Paid by<select name="method"><option value="upi">UPI</option><option value="cash">Cash</option><option value="card">Card</option></select></label></div>
      <label>UPI ref <span class="opt">(optional)</span><input name="ref" inputmode="numeric" maxlength="14"></label>
      <p class="err" id="advErr" role="alert"></p>
      <button class="btn primary big" type="submit">Book &amp; print advance receipt</button></form>`;
    const f = d.querySelector("form");
    const base = { items: items(), coupon: ex.coupon, points: ex.points, packing: true, ...(ex.discount ? { discount: ex.discount } : {}) };
    POS.quote(base).then(({ quote }) => {
      d.querySelector("#advTotal").textContent = money(quote.total);
      f.elements.namedItem("amount").value = (Math.ceil(quote.total / 2 / 100)).toString(); // half is a common advance
    }).catch((e) => { d.querySelector("#advErr").textContent = e.message; });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = (k) => f.elements.namedItem(k).value.trim();
      const body = { ...base, name: v("name"), phone: v("phone"), date: v("date"), time: v("time"), cakeMessage: v("cakeMessage"), notes: v("notes"),
        advance: { amount: Math.round(Number(v("amount")) * 100), method: v("method"), ref: v("ref").replace(/\s+/g, "") } };
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const { order } = await POS.withApproval((b) => POS.api("/counter/advance", b), body);
        d.close();
        POSUI.clear();
        POSUI.toast(`Booked ${order.code} · advance ${money(order.advance)} · balance ${money(order.total - order.advance)}`);
        const m = receiptModel(order, POS.settings || {}, { cashier: (POSApp.user || {}).name || "" });
        const receipt = { ...m, title: "ADVANCE RECEIPT", number: order.receipt_no, method: body.advance.method.toUpperCase(),
          note: `Advance ${money(order.advance)} received. Balance ${money(order.total - order.advance)} when you collect on ${order.slot_date} at ${order.slot_time}.${order.cake_message ? ` Cake: “${order.cake_message}”.` : ""} Not a tax invoice.` };
        try { await POSPrint.printReceipt(receipt); } catch (x) { POSUI.toast(`Booked, but printing failed: ${x.message}`, true); }
        window.POSLast = receipt;
      } catch (x) {
        d.querySelector("#advErr").textContent = x.message;
        btn.disabled = false;
      }
    });
    d.showModal();
  }

  /* ---------- Swiggy, Zomato, ONDC… ---------- */
  function appOrder() {
    if (!POSUI.lines().length) { POSUI.toast("Add the app order's items first", true); return; }
    if (!POS.online) { POSUI.toast("App orders need the internet", true); return; }
    const apps = (POS.settings && POS.settings.platforms) || [];
    const d = $("#moreDlg");
    d.innerHTML = `<form class="dlg-in" id="appForm">${head("moreTitle", "Order from a delivery app")}
      <fieldset class="seg"><legend>Which app</legend>${apps.map((a, i) => `<label><input type="radio" name="platform" value="${esc(a.id)}" ${i === 0 ? "checked" : ""}><span>${esc(a.name)}</span></label>`).join("")}</fieldset>
      <label>App's order number<input name="externalId" maxlength="40" required autocomplete="off"></label>
      <fieldset class="seg"><legend>Rider</legend><label><input type="radio" name="mode" value="delivery" checked><span>App's rider picks up</span></label><label><input type="radio" name="mode" value="pickup"><span>Customer picks up</span></label></fieldset>
      <label>Note for the kitchen <span class="opt">(optional)</span><input name="notes" maxlength="300"></label>
      <p class="hint">Goes to the kitchen screen and the reports. GST on app orders is paid by the app, so this bill has none.</p>
      <p class="err" id="appErr" role="alert"></p>
      <button class="btn primary big" type="submit">Save app order</button></form>`;
    const f = d.querySelector("form");
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = (k) => f.elements.namedItem(k).value.trim();
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const { order, duplicate } = await POS.api("/counter/app-order", { platform: v("platform"), externalId: v("externalId"), mode: v("mode"), notes: v("notes"), items: items() });
        d.close();
        POSUI.clear();
        POSUI.toast(duplicate ? `Already entered: ${order.code}` : `${order.code} saved · sent to the kitchen`);
        if (!duplicate && POS.prefs().autoPrint) {
          try { await POSPrint.printReceipt(receiptModel(order, POS.settings || {}, { cashier: (POSApp.user || {}).name || "" })); } catch (x) { POSUI.toast(`Saved, but printing failed: ${x.message}`, true); }
        }
      } catch (x) {
        d.querySelector("#appErr").textContent = x.message;
        btn.disabled = false;
      }
    });
    d.showModal();
  }

  /* ---------- the bill on WhatsApp (free: opens WhatsApp with the message ready) ---------- */
  function offerWhatsApp(order) {
    const bar = $("#afterSale");
    if (!bar) return;
    bar.innerHTML = `<span>Bill ${esc(order.invoice_no)} for ${esc(order.customer_phone)}</span><button class="btn ghost small" type="button" id="waBill">Send on WhatsApp</button><button class="x" type="button" id="waX" aria-label="Close">×</button>`;
    bar.hidden = false;
    const hide = () => { bar.hidden = true; bar.innerHTML = ""; };
    const timer = setTimeout(hide, 60000);
    bar.querySelector("#waX").addEventListener("click", () => { clearTimeout(timer); hide(); });
    bar.querySelector("#waBill").addEventListener("click", async () => {
      try {
        const { url } = await POS.api(`/orders/${encodeURIComponent(order.code)}/whatsapp`, { kind: "paid" });
        window.open(url, "_blank", "noopener");
        clearTimeout(timer); hide();
      } catch (e) { POSUI.toast(e.message, true); }
    });
  }

  return { askManager, pickOptions, advanceOrder, appOrder, offerWhatsApp };
})();
