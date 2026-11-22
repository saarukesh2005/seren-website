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
          <p class="meta">${t.rounds} round${t.rounds === 1 ? "" : "s"} · open ${esc(ago(t.opened_at))}</p>
          <b class="amt">${esc(money(t.total))}</b>
          ${t.status === "open"
            ? (t.rounds ? `<button class="btn plum small" type="button" data-bill="${esc(t.table_no)}">Make the bill</button>` : `<button class="btn ghost small" type="button" data-close="${esc(t.table_no)}">Close (left without ordering)</button>`)
            : `<p class="meta">Bill ${esc(t.bill_code || "")} waiting for payment</p>
               <div class="btns"><button class="btn ghost small" type="button" data-open="${esc(t.bill_code || "")}">Open bill</button>
               <button class="btn ghost small" type="button" data-reopen="${esc(t.table_no)}">Undo bill</button></div>`}
        </article>`).join("")
      : `<p class="empty">No open tables</p>`;
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
      try { await api(`/tables/${encodeURIComponent(t)}/open`, {}); toast(`Table ${t} is open. Guests can order and pay at the end.`); $("#seatTable").value = ""; load(); }
      catch (ex) { toast(ex.message, true); }
    });
    if (!(SA.state.settings && SA.state.settings.dineInPayLater)) $("#seatForm").hidden = true;
    $("#tab-tables").addEventListener("click", async (e) => {
      const done = e.target.closest("[data-done]");
      const bill = e.target.closest("[data-bill]");
      const reopen = e.target.closest("[data-reopen]");
      const openBill = e.target.closest("[data-open]");
      const close = e.target.closest("[data-close]");
      try {
        if (done) { await api(`/calls/${done.dataset.done}/done`, {}); load(); }
        if (bill) {
          const r = await api(`/tables/${encodeURIComponent(bill.dataset.bill)}/bill`, {});
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
  return { start, load, stop: () => clearInterval(timer) };
})();
