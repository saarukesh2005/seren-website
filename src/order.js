/* The order page: status timeline, UPI payment if still unpaid, invoice once paid. Link: order.html#CODE.TOKEN */
(function () {
  "use strict";
  const P = window.SerenPay;
  const { esc, money } = P;
  const card = document.getElementById("orderCard");
  const STEPS = [
    ["awaiting_payment", "Order placed"],
    ["payment_submitted", "Payment sent"],
    ["paid", "Payment confirmed"],
    ["preparing", "Being made"],
    ["ready", "Ready"],
    ["completed", "Done"],
  ];
  let timer;

  function parseHash() {
    let hash;
    try { hash = decodeURIComponent(location.hash.slice(1)); } catch (e) { return null; } // a broken link counts as no order
    const m = hash.match(/^(SRN-[A-Z0-9]{6})\.([A-Za-z0-9_-]{32})$/);
    return m ? { code: m[1], token: m[2] } : null;
  }

  const when = (iso) => new Date(iso).toLocaleString(locale(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const locale = () => (window.serenLocale ? window.serenLocale() : "en-IN");
  const timeLabel = (hhmm) => (window.serenTimeLabel ? window.serenTimeLabel(hhmm) : hhmm);
  const dayLabel = (ymd) => new Date(`${ymd}T00:00:00`).toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" });

  function stepIndex(status) {
    if (status === "out_for_delivery") return 4;
    if (status === "on_tab") return 2;
    return STEPS.findIndex(([s]) => s === status);
  }

  // "Need help?" line: the shop's phone and WhatsApp numbers are only used if they are plain digits
  function help(contact, code) {
    const c = contact || {};
    const phone = /^\+?\d{5,15}$/.test(String(c.phone ?? "")) ? String(c.phone) : "";
    const wa = /^\d{5,15}$/.test(String(c.whatsapp ?? "")) ? String(c.whatsapp) : "";
    if (!phone && !wa) return "";
    const call = phone ? `Call <a href="tel:${phone}">${esc(phone)}</a>` : "";
    const chat = wa ? `${phone ? " or " : ""}<a href="https://wa.me/${encodeURIComponent(wa)}?text=${encodeURIComponent(`Hi SEREN, about order ${code}`)}" target="_blank" rel="noopener">WhatsApp us</a>` : "";
    return `<p class="op-msg">Need help? ${call}
        ${chat}</p>`;
  }

  // Google review links must be https; anything else is dropped
  function safeHttps(url) {
    try { const u = new URL(String(url)); return u.protocol === "https:" ? u.href : ""; } catch (e) { return ""; }
  }

  function render(data, ref) {
    const o = data.order;
    const stopped = o.status === "cancelled" || o.status === "expired";
    // whatever the server added on top of the items and delivery (packing, service charge, rounding to the rupee)
    const charges = Number(o.subtotal) > 0 ? o.total - (o.subtotal - (Number(o.discount) || 0)) - (Number(o.deliveryFee) || 0) : 0;
    const at = stepIndex(o.status);
    const steps = STEPS.map(([s, label], i) => {
      const lbl = s === "ready" && o.mode === "delivery" ? (o.status === "out_for_delivery" ? "On the way" : "Ready to go")
        : s === "ready" && o.mode === "dinein" ? "Coming to you" : s === "completed" && o.mode === "dinein" ? "Served"
        : o.onTab && s === "paid" ? "In the kitchen" : o.onTab && s === "payment_submitted" ? "Pay at the end" : label;
      return `<li class="${i < at ? "was" : i === at ? "now" : ""}"><i></i>${esc(lbl)}</li>`;
    }).join("");
    card.innerHTML = `
      <p class="eyebrow">Order ${esc(o.code)}</p>
      <h1 class="display">${esc(o.statusLabel)}</h1>
      ${stopped ? `<p class="op-msg">${o.status === "expired" ? "This order wasn't paid in time. If you've already paid, enter your UPI reference below and we'll sort it out."
        : o.creditNote ? `This order was refunded (credit note ${esc(o.creditNote)}).` : "This order was cancelled. If you paid, we'll refund you. Questions? Call us."}</p>` : `<ol class="steps">${steps}</ol>`}
      ${o.onTab ? `<p class="op-msg">You're paying at the end. Tap <b>Ask for the bill</b> on the menu page when you're ready.</p>` : ""}
      <div class="op-when">${o.mode === "dinein"
        ? `<span class="hand">Dine-in</span> Table ${esc(o.table)}`
        : `<span class="hand">${o.mode === "delivery" ? "Delivery" : "Pickup"}</span> ${esc(dayLabel(o.date))} · ${esc(timeLabel(o.time))}`}</div>
      <div class="op-pay"></div>
      <ul class="op-lines">${o.lines.map((l) => `<li><span>${esc(Number(l.qty) | 0)} × ${esc(l.name)}${l.unit ? ` <small>${esc(l.unit)}</small>` : ""}</span><b>${esc(money(l.amount))}</b></li>`).join("")}
        ${o.deliveryFee ? `<li><span>Delivery</span><b>${esc(money(o.deliveryFee))}</b></li>` : ""}
        ${Array.isArray(o.charges)
          ? o.charges.map((c) => `<li><span>${esc(c.name)}</span><b>${esc(Number(c.amount) < 0 ? `−${money(-Number(c.amount))}` : money(Number(c.amount) || 0))}</b></li>`).join("")
          : charges ? `<li><span>Packing, service charge &amp; round-off</span><b>${esc(charges > 0 ? money(charges) : `−${money(-charges)}`)}</b></li>` : ""}
        ${o.discount ? `<li class="off"><span>Discount${o.coupon ? ` (${esc(o.coupon)})` : ""}</span><b>−${esc(money(o.discount))}</b></li>` : ""}
        <li class="tot"><span>Total</span><b>${esc(money(o.total))}</b></li></ul>
      ${data.canReview && o.status === "completed" ? reviewBlock(data) : ""}
      ${o.paid ? `<a class="pill fill" href="${esc(P.invoiceUrl(o.code, ref.token))}" target="_blank" rel="noopener">View &amp; print bill${o.invoiceNo ? ` · ${esc(o.invoiceNo)}` : ""}</a>` : ""}
      ${o.utr && !o.paid ? `<p class="op-msg">We have your UPI reference <b>${esc(o.utr)}</b> and we're checking it with the bank.</p>` : ""}
      ${help(data.contact, o.code)}
      <details class="op-log"><summary>Order history</summary><ul>${o.events.map((e) => `<li>${esc(when(e.at))} · ${esc(e.label)}</li>`).join("")}</ul></details>`;
    wireReview(ref, data);
    if (data.pay) P.payPanel(card.querySelector(".op-pay"), { ...data.pay, code: o.code, token: ref.token, total: o.total, expiresAt: o.status === "expired" ? null : o.expiresAt }, () => load(ref));
    // keep checking until it's finished
    clearTimeout(timer);
    if (!["completed", "cancelled"].includes(o.status) && !data.pay) timer = setTimeout(() => load(ref), 20000);
  }

  // "How was it?": stars and a comment; happy customers get the Google review link.
  function reviewBlock(data) {
    const fb = data.feedback;
    return `<form class="review" novalidate>
      <p class="hand">${fb ? "Thanks for your rating!" : "How was it?"}</p>
      <div class="stars" role="radiogroup" aria-label="Your rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="${Boolean(fb && fb.stars === n)}" aria-label="${n} star${n > 1 ? "s" : ""}" data-star="${n}" class="${fb && fb.stars >= n ? "on" : ""}">★</button>`).join("")}</div>
      <textarea name="comment" rows="2" maxlength="500" placeholder="Tell us more (optional)">${esc(fb ? fb.comment : "")}</textarea>
      <button class="pill" type="submit">${fb ? "Update" : "Send"}</button>
      <p class="review-note" role="status"></p>
    </form>`;
  }

  function wireReview(ref, data) {
    const form = card.querySelector("form.review");
    if (!form) return;
    let stars = data.feedback ? data.feedback.stars : 0;
    form.querySelector(".stars").addEventListener("click", (e) => {
      const b = e.target.closest("[data-star]");
      if (!b) return;
      stars = Number(b.dataset.star);
      form.querySelectorAll("[data-star]").forEach((s) => { const n = Number(s.dataset.star); s.classList.toggle("on", n <= stars); s.setAttribute("aria-checked", String(n === stars)); });
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const out = form.querySelector(".review-note");
      if (!stars) { out.textContent = "Tap the stars first"; return; }
      try {
        const r = await P.api(`/api/orders/${encodeURIComponent(ref.code)}/feedback`, { method: "POST", body: { t: ref.token, stars, comment: form.elements.namedItem("comment").value } });
        const review = safeHttps(r.googleReviewUrl);
        out.innerHTML = review ? `Thank you! Would you share it on Google? <a href="${esc(review)}" target="_blank" rel="noopener">Write a Google review →</a>` : "Thank you! We read every message.";
      } catch (ex) { out.textContent = ex.message; }
    });
  }

  async function load(ref) {
    try {
      render(await P.api(`/api/orders/${encodeURIComponent(ref.code)}?t=${encodeURIComponent(ref.token)}`), ref);
    } catch (e) {
      card.innerHTML = `<h1 class="display">Hmm.</h1><p class="op-msg">${esc(e.message)}</p><button class="pill fill" type="button">Try again</button>`;
      card.querySelector("button").addEventListener("click", () => load(ref));
    }
  }

  function mine(current) {
    const list = P.savedOrders().filter((o) => !current || o.code !== current.code);
    const box = document.getElementById("myOrders");
    box.hidden = !list.length;
    box.querySelector("ul").innerHTML = list.map((o) => `<li><a href="${esc(P.orderUrl(o.code, o.token))}">${esc(o.code)}</a> <small>${esc(new Date(o.at).toLocaleDateString("en-IN"))}</small></li>`).join("");
  }

  function listCard() {
    card.innerHTML = `<h1 class="display">Your orders</h1><p class="op-msg">${P.savedOrders().length ? "Pick an order below." : "Orders you place on this phone show up here. Open the link from your order to see it."}</p>`;
  }

  function start() {
    const ref = parseHash();
    mine(ref);
    if (ref) { load(ref); return; }
    listCard();
  }
  document.getElementById("forgetOrders").addEventListener("click", () => {
    P.forgetOrders();
    const ref = parseHash();
    mine(ref);
    if (!ref) listCard();
  });
  window.addEventListener("hashchange", start);
  start();
})();
