/* Online ordering inside the order box: live prices, checkout form, UPI payment.
   If the order system is off or unreachable, the box keeps working the old way (WhatsApp / copy). */
(function () {
  "use strict";
  const P = window.SerenPay;
  const BOX = window.SEREN_BOX;
  const CAT = new Map((window.SEREN_CATALOG || []).map((c) => [c.id, c]));
  const $ = (s, r = document) => r.querySelector(s);
  const { esc, money } = P;
  let shop = null;      // { live, settings, prices }
  let view = "box";     // box | form | pay | done
  let form = null;      // what the customer typed, kept if they go back
  let placed = null;    // the order waiting for payment
  let coupon = null;    // { code, discount, label } once a code is applied
  const { table, k: tableKey } = tableFromLink(); // set when a guest scanned the QR code on their table
  window.SEREN_TABLE = table ? { table, k: tableKey } : null;

  // Table QR codes open the site as ...?table=5&k=<signature>. Remembered for this visit only.
  function tableFromLink() {
    const ok = (t) => (/^[A-Za-z0-9][A-Za-z0-9 -]{0,9}$/.test(t || "") ? t : "");
    const okKey = (v) => (/^[A-Za-z0-9_-]{12}$/.test(v || "") ? v : "");
    const q = new URLSearchParams(location.search);
    let t = ok(q.get("table"));
    let k = t ? okKey(q.get("k")) : "";
    try {
      if (t) sessionStorage.setItem("seren-table", JSON.stringify({ t, k }));
      else ({ t, k } = JSON.parse(sessionStorage.getItem("seren-table") || "{}"));
    } catch (e) { /* storage blocked: the link still works on this page */ }
    return { table: ok(t), k: okKey(k) };
  }

  async function loadShop() {
    if (!P.enabled) return;
    try {
      const data = await P.api("/api/menu");
      shop = { live: Boolean(data.settings.acceptingOrders), settings: data.settings, prices: data.prices, products: data.products };
    } catch (e) {
      shop = null; // fall back to WhatsApp / copy
    }
    window.SEREN_SHOP = shop;
    document.dispatchEvent(new CustomEvent("seren:shop"));
  }

  /* ---------- the box footer: subtotal + checkout button ---------- */
  function boxTotals(items) {
    let total = 0;
    const problems = [];
    const perProduct = new Map(); // stock is per product, whatever the choices
    for (const it of items) perProduct.set(it.id, (perProduct.get(it.id) || 0) + it.qty);
    for (const it of items) {
      const p = shop.prices[it.id];
      const unit = BOX.unitPrice(it); // base price + the chosen extras; null when a choice is no longer offered
      if (!p || !p.available || p.left === 0 || (p.left !== undefined && p.left < perProduct.get(it.id)) || unit === null) problems.push(BOX.lineText(it));
      else total += unit * it.qty;
    }
    return { total, problems: [...new Set(problems)] };
  }

  function updateFooter() {
    const items = BOX.items();
    const sum = $("#boxSum");
    const btn = $("#checkoutBtn");
    const live = Boolean(shop && shop.live && items.length);
    sum.hidden = !live; btn.hidden = !live;
    if (!live) return;
    const { total, problems } = boxTotals(items);
    sum.innerHTML = problems.length
      ? `<span class="warn">Not available online right now: ${esc(problems.join(", "))}. Remove ${problems.length > 1 ? "them" : "it"} to check out.</span>`
      : `<span>Subtotal</span><b>${esc(money(total))}</b>`;
    btn.disabled = problems.length > 0;
    btn.textContent = `Checkout · ${money(total)}`;
  }

  /* ---------- switching views inside the drawer ---------- */
  function show(next) {
    view = next;
    const drawer = $("#drawer");
    drawer.classList.toggle("co-on", next !== "box");
    $("#checkout").hidden = next === "box";
    $("#drawerTitle").textContent = { box: "Your box", form: "Checkout", pay: "Pay by UPI", done: "Thank you" }[next];
    if (next === "done" && placed && placed.onTab) $("#drawerTitle").textContent = "In the kitchen";
    if (next === "box") { BOX.rerender(); return; }
    ({ form: renderForm, pay: renderPay, done: renderDone })[next]();
    const first = $("#checkout").querySelector("input, select, button, a");
    if (first && drawer.classList.contains("on")) first.focus({ preventScroll: true });
  }

  const needsNotice = (items) => items.some((it) => shop.settings.preorderCategories.includes(CAT.get(it.id)?.category));
  const locale = () => (window.serenLocale ? window.serenLocale() : "en-IN");
  const dayLabel = (ymd) => new Date(`${ymd}T00:00:00`).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short" });
  const timeLabel = (hhmm) => (window.serenTimeLabel ? window.serenTimeLabel(hhmm) : hhmm);

  async function renderForm() {
    const s = shop.settings;
    const items = BOX.items();
    const notice = needsNotice(items);
    const firstMode = table && s.dineIn ? "dinein" : s.pickup ? "pickup" : s.delivery ? "delivery" : "dinein";
    const f = form || { name: "", phone: "", mode: firstMode, table, address: "", pincode: "", notes: "", date: "", time: "" };
    const el = $("#checkout");
    el.innerHTML = `
      <button type="button" class="linkish back">← Back to your box</button>
      <form class="co-form" novalidate>
        <fieldset class="modes"><legend>How would you like it?</legend>
          ${s.dineIn ? `<label><input type="radio" name="mode" value="dinein" ${f.mode === "dinein" ? "checked" : ""}><span>Dine-in</span></label>` : ""}
          ${s.pickup ? `<label><input type="radio" name="mode" value="pickup" ${f.mode === "pickup" ? "checked" : ""}><span>Pickup</span></label>` : ""}
          ${s.delivery ? `<label><input type="radio" name="mode" value="delivery" ${f.mode === "delivery" ? "checked" : ""}><span>Delivery</span></label>` : ""}
        </fieldset>
        <label>Your name<input name="name" autocomplete="name" maxlength="60" required value="${esc(f.name)}"></label>
        <label class="tbl" ${f.mode === "dinein" ? "" : "hidden"}>Table number<input name="table" maxlength="10" autocomplete="off" value="${esc(f.table || table)}" ${table ? "readonly" : ""} placeholder="The number on your table"></label>
        <label>Mobile number <span class="opt dine-opt" ${f.mode === "dinein" ? "" : "hidden"}>(optional, for your bill on WhatsApp)</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="14" value="${esc(f.phone)}" placeholder="10-digit mobile"></label>
        <div class="addr" ${f.mode === "delivery" ? "" : "hidden"}>
          <label>Delivery address<textarea name="address" rows="3" maxlength="300" autocomplete="street-address">${esc(f.address)}</textarea></label>
          <label>Pincode<input name="pincode" inputmode="numeric" autocomplete="postal-code" maxlength="6" value="${esc(f.pincode)}"></label>
          ${s.deliveryFee ? `<p class="hint">Delivery ${esc(money(s.deliveryFee))}${s.freeDeliveryAbove ? `, free above ${esc(money(s.freeDeliveryAbove))}` : ""}${s.minOrder ? ` · minimum order ${esc(money(s.minOrder))}` : ""}</p>` : ""}
        </div>
        <div class="when" ${f.mode === "dinein" ? "hidden" : ""}>
          <label>Day<select name="date"><option value="">Loading days…</option></select></label>
          <label>Time<select name="time"></select></label>
        </div>
        ${notice ? `<p class="hint notice-hint" ${f.mode === "dinein" ? "hidden" : ""}>Entremets are made to order, so the earliest day is ${esc(Number(s.preorderNoticeDays) | 0)} days from today.</p>` : ""}
        <label>Anything we should know? <span class="opt">(optional)</span><textarea name="notes" rows="2" maxlength="300" placeholder="Message on the cake, allergies, gate code…">${esc(f.notes)}</textarea></label>
        ${payLaterOk() ? `<fieldset class="modes paywhen" ${f.mode === "dinein" ? "" : "hidden"}><legend>When will you pay?</legend>
          <label><input type="radio" name="when" value="later" ${f.when !== "now" ? "checked" : ""}><span>At the end</span></label>
          <label><input type="radio" name="when" value="now" ${f.when === "now" ? "checked" : ""}><span>Now, by UPI</span></label></fieldset>` : ""}
        <div class="pin" ${laterChosen(f) ? "" : "hidden"}>
          <label>Table PIN<input name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" value="${esc(f.pin || P.tablePin(table))}" placeholder="4 digits"></label>
          <p class="hint">Type the 4-digit table PIN our staff gave you</p>
        </div>
        <div class="coupon" ${laterChosen(f) ? "hidden" : ""}>
          <label>Have a code? <span class="opt">(optional)</span><span class="coupon-row"><input name="coupon" maxlength="20" autocomplete="off" value="${esc(coupon ? coupon.code : "")}" placeholder="e.g. WELCOME10"><button type="button" class="pill apply">Apply</button></span></label>
          <p class="hint coupon-note">${coupon ? `${esc(coupon.label)} · −${esc(money(coupon.discount))}` : ""}</p>
        </div>
        <label class="optin"><input type="checkbox" name="optIn" ${f.optIn ? "checked" : ""}><span>Send me SEREN offers on WhatsApp <span class="opt">(you can stop any time)</span></span></label>
        <ul class="co-break" hidden></ul>
        <div class="co-total"><span>Total</span><b></b></div>
        <p class="hint est-hint" hidden>Estimated total. The final amount is confirmed when you place your order.</p>
        <p class="err" role="alert"></p>
        <button class="pill fill" type="submit">${submitLabel(f)}</button>
        ${s.whatsapp ? `<button class="pill wa" type="button" data-wa>Order on WhatsApp instead</button>` : ""}
      </form>`;
    const fm = el.querySelector("form");
    let days = [];
    el.querySelector(".back").addEventListener("click", () => { form = readForm(fm); show("box"); });
    fm.querySelector(".apply").addEventListener("click", () => applyCoupon(fm));
    const wa = fm.querySelector("[data-wa]");
    if (wa) wa.addEventListener("click", () => submit(fm, "whatsapp"));
    fm.addEventListener("change", (e) => {
      if (e.target.name === "mode" || e.target.name === "when") { modeChanged(fm, readForm(fm)); total(fm); }
      if (e.target.name === "date") fillTimes(fm, days, "");
    });
    fm.addEventListener("submit", (e) => { e.preventDefault(); submit(fm); });
    field(fm, "pin").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4); }); // digits only
    total(fm);

    try {
      days = (await P.api(`/api/slots?notice=${notice ? 1 : 0}`)).days;
    } catch (e) {
      fm.querySelector(".err").textContent = e.message;
    }
    const sel = field(fm, "date");
    sel.innerHTML = days.length
      ? days.map((d) => `<option value="${esc(d.date)}" ${d.date === f.date ? "selected" : ""}>${esc(dayLabel(d.date))}</option>`).join("")
      : `<option value="">No days open right now</option>`;
    fillTimes(fm, days, f.time);
  }

  const payLaterOk = () => Boolean(shop.settings.dineInPayLater && table && tableKey && window.SEREN_TABLE && window.SEREN_TABLE.open);
  const laterChosen = (f) => f.mode === "dinein" && payLaterOk() && f.when !== "now";
  const submitLabel = (f) => (laterChosen(f) ? "Send to the kitchen" : f.mode === "dinein" ? "Send to kitchen & pay by UPI" : "Place order & pay by UPI");

  async function applyCoupon(fm) {
    const note = fm.querySelector(".coupon-note");
    const code = field(fm, "coupon").value.trim();
    if (!code) { coupon = null; note.textContent = ""; total(fm); return; }
    try {
      const r = await P.api("/api/coupons/check", { method: "POST", body: { code, itemsTotal: boxTotals(BOX.items()).total } });
      coupon = { code: r.code, discount: r.discount, label: r.label };
      note.textContent = `${r.label} · −${money(r.discount)}`;
    } catch (e) {
      coupon = null;
      note.textContent = e.message;
    }
    total(fm);
  }

  function modeChanged(fm, f) {
    const mode = f.mode;
    const paywhen = fm.querySelector(".paywhen");
    if (paywhen) paywhen.hidden = mode !== "dinein";
    fm.querySelector(".coupon").hidden = laterChosen(f);
    fm.querySelector(".pin").hidden = !laterChosen(f);
    fm.querySelector(".addr").hidden = mode !== "delivery";
    fm.querySelector(".tbl").hidden = mode !== "dinein";
    fm.querySelector(".dine-opt").hidden = mode !== "dinein";
    fm.querySelector(".when").hidden = mode === "dinein";
    const notice = fm.querySelector(".notice-hint");
    if (notice) notice.hidden = mode === "dinein";
    fm.querySelector('button[type="submit"]').textContent = submitLabel(f);
  }

  function fillTimes(fm, days, keep) {
    const day = days.find((d) => d.date === field(fm, "date").value);
    field(fm, "time").innerHTML = day ? day.times.map((t) => `<option value="${esc(t)}" ${t === keep ? "selected" : ""}>${esc(timeLabel(t))}</option>`).join("") : "";
  }

  // What the shop will probably charge (the server works out the real total when the order is placed):
  // packing for pickup and delivery, service charge for dine-in, then rounding to the rupee.
  // A "pay at the end" order carries neither service nor rounding: they go on the table's one bill.
  function estimate(f, sub, fee, off) {
    const ch = shop.settings.charges || {};
    const later = laterChosen(f);
    const takeaway = f.mode === "pickup" || f.mode === "delivery";
    const packing = takeaway ? Number(ch.packing) || 0 : 0;
    const servicePct = f.mode === "dinein" ? Number(ch.servicePercent) || 0 : 0;
    const service = servicePct && !later ? Math.round((Math.max(0, sub - off) * servicePct) / 100) : 0;
    const exact = sub - off + fee + packing + service;
    const rounding = ch.roundOff && !later ? Math.round(exact / 100) * 100 - exact : 0;
    return { packing, servicePct, service, later, rounding, total: exact + rounding };
  }

  function total(fm) {
    const s = shop.settings;
    const f = readForm(fm);
    const sub = boxTotals(BOX.items()).total;
    const fee = f.mode === "delivery" && s.deliveryFee && !(s.freeDeliveryAbove && sub >= s.freeDeliveryAbove) ? s.deliveryFee : 0;
    const off = coupon && !laterChosen(f) ? Math.min(coupon.discount, sub) : 0;
    const est = estimate(f, sub, fee, off);
    const extras = [fee ? `incl. ${money(fee)} delivery` : "", off ? `${money(off)} off` : ""].filter(Boolean).join(", ");
    fm.querySelector(".co-total b").textContent = money(est.total) + (extras ? ` (${extras})` : "");
    const rows = [];
    if (est.packing) rows.push(["Packing", money(est.packing)]);
    if (est.servicePct) rows.push([`Service charge ${est.servicePct}% (optional — ask staff to remove)`, est.later ? "on your final bill" : money(est.service)]);
    if (est.rounding) rows.push(["Round-off", `${est.rounding > 0 ? "+" : "−"}${money(Math.abs(est.rounding))}`]);
    const list = fm.querySelector(".co-break");
    list.hidden = !rows.length;
    list.innerHTML = rows.map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join("");
    const estimated = rows.length > 0;
    fm.querySelector(".co-total span").textContent = estimated ? "Estimated total" : "Total";
    fm.querySelector(".est-hint").hidden = !estimated;
  }

  // form.elements.namedItem, because form.name is the form's own name attribute
  const field = (fm, n) => fm.elements.namedItem(n);
  const readForm = (fm) => ({
    mode: fm.querySelector('[name="mode"]:checked')?.value || "",
    when: fm.querySelector('[name="when"]:checked')?.value || "now",
    optIn: field(fm, "optIn").checked,
    table: field(fm, "table").value.trim(),
    name: field(fm, "name").value.trim(), phone: field(fm, "phone").value.trim(), address: field(fm, "address").value.trim(),
    pin: field(fm, "pin").value.trim(), pincode: field(fm, "pincode").value.trim(), notes: field(fm, "notes").value.trim(), date: field(fm, "date").value, time: field(fm, "time").value,
  });

  async function submit(fm, channel = "web") {
    const err = fm.querySelector(".err");
    const btn = fm.querySelector('button[type="submit"]');
    form = readForm(fm);
    const local = quickCheck(form);
    if (local) { err.textContent = local; return; }
    const later = laterChosen(form);
    // open WhatsApp's window now: browsers block windows opened after waiting for the server
    const waWin = channel === "whatsapp" ? window.open("about:blank", "_blank") : null;
    if (waWin) waWin.opener = null; // the new tab must not be able to reach back into this page
    btn.disabled = true; err.textContent = ""; btn.textContent = "Placing your order…";
    try {
      const items = BOX.items();
      const res = await P.api("/api/orders", {
        method: "POST",
        body: {
          ...form, channel, items: items.map((i) => ({ id: i.id, qty: i.qty, ...(i.opts && i.opts.length ? { opts: i.opts } : {}) })),
          ...(later ? { payLater: true, k: tableKey, pin: form.pin } : coupon ? { coupon: coupon.code } : {}),
        },
      });
      P.rememberOrder(res.code, res.token);
      if (later) P.rememberPin(table, form.pin); // the tab sheet uses it too, for this visit
      placed = res;
      if (waWin) waWin.location.href = whatsappToShop(res, items);
      form = { ...form, notes: "" };
      coupon = null;
      BOX.clear();
      show(res.onTab ? "done" : "pay");
    } catch (e) {
      if (waWin) waWin.close();
      err.textContent = e.message;
      if (e.status === 403 && e.needPin) { P.forgetPin(table); field(fm, "pin").focus(); } // wrong PIN: ask again
      btn.disabled = false; btn.textContent = submitLabel(form);
    }
  }

  // The order, written out for SEREN's WhatsApp, with the link to pay and track it.
  function whatsappToShop(res, items) {
    const link = new URL(P.orderUrl(res.code, res.token), location.href).toString();
    const lines = items.map((i) => `${i.qty} × ${BOX.lineText(i)}`).join("\n");
    const how = form.mode === "dinein" ? `Dine-in, table ${form.table}` : `${form.mode === "delivery" ? "Delivery" : "Pickup"} ${form.date} ${form.time}`;
    const text = `Hi SEREN! Order ${res.code}\n${lines}\nTotal ${money(res.total)}\n${how}\nName: ${form.name}\nPay / track: ${link}`;
    return `https://wa.me/${encodeURIComponent(shop.settings.whatsapp)}?text=${encodeURIComponent(text)}`;
  }

  // Friendly checks before we bother the server (the server checks everything again).
  function quickCheck(f) {
    if (!f.mode) return "Choose how you'd like your order";
    if (f.name.length < 2) return "Please tell us your name";
    if (f.mode === "dinein" && !/^[A-Za-z0-9][A-Za-z0-9 -]{0,9}$/.test(f.table)) return "Please enter your table number";
    if (laterChosen(f) && !P.PIN_RE.test(f.pin)) return "Type the 4-digit table PIN our staff gave you";
    if (f.mode === "dinein" && !f.phone) return "";
    if (!/^[6-9]\d{9}$/.test(f.phone.replace(/[\s-]/g, "").replace(/^(\+?91|0)(?=\d{10}$)/, ""))) return "Please enter a 10-digit mobile number";
    if (f.mode === "delivery" && f.address.length < 10) return "Please enter your full delivery address";
    if (f.mode === "delivery" && !/^\d{6}$/.test(f.pincode)) return "Please enter a 6-digit pincode";
    if (f.mode !== "dinein" && (!f.date || !f.time)) return "Please choose a day and time";
    return "";
  }

  function renderPay() {
    const el = $("#checkout");
    el.innerHTML = `<div class="pay-host"></div><a class="linkish" href="${esc(P.orderUrl(placed.code, placed.token))}">Pay later or track this order →</a>`;
    P.payPanel(el.querySelector(".pay-host"), placed, () => show("done"));
  }

  function renderDone() {
    if (placed.onTab) {
      $("#checkout").innerHTML = `
        <div class="done">
          <svg aria-hidden="true"><use href="#burst"/></svg>
          <p class="hand">On its way, ${esc((form && form.name.split(" ")[0]) || "friend")}!</p>
          <p>Order <b>${esc(placed.code)}</b> is with the kitchen. Order more any time; when you're done, tap <b>Ask for the bill</b> at the bottom of the screen.</p>
          <p class="done-total"><span>Order total</span> <b>${esc(money(placed.total))}</b></p>
          <button type="button" class="pill fill again">Order something else</button>
        </div>`;
      $("#checkout .again").addEventListener("click", () => { placed = null; show("box"); });
      return;
    }
    $("#checkout").innerHTML = `
      <div class="done">
        <svg aria-hidden="true"><use href="#burst"/></svg>
        <p class="hand">Got it, ${esc((form && form.name.split(" ")[0]) || "friend")}!</p>
        <p>We're checking your payment for order <b>${esc(placed.code)}</b>${form && form.mode === "dinein" ? `. Your food is on its way to table ${esc(form.table)}` : ". You'll see it confirmed on your order page, usually within a few minutes"}.</p>
        <p class="done-total"><span>Order total</span> <b>${esc(money(placed.total))}</b></p>
        <a class="pill fill" href="${esc(P.orderUrl(placed.code, placed.token))}">Track your order</a>
        <button type="button" class="linkish again">Start a new box</button>
      </div>`;
    $("#checkout .again").addEventListener("click", () => { placed = null; show("box"); });
  }

  function lastOrderLink() {
    const last = P.savedOrders()[0];
    const el = $("#lastOrder");
    if (!el) return;
    el.hidden = !last;
    if (last) el.href = P.orderUrl(last.code, last.token);
  }

  document.addEventListener("seren:box", () => { if (shop) updateFooter(); lastOrderLink(); });
  document.addEventListener("seren:shop", () => { BOX.rerender(); });
  $("#checkoutBtn").addEventListener("click", () => show("form"));
  // re-opening the drawer after paying shows the box again
  document.addEventListener("seren:drawer", (e) => { if (e.detail.open && view === "done") { placed = null; show("box"); } });
  loadShop();
  lastOrderLink();
  if (table) $("#boxStatus").textContent = `Ordering for table ${table}`;
})();
