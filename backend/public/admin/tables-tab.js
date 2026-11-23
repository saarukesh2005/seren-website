/* Tables tab: waiter calls and bill requests (with a chime), open tabs, making one bill per table. */
SA.tablesTab = (function () {
  "use strict";
  const { esc, money, api, toast, ago } = SA;
  const $ = (s) => document.querySelector(s);
  let timer;
  let seenCalls = null;

  async function load() {
    try {
      const { tabs, calls } = await api("/tables");
      render(tabs, calls);
      alertCalls(calls);
    } catch (e) { toast(e.message, true); }
  }

  function render(tabs, calls) {
    $("#callList").innerHTML = calls.length
      ? calls.map((c) => `<div class="call ${c.kind}"><b>Table ${esc(c.table_no)}</b> ${c.kind === "bill" ? "wants the bill" : "is calling a waiter"} <span class="meta">${esc(ago(c.at))}</span>
          <button class="btn ok small" type="button" data-done="${c.id}">Done</button></div>`).join("")
      : "";
    $("#tabGrid").innerHTML = tabs.length
      ? tabs.map((t) => `<article class="tabcard ${t.status}">
          <h3>Table ${esc(t.table_no)}</h3>
          ${t.pin ? `<p class="meta">Table PIN <span class="pin-chip">${esc(t.pin)}</span> <span class="opt">tell the guests</span></p>` : ""}
          <p class="meta">${Number(t.rounds) || 0} round${t.rounds === 1 ? "" : "s"} · open ${esc(ago(t.opened_at))}</p>
          <b class="amt">${esc(money(t.total))}</b>
          ${t.status === "open"
            ? `<div class="btns"><button class="btn ok small" type="button" data-take="${esc(t.table_no)}">Take order</button>
               ${t.rounds ? `<button class="btn plum small" type="button" data-bill="${esc(t.table_no)}">Make the bill</button>` : `<button class="btn ghost small" type="button" data-close="${esc(t.table_no)}">Close (left without ordering)</button>`}
               <button class="btn ghost small" type="button" data-move="${esc(t.table_no)}">Move / join table</button></div>`
            : `<p class="meta">Bill ${esc(t.bill_code || "")} waiting for payment</p>
               <div class="btns"><button class="btn ghost small" type="button" data-open="${esc(t.bill_code || "")}">Open bill</button>
               <button class="btn ghost small" type="button" data-reopen="${esc(t.table_no)}">Undo bill</button></div>`}
        </article>`).join("")
      : `<p class="empty">No open tables</p>`;
    // every table from Settings: the free ones are one tap to seat (that also makes the table PIN)
    const names = ((SA.state.settings && SA.state.settings.dineInTables) || "").split(",").map((t) => t.trim()).filter(Boolean);
    const busy = new Set(tabs.map((t) => String(t.table_no).toLowerCase()));
    const free = names.filter((n) => !busy.has(n.toLowerCase()));
    $("#freeGrid").innerHTML = names.length
      ? (free.length ? free.map((n) => `<button class="freetile" type="button" data-seat="${esc(n)}"><b>${esc(n)}</b><span>Tap to seat</span></button>`).join("") : `<p class="empty">Every table is taken</p>`)
      : `<p class="empty">Add your table names in Settings → Dine-in to see them here.</p>`;
    const s = SA.state.settings;
    $("#payLaterHint").textContent = s && s.dineInPayLater
      ? "Guests ordering from the table card can pay at the end. Each table's rounds collect here until you make the bill."
      : "Pay-at-the-end is off, so table guests pay as they order. Switch it on in Settings → Dine-in.";
  }

  function alertCalls(calls) {
    const ids = new Set(calls.map((c) => c.id));
    if (seenCalls && calls.some((c) => !seenCalls.has(c.id))) {
      SA.chime && SA.chime();
      const onTab = document.querySelector('[data-tab="tables"]').getAttribute("aria-current") === "page";
      $("#callDot").hidden = onTab;
      if ("Notification" in window && Notification.permission === "granted") {
        const c = calls.find((x) => !seenCalls.has(x.id));
        new Notification(`SEREN: Table ${c.table_no}`, { body: c.kind === "bill" ? "Wants the bill" : "Calling a waiter" });
      }
    }
    seenCalls = ids;
  }

  function start() {
    const names = (SA.state.settings && SA.state.settings.dineInTables || "").split(",").map((t) => t.trim()).filter(Boolean);
    $("#tableNames").innerHTML = names.map((t) => `<option value="${esc(t)}">`).join("");
    $("#seatForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const t = $("#seatTable").value.trim();
      try { const r = await api(`/tables/${encodeURIComponent(t)}/open`, {}); toast(`Table ${t} is open. Tell the guests their table PIN: ${r.pin}`); $("#seatTable").value = ""; load(); }
      catch (ex) { toast(ex.message, true); }
    });
    if (!(SA.state.settings && SA.state.settings.dineInPayLater)) $("#seatForm").hidden = true;
    $("#tab-tables").addEventListener("click", async (e) => {
      const done = e.target.closest("[data-done]");
      const bill = e.target.closest("[data-bill]");
      const reopen = e.target.closest("[data-reopen]");
      const openBill = e.target.closest("[data-open]");
      const close = e.target.closest("[data-close]");
      const take = e.target.closest("[data-take]");
      const seatBtn = e.target.closest("[data-seat]");
      if (seatBtn) {
        try { const r = await api(`/tables/${encodeURIComponent(seatBtn.dataset.seat)}/open`, {}); toast(`Table ${seatBtn.dataset.seat} seated. Tell the guests their PIN: ${r.pin}`); load(); }
        catch (ex) { toast(ex.message, true); }
        return;
      }
      const mv = e.target.closest("[data-move]");
      try {
        if (done) { await api(`/calls/${done.dataset.done}/done`, {}); load(); }
        if (take) {
          if (!SA.state.catalog) { const c = await api("/catalog"); SA.state.catalog = { categories: c.categories, items: c.items }; }
          takeOrder(take.dataset.take);
          return;
        }
        if (mv) {
          const to = window.prompt(`Move table ${mv.dataset.move} to which table? (If that table is open, the two bills are joined.)`);
          if (to && to.trim()) { const r = await api(`/tables/${encodeURIComponent(mv.dataset.move)}/move`, { to: to.trim() }); toast(r.how === "merged" ? "Tables joined into one bill" : `Moved to table ${to.trim()}`); load(); }
          return;
        }
        if (bill) {
          const service = SA.state.settings && SA.state.settings.charges && SA.state.settings.charges.servicePercent;
          const keep = service ? window.confirm(`Add the ${service}% service charge? Press Cancel if the guests asked to remove it.`) : true;
          const r = await api(`/tables/${encodeURIComponent(bill.dataset.bill)}/bill`, { service: keep });
          toast(`Bill ${r.code} made. Guests can pay it on their phones, or take cash/card.`);
          load();
        }
        if (close) { await api(`/tables/${encodeURIComponent(close.dataset.close)}/close`, {}); load(); }
        if (reopen && window.confirm("Undo this bill so the table can order more?")) { await api(`/tables/${encodeURIComponent(reopen.dataset.reopen)}/reopen`, {}); load(); }
        if (openBill) { SA.tab("orders"); location.hash = openBill.dataset.open; SA.orders.open(openBill.dataset.open); }
      } catch (ex) { toast(ex.message, true); }
    });
    load();
    timer = setInterval(() => { if (!document.hidden) load(); }, 15000);
  }
  /* ---------- a waiter takes the order at the table ---------- */
  function takeOrder(table) {
    const items = ((SA.state.catalog && SA.state.catalog.items) || []).filter((i) => i.price !== null && i.available && !i.hidden);
    let cart = []; // [{ id, opts, qty, label, price }]
    let d = document.getElementById("captainSheet");
    if (!d) { d = document.createElement("dialog"); d.id = "captainSheet"; d.className = "sheet"; d.setAttribute("aria-labelledby", "captainTitle"); document.body.append(d); }
    const total = () => cart.reduce((n, l) => n + l.price * l.qty, 0);
    const draw = () => {
      d.querySelector("#capLines").innerHTML = cart.length ? cart.map((l, i) => `<li><span>${Number(l.qty)} × ${esc(l.label)}</span><span><button class="btn ghost small" type="button" data-less="${i}" aria-label="One fewer">−</button> <b>${esc(money(l.price * l.qty))}</b></span></li>`).join("") : `<li class="meta">Tap items to add</li>`;
      d.querySelector("#capTotal").textContent = money(total());
    };
    d.innerHTML = `<div class="sheet-in"><div class="sheet-head"><h2 id="captainTitle">Table ${esc(table)} · new order</h2><button class="close" type="button" data-x aria-label="Close">×</button></div>
      <input type="search" id="capFind" placeholder="Find an item" aria-label="Find an item" autocomplete="off">
      <div class="cap-items" id="capItems">${items.map((i) => `<button class="btn ghost small" type="button" data-item="${esc(i.id)}">${esc(i.name)} · ${esc(money(i.price))}${(i.options || []).length ? " ⋯" : ""}</button>`).join("")}</div>
      <div id="capOpts"></div>
      <ul class="lines" id="capLines"></ul>
      <label>Note for the kitchen<input id="capNote" maxlength="200"></label>
      <div class="btns"><b>Total <span id="capTotal"></span></b><button class="btn ok" type="button" id="capSend">Send to kitchen</button></div></div>`;
    const add = (item, opts, extra, names) => {
      const key = `${item.id}|${opts.slice().sort().join(",")}`;
      const hit = cart.find((l) => l.key === key);
      cart = hit ? cart.map((l) => (l === hit ? { ...l, qty: Math.min(l.qty + 1, 50) } : l))
        : [...cart, { key, id: item.id, opts, qty: 1, price: item.price + extra, label: names.length ? `${item.name} (${names.join(", ")})` : item.name }];
      draw();
    };
    d.querySelector("#capFind").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      d.querySelectorAll("[data-item]").forEach((b) => { b.hidden = q && !b.textContent.toLowerCase().includes(q); });
    });
    d.addEventListener("click", async (e) => {
      if (e.target.closest("[data-x]")) { d.close(); return; }
      const less = e.target.closest("[data-less]");
      if (less) { const i = Number(less.dataset.less); cart = cart.map((l, j) => (j === i ? { ...l, qty: l.qty - 1 } : l)).filter((l) => l.qty > 0); draw(); return; }
      const b = e.target.closest("[data-item]");
      if (b) {
        const item = items.find((x) => x.id === b.dataset.item);
        if (!(item.options || []).length) { add(item, [], 0, []); return; }
        const box = d.querySelector("#capOpts");
        box.innerHTML = `<form class="box" id="capOptForm"><b>${esc(item.name)}</b>${item.options.map((g) => `<fieldset class="seg"><legend>${esc(g.name)}</legend>${g.choices.map((c, i) => `<label><input type="${g.pick === "many" ? "checkbox" : "radio"}" name="${esc(g.id)}" value="${esc(`${g.id}-${c.id}`)}" data-price="${Number(c.price) || 0}" data-name="${esc(c.name)}" ${g.required && i === 0 ? "checked" : ""}><span>${esc(c.name)}${c.price ? ` +${esc(money(c.price))}` : ""}</span></label>`).join("")}</fieldset>`).join("")}
          <button class="btn plum small" type="submit">Add</button></form>`;
        box.querySelector("form").addEventListener("submit", (ev) => {
          ev.preventDefault();
          const picked = [...ev.target.querySelectorAll("input:checked")];
          add(item, picked.map((x) => x.value), picked.reduce((n, x) => n + Number(x.dataset.price), 0), picked.map((x) => x.dataset.name));
          box.innerHTML = "";
        });
        return;
      }
      if (e.target.closest("#capSend")) {
        if (!cart.length) { toast("Add items first", true); return; }
        try {
          const r = await api(`/tables/${encodeURIComponent(table)}/order`, { items: cart.map((l) => (l.opts.length ? { id: l.id, qty: l.qty, opts: l.opts } : { id: l.id, qty: l.qty })), notes: d.querySelector("#capNote").value });
          toast(`Sent to the kitchen (${r.code})`);
          d.close(); load();
        } catch (ex) { toast(ex.message, true); }
      }
    });
    draw();
    d.showModal();
  }

  return { start, load, stop: () => clearInterval(timer) };
})();
