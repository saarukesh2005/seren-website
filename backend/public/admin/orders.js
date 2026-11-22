/* Orders tab: live list, payment checks, status moves, bills, WhatsApp the customer. */
SA.orders = (function () {
  "use strict";
  const { esc, money, api, toast, ago, day, time12 } = SA;
  const $ = (s) => document.querySelector(s);
  const FILTERS = [["active", "Needs action"], ["awaiting_payment", "Waiting for payment"], ["", "All"], ["completed", "Completed"], ["cancelled", "Cancelled"]];
  const NEXT_LABEL = { preparing: "Start making", ready: "Mark ready", out_for_delivery: "Out for delivery", completed: "Handed over ✓", cancelled: "Cancel order", awaiting_payment: "Payment not received" };
  let filter = "active";
  let query = "";
  let statuses = {};
  let list = [];
  let seen = null;      // order ids already shown, to spot new ones
  let pollTimer;

  function chips() {
    $("#statusChips").innerHTML = FILTERS.map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${k === filter}">${esc(l)}</button>`).join("");
  }

  async function load(more) {
    const params = new URLSearchParams({ status: filter, q: query, limit: "50" });
    if (more && list.length) params.set("before", String(list[list.length - 1].id));
    try {
      const data = await api(`/orders?${params}`);
      statuses = data.statuses;
      list = more ? [...list, ...data.orders] : data.orders;
      stats(data.summary);
      render();
      $("#moreOrders").hidden = data.orders.length < 50;
      alertNew(data.orders);
    } catch (e) {
      toast(e.message, true);
    }
  }

  function stats(s) {
    $("#stats").innerHTML = [
      ["Today's sales", money(s.revenue), false], ["Paid today", s.paid, false],
      ["Check payment", s.toCheck, s.toCheck > 0], ["To make", s.toMake, s.toMake > 0], ["To hand over", s.toHandOver, false],
    ].map(([l, v, hot]) => `<div class="stat ${hot ? "hot" : ""}"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");
  }

  const itemsText = (o) => o.lines.map((l) => `${l.qty}× ${l.name}`).join(", ");
  const whenText = (o) => {
    if (o.mode === "counter") return "Counter";
    if (o.mode === "dinein") return `Dine-in · Table ${o.table_no} · ${time12(o.slot_time)}`;
    return `${o.mode === "delivery" ? "Delivery" : "Pickup"} · ${day(o.slot_date)} ${time12(o.slot_time)}`;
  };

  function render() {
    if (!list.length) { $("#orderList").innerHTML = `<li class="empty">${filter === "active" ? "All caught up!" : "No orders here yet"}</li>`; return; }
    $("#orderList").innerHTML = list.map((o) => `
      <li class="ocard ${o.status === "payment_submitted" ? "check" : ""}" tabindex="0" data-code="${esc(o.code)}">
        <div class="row"><span class="who">${o.table_no ? `<span class="tablechip">T${esc(o.table_no)}</span> ` : ""}${esc(o.customer_name || "Walk-in")}</span><span class="amt">${esc(money(o.total))}</span></div>
        <div class="row"><span class="badge ${esc(o.status)}">${esc(statuses[o.status] || o.status)}</span><span class="meta">${esc(o.code)} · ${esc(ago(o.created_at))}</span></div>
        <div class="meta">${esc(whenText(o))}${o.invoice_no ? ` · Bill ${esc(o.invoice_no)}` : ""}${o.channel === "table" ? " · pays at the end" : ""}${o.channel === "whatsapp" ? " · via WhatsApp" : ""}${o.credit_note_no ? ` · refunded (${esc(o.credit_note_no)})` : ""}</div>
        <div class="items">${esc(itemsText(o))}</div>
        ${o.status === "payment_submitted" ? `<div class="meta">Customer says they paid. UPI ref <b>${esc(o.utr)}</b>. Check your bank app for ${esc(money(o.total))}.</div>
          <div class="act"><button class="btn ok small" type="button" data-quick="confirm">Money received ✓</button><button class="btn ghost small" type="button" data-quick="reject">Not received</button></div>` : ""}
      </li>`).join("");
  }

  // Chime + browser notification when a new order or payment comes in.
  function alertNew(orders) {
    const ids = new Set(orders.map((o) => `${o.id}:${o.status}`));
    if (seen) {
      const fresh = orders.filter((o) => !seen.has(`${o.id}:${o.status}`) && ["awaiting_payment", "payment_submitted"].includes(o.status));
      if (fresh.length) {
        chime();
        $("#newDot").hidden = document.querySelector('[data-tab="orders"]').getAttribute("aria-current") === "page";
        document.title = `(${fresh.length}) SEREN Orders`;
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(`SEREN: ${fresh[0].status === "payment_submitted" ? "check a payment" : "new order"}`, { body: `${fresh[0].customer_name} · ${money(fresh[0].total)}` });
        }
      }
    }
    seen = new Set([...(seen || []), ...ids]);
  }

  function chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [660, 880, 1320].forEach((f, i) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
        const t = ctx.currentTime + i * 0.16;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.start(t); o.stop(t + 0.32);
      });
    } catch (e) { /* sound not allowed until the owner taps the page once */ }
  }

  /* ---------- one order ---------- */
  async function open(code) {
    try {
      const { order, events, statuses: st } = await api(`/orders/${encodeURIComponent(code)}`);
      statuses = st;
      sheet(order, events);
    } catch (e) { toast(e.message, true); }
  }

  function waLink(o) {
    const phone = o.customer_phone ? `91${o.customer_phone}` : "";
    const msg = `Hi ${o.customer_name || ""}! SEREN here about order ${o.code}: ${statuses[o.status]}.`;
    return phone ? `https://wa.me/${phone}?text=${encodeURIComponent(msg)}` : "";
  }

  function sheet(o, events) {
    const d = $("#orderSheet");
    const unpaid = ["awaiting_payment", "payment_submitted", "expired"].includes(o.status);
    const moves = (o.status === "payment_submitted" ? ["awaiting_payment"] : []).concat(nextMoves(o));
    const wa = waLink(o);
    const refundable = o.invoice_no && !o.credit_note_no && SA.can("refund");
    const tpl = SA.state.settings ? Object.keys(SA.state.settings.waTemplates || {}) : [];
    d.innerHTML = `<div class="sheet-in">
      <div class="sheet-head"><div><h2 id="sheetTitle">${esc(o.code)}</h2><span class="badge ${esc(o.status)}">${esc(statuses[o.status])}</span></div>
        <button class="close" type="button" data-close aria-label="Close">×</button></div>
      ${unpaid ? `<form class="box confirm" id="confirmForm"><h3>Confirm payment of ${esc(money(o.total))}</h3>
        <p class="meta">${o.utr ? `Customer's UPI ref: <b>${esc(o.utr)}</b>. Find this amount and ref in your bank / UPI business app first.` : "Only confirm once the money is in your account."}</p>
        <fieldset class="seg"><legend>Paid by</legend>${["upi", "cash", "card"].map((m, i) => `<label><input type="radio" name="method" value="${m}" ${i === 0 ? "checked" : ""}><span>${m.toUpperCase()}</span></label>`).join("")}</fieldset>
        ${o.utr ? "" : `<label>UPI ref (12 digits)<input name="utr" inputmode="numeric" maxlength="14"></label>`}
        <button class="btn ok" type="submit">Money received ✓ (issues the bill)</button></form>` : ""}
      <div class="box"><h3>Items</h3><ul class="lines">${o.lines.map((l) => `<li><span>${l.qty} × ${esc(l.name)}${l.unit ? ` <span class="opt">${esc(l.unit)}</span>` : ""}</span><b>${esc(money(l.gross))}</b></li>`).join("")}
        ${o.delivery_fee ? `<li><span>Delivery</span><b>${esc(money(o.delivery_fee))}</b></li>` : ""}<li><span>Total</span><b>${esc(money(o.total))}</b></li></ul></div>
      <div class="box"><dl class="kv">
        <dt>Customer</dt><dd>${esc(o.customer_name || "Walk-in")}${o.customer_phone ? ` · <a href="tel:+91${esc(o.customer_phone)}">${esc(o.customer_phone)}</a>` : ""}</dd>
        <dt>When</dt><dd>${esc(whenText(o))}</dd>
        ${o.address ? `<dt>Address</dt><dd>${esc(o.address)} ${esc(o.pincode)}</dd>` : ""}
        ${o.notes ? `<dt>Note</dt><dd><b>${esc(o.notes)}</b></dd>` : ""}
        ${o.utr ? `<dt>UPI ref</dt><dd>${esc(o.utr)}</dd>` : ""}
        ${o.invoice_no ? `<dt>Bill</dt><dd>${esc(o.invoice_no)} · ${esc(o.payment_method.toUpperCase())}</dd>` : ""}
      </dl></div>
      <div class="btns">${moves.map((m) => `<button class="btn ${m === "cancelled" || m === "awaiting_payment" ? "ghost" : "plum"}" type="button" data-move="${m}">${esc(moveLabel(o, m))}</button>`).join("")}</div>
      <div class="btns">
        <a class="btn ghost small" href="/invoice/${encodeURIComponent(o.code)}" target="_blank" rel="noopener">${o.invoice_no ? "Print bill" : "Print order slip"}</a>
        <a class="btn ghost small" href="/invoice/${encodeURIComponent(o.code)}?size=80mm" target="_blank" rel="noopener">Receipt size</a>
        <a class="btn ghost small" href="/kot/${encodeURIComponent(o.code)}" target="_blank" rel="noopener">Kitchen ticket</a>
        ${o.credit_note_no ? `<a class="btn ghost small" href="/credit-note/${encodeURIComponent(o.code)}" target="_blank" rel="noopener">Credit note ${esc(o.credit_note_no)}</a>` : ""}
        ${wa ? `<a class="btn ghost small" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp chat</a>` : ""}
      </div>
      ${wa && tpl.length ? `<div class="box"><h3>Send a WhatsApp update</h3><div class="btns">${tpl.map((k) => `<button class="btn ghost small" type="button" data-wa="${esc(k)}">${esc(WA_LABEL[k] || k)}</button>`).join("")}</div>
        <p class="meta">Opens WhatsApp with the message written for you, including their order link. You press send.</p></div>` : ""}
      ${refundable ? `<details class="box"><summary><b>Refund this order</b></summary><form id="refundForm" class="refund">
        <p class="meta">Cancels the order and makes a numbered credit note for your accounts. Return the money first.</p>
        <fieldset class="seg"><legend>Money returned by</legend>${["upi", "cash", "card", "store_credit"].map((m, i) => `<label><input type="radio" name="method" value="${m}" ${i === 0 ? "checked" : ""}><span>${m === "store_credit" ? "Credit" : m.toUpperCase()}</span></label>`).join("")}</fieldset>
        <label>Refund reference <span class="opt">(optional)</span><input name="ref" maxlength="40"></label>
        <button class="btn" type="submit">Refund ${esc(money(o.total))} &amp; make credit note</button></form></details>` : ""}
      <form class="box" id="noteForm"><label>Private note (only you see this)<textarea name="note" rows="2" maxlength="500">${esc(o.admin_note)}</textarea></label><button class="btn ghost small" type="submit">Save note</button></form>
      <div class="box"><h3>History</h3><ul class="log">${events.map((e) => `<li>${esc(new Date(e.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))} · ${esc(statuses[e.status] || e.status)}${e.note ? ` · ${esc(e.note)}` : ""} <span class="opt">(${esc(e.actor)})</span></li>`).join("")}</ul></div>
    </div>`;
    if (!d.open) d.showModal();
    d.querySelector("[data-close]").addEventListener("click", () => d.close());
    const cf = d.querySelector("#confirmForm");
    if (cf) cf.addEventListener("submit", (e) => { e.preventDefault(); const utr = cf.elements.namedItem("utr");
      confirm(o, { method: cf.elements.namedItem("method").value, utr: utr ? utr.value.replace(/\s+/g, "") : undefined }); });
    d.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", () => move(o, b.dataset.move)));
    d.querySelectorAll("[data-wa]").forEach((b) => b.addEventListener("click", () => sendWa(o, b.dataset.wa)));
    const rf = d.querySelector("#refundForm");
    if (rf) rf.addEventListener("submit", (e) => { e.preventDefault(); refund(o, rf); });
    d.querySelector("#noteForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await api(`/orders/${o.code}/note`, { note: e.target.elements.namedItem("note").value }); toast("Note saved"); }
      catch (ex) { toast(ex.message, true); }
    });
  }

  function moveLabel(o, m) {
    if (o.mode === "dinein" && m === "ready") return "Ready to serve";
    if (o.mode === "dinein" && m === "completed") return "Served ✓";
    return NEXT_LABEL[m] || statuses[m];
  }

  const WA_LABEL = { paid: "Payment received", preparing: "Being made", ready: "Ready", out_for_delivery: "On the way", feedback: "Ask for feedback" };

  async function sendWa(o, kind) {
    const win = window.open("about:blank", "_blank"); // opened now so the browser doesn't block it
    try {
      const r = await api(`/orders/${o.code}/whatsapp`, { kind });
      if (win) win.location.href = r.url; else location.href = r.url;
    } catch (e) { if (win) win.close(); toast(e.message, true); }
  }

  async function refund(o, form) {
    if (!window.confirm(`Refund ${money(o.total)} for ${o.code}? This can't be undone.`)) return;
    try {
      const { order } = await api(`/orders/${o.code}/refund`, { method: form.elements.namedItem("method").value, ref: form.elements.namedItem("ref").value });
      toast(`Refunded. Credit note ${order.credit_note_no}`);
      await load(); open(o.code);
    } catch (e) { toast(e.message, true); }
  }

  function nextMoves(o) {
    const cancel = o.invoice_no ? [] : ["cancelled"]; // paid orders are refunded instead
    const all = { paid: ["preparing", "ready", "completed", ...cancel], on_tab: ["preparing", "ready", "completed", ...cancel], preparing: ["ready", "completed", ...cancel], ready: ["out_for_delivery", "completed", ...cancel], out_for_delivery: ["completed", ...cancel], awaiting_payment: ["cancelled"], payment_submitted: ["cancelled"] };
    return (all[o.status] || []).filter((m) => m !== "out_for_delivery" || o.mode === "delivery");
  }

  async function confirm(o, body) {
    try {
      const { order } = await api(`/orders/${o.code}/confirm`, body);
      toast(`Paid ✓ Bill ${order.invoice_no}`);
      await load(); open(o.code);
    } catch (e) { toast(e.message, true); }
  }

  async function move(o, to) {
    if (to === "cancelled" && !window.confirm(`Cancel order ${o.code}?`)) return;
    try {
      await api(`/orders/${o.code}/status`, { to });
      toast(statuses[to]);
      await load(); open(o.code);
    } catch (e) { toast(e.message, true); }
  }

  function wire() {
    chips();
    $("#statusChips").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (!b) return; filter = b.dataset.f; chips(); load(); });
    let t;
    $("#search").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { query = e.target.value.trim(); load(); }, 300); });
    $("#moreOrders").addEventListener("click", () => load(true));
    $("#orderList").addEventListener("click", (e) => {
      const card = e.target.closest(".ocard"); if (!card) return;
      const o = list.find((x) => x.code === card.dataset.code);
      const q = e.target.closest("[data-quick]");
      if (q && q.dataset.quick === "confirm") { confirm(o, { method: "upi" }); return; }
      if (q && q.dataset.quick === "reject") { move(o, "awaiting_payment"); return; }
      open(card.dataset.code);
    });
    $("#orderList").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.classList.contains("ocard")) open(e.target.dataset.code); });
    $("#orderSheet").addEventListener("close", () => load());
  }

  function start() {
    wire();
    load();
    pollTimer = setInterval(() => { if (!document.hidden) load(); }, 20000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { load(); document.title = "SEREN Orders"; } });
    const code = decodeURIComponent(location.hash.slice(1));
    if (/^SRN-[A-Z0-9]{6}$/.test(code)) open(code);
  }
  SA.chime = chime;
  return { start, load, open, stop: () => clearInterval(pollTimer) };
})();
