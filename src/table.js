/* For guests who scanned their table's QR code: a bar to call a waiter, ask for the bill,
   and see the table's running tab (and pay it by UPI once the bill is made). */
(function () {
  "use strict";
  const P = window.SerenPay;
  const T = window.SEREN_TABLE;
  if (!T || !T.k || !P.enabled) return;
  const { esc, money } = P;
  const path = (extra = "") => `/api/tables/${encodeURIComponent(T.table)}${extra}`;

  const bar = document.createElement("div");
  bar.className = "tablebar";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", `Table ${T.table}`);
  bar.innerHTML = `<span class="tb-t">Table ${esc(T.table)}</span>
    <button type="button" data-call="waiter">Call waiter</button>
    <button type="button" data-call="bill">Ask for the bill</button>
    <button type="button" data-tab>Our tab</button>`;
  const sheet = document.createElement("dialog");
  sheet.className = "tabsheet";
  sheet.setAttribute("data-lenis-prevent", "");
  sheet.setAttribute("aria-label", "Your table's tab");
  document.body.append(bar, sheet);

  let toastTimer;
  function note(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg; t.classList.add("on");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2600);
  }

  bar.addEventListener("click", async (e) => {
    const call = e.target.closest("[data-call]");
    if (call) {
      call.disabled = true;
      try {
        const r = await P.api(path("/call"), { method: "POST", body: { k: T.k, kind: call.dataset.call } });
        note(r.already ? "We already know. Someone's coming!" : call.dataset.call === "bill" ? "We're bringing your bill" : "A waiter is on the way");
      } catch (ex) { note(ex.message); }
      setTimeout(() => { call.disabled = false; }, 4000);
      return;
    }
    if (e.target.closest("[data-tab]")) openTab();
  });

  // The tab and its bill are only shown with the 4-digit PIN staff gave the table. It is remembered for this visit.
  const tabUrl = (pin) => `${path()}?k=${encodeURIComponent(T.k)}${pin ? `&pin=${encodeURIComponent(pin)}` : ""}`;

  async function openTab(pin = P.tablePin(T.table), wrong = "") {
    sheet.innerHTML = `<div class="ts-in"><p class="hand">Loading your tab…</p></div>`;
    if (!sheet.open) sheet.showModal();
    try {
      const d = await P.api(tabUrl(pin));
      if (d.needPin) { askPin(d, wrong); return; }
      if (pin) P.rememberPin(T.table, pin);
      render(d);
    } catch (e) {
      if (e.status === 403 && e.needPin) { P.forgetPin(T.table); askPin({ table: T.table }, e.message); return; } // wrong or stale PIN: ask again
      sheet.innerHTML = `<div class="ts-in"><p>${esc(e.message)}</p><button class="pill fill" type="button" data-close>Close</button></div>`;
    }
  }

  function askPin(d, message) {
    sheet.innerHTML = `<div class="ts-in"><div class="ts-head"><h2>Table ${esc(d.table || T.table)}</h2><button class="close" type="button" data-close aria-label="Close">×</button></div>
      <form class="pin-form" novalidate>
        <label for="tabPin">Table PIN</label>
        <p class="hint">Type the 4-digit table PIN our staff gave you</p>
        <div class="utr-row"><input id="tabPin" name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="4 digits" required>
          <button class="pill fill" type="submit">Show our tab</button></div>
        <p class="err" role="alert">${esc(message || "")}</p>
      </form></div>`;
    const form = sheet.querySelector(".pin-form");
    const input = form.elements.namedItem("pin");
    input.addEventListener("input", () => { input.value = input.value.replace(/\D/g, "").slice(0, 4); }); // digits only
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!P.PIN_RE.test(input.value)) { form.querySelector(".err").textContent = "Type the 4-digit table PIN our staff gave you"; input.focus(); return; }
      openTab(input.value);
    });
    input.focus();
  }

  function render(d) {
    const head = `<div class="ts-head"><h2>Table ${esc(d.table)}</h2><button class="close" type="button" data-close aria-label="Close">×</button></div>`;
    if (!d.tab) {
      sheet.innerHTML = `<div class="ts-in">${head}<p>Nothing on your tab yet.${d.payLater ? " Order from the menu and choose <b>Pay at the end</b>." : ""}</p></div>`;
      return;
    }
    const t = d.tab;
    sheet.innerHTML = `<div class="ts-in">${head}
      <ul class="ts-lines">${t.lines.map((l) => `<li><span>${esc(Number(l.qty) | 0)} × ${esc(l.name)}</span><b>${esc(money(l.amount))}</b></li>`).join("")}
        <li class="tot"><span>Total so far</span><b>${esc(money(t.total))}</b></li></ul>
      <ul class="ts-rounds">${t.rounds.map((r) => `<li>${esc(r.code)} · ${esc(r.status)}</li>`).join("")}</ul>
      ${d.bill ? (d.bill.paid ? `<p class="hand">Paid. Thank you!</p><a class="pill fill" href="${esc(P.invoiceUrl(d.bill.code, d.bill.token))}" target="_blank" rel="noopener">See your bill</a>` : `<div class="ts-pay"></div>`)
        : `<p class="hint">When you're ready, tap <b>Ask for the bill</b>. We'll make one bill for the whole table.</p>`}
    </div>`;
    if (d.bill && !d.bill.paid) {
      P.rememberOrder(d.bill.code, d.bill.token);
      P.api(`/api/orders/${encodeURIComponent(d.bill.code)}?t=${encodeURIComponent(d.bill.token)}`).then((o) => {
        const host = sheet.querySelector(".ts-pay");
        if (!host) return;
        if (o.pay) P.payPanel(host, { ...o.pay, code: d.bill.code, token: d.bill.token, total: o.order.total, expiresAt: null }, () => openTab());
        else host.innerHTML = `<p>${esc(o.order.statusLabel)}</p>`;
      }).catch((e) => { const host = sheet.querySelector(".ts-pay"); if (host) host.textContent = e.message; });
    }
  }

  sheet.addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === sheet) sheet.close(); });

  // is this table seated (tab open)? checkout only offers "pay at the end" if so
  async function refreshOpen() {
    try { T.open = Boolean((await P.api(tabUrl(""))).open); } // no PIN needed just to know the table is seated
    catch (e) { T.open = false; }
  }
  refreshOpen();
  setInterval(() => { if (!document.hidden) refreshOpen(); }, 60000);
})();
