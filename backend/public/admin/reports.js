/* Reports tab: sales for a period (headline numbers, sales by day and by hour, best sellers,
   payment split, refunds, coupons, rating) plus the day-closing sheet and the accounts export.
   Charts are single-series bars in one hue, with a hover/focus tooltip and a table view. */
SA.reports = (function () {
  "use strict";
  const { esc, money, api, toast, todayIST } = SA;
  const $ = (s) => document.querySelector(s);
  const RANGES = [["today", "Today"], ["7", "7 days"], ["30", "30 days"], ["month", "This month"]];
  let range = "7";

  const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function period() {
    const t = todayIST();
    if (range === "today") return [t, t];
    if (range === "month") return [`${t.slice(0, 8)}01`, t];
    if (range === "custom") return [$("#repFrom").value || t, $("#repTo").value || t];
    return [addDays(t, -(Number(range) - 1)), t];
  }

  function chips() {
    $("#repRange").innerHTML = RANGES.map(([k, l]) => `<button type="button" data-r="${k}" aria-pressed="${k === range}">${l}</button>`).join("");
  }

  async function show() {
    chips();
    const [from, to] = period();
    $("#repFrom").value = from; $("#repTo").value = to;
    $("#csvBtn").href = `/api/admin/export.csv?from=${from}&to=${to}`;
    $("#dayCloseBtn").href = `/day-close?date=${to}`;
    $("#dayCloseBtn").textContent = to === todayIST() ? "Print today's closing" : `Print closing for ${to}`;
    try {
      const { report } = await api(`/reports?from=${from}&to=${to}`);
      render(report);
    } catch (e) { toast(e.message, true); }
  }

  // One-series bar chart. rows: [{ label, value, sub }]
  function bars(title, rows, fmt) {
    if (!rows.length) return `<section class="box chart"><h3>${esc(title)}</h3><p class="empty">No sales in this period</p></section>`;
    const max = Math.max(...rows.map((r) => r.value), 1);
    return `<section class="box chart"><h3>${esc(title)}</h3>
      <div class="bars" role="list">${rows.map((r) => `<div class="bar" role="listitem" tabindex="0" data-tip="${esc(`${r.label}: ${fmt(r.value)}${r.sub ? ` · ${r.sub}` : ""}`)}">
        <i style="height:${Math.max(2, (r.value / max) * 100)}%"></i><span>${esc(r.short || r.label)}</span></div>`).join("")}</div>
      <details><summary>Show as a table</summary><table class="grid"><tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="r">${esc(fmt(r.value))}</td><td class="opt">${esc(r.sub || "")}</td></tr>`).join("")}</tbody></table></details>
    </section>`;
  }

  const dayShort = (ymd) => new Date(`${ymd}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const hourLabel = (h) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;
  const NAMES = { upi: "UPI", cash: "Cash", card: "Card", pickup: "Pickup", delivery: "Delivery", dinein: "Dine-in", counter: "Counter", web: "Website", whatsapp: "WhatsApp", table: "Table QR", tab: "Table bills" };

  function split(title, rows, total) {
    return `<section class="box"><h3>${esc(title)}</h3>${rows.length ? `<ul class="split">${rows.map((r) => `<li><span>${esc(NAMES[r.k] || r.k)}</span>
      <span class="track" aria-hidden="true"><i style="width:${total ? (r.revenue / total) * 100 : 0}%"></i></span><b>${esc(money(r.revenue))}</b><span class="opt">${r.orders}</span></li>`).join("")}</ul>` : `<p class="empty">—</p>`}</section>`;
  }

  function render(r) {
    const t = r.totals;
    const days = r.byDay.map((d) => ({ label: dayShort(d.day), value: d.revenue, sub: `${d.orders} bill${d.orders === 1 ? "" : "s"}` }));
    const hours = r.byHour.map((h) => ({ label: hourLabel(h.hour), value: h.orders, sub: money(h.revenue) }));
    $("#repBody").innerHTML = `
      <div class="stats">
        <div class="stat hero"><b>${esc(money(t.revenue))}</b><span>Sales</span></div>
        <div class="stat"><b>${t.orders}</b><span>Bills</span></div>
        <div class="stat"><b>${esc(money(t.average))}</b><span>Average bill</span></div>
        <div class="stat"><b>${esc(money(t.discounts))}</b><span>Discounts given</span></div>
        <div class="stat"><b>${r.refunds.n ? esc(money(r.refunds.amount)) : "₹0"}</b><span>Refunded (${r.refunds.n})</span></div>
        <div class="stat"><b>${r.rating.average ?? "—"}</b><span>Rating (${r.rating.count})</span></div>
      </div>
      <div class="rep-grid">
        ${bars("Sales by day", days, money)}
        ${bars("Busiest hours (bills)", hours, (v) => `${v} bill${v === 1 ? "" : "s"}`)}
        <section class="box"><h3>Best sellers</h3>${r.topItems.length ? `<ol class="top">${r.topItems.map((i) => `<li><span>${esc(i.name)}</span><span class="opt">${i.qty} sold</span><b>${esc(money(i.revenue))}</b></li>`).join("")}</ol>` : `<p class="empty">—</p>`}</section>
        ${split("How customers paid", r.byMethod, t.revenue)}
        ${split("How they ordered", r.byMode, t.revenue)}
        ${split("Where orders came from", r.byChannel, t.revenue)}
        <section class="box"><h3>Coupons used</h3>${r.coupons.length ? `<ul class="split">${r.coupons.map((c) => `<li><span>${esc(c.code)}</span><span class="opt">${c.orders} orders</span><b>−${esc(money(c.discount))}</b></li>`).join("")}</ul>` : `<p class="empty">No coupons used</p>`}</section>
      </div>`;
  }

  // tooltip for chart bars (hover or keyboard focus)
  function tip(e) {
    const bar = e.target.closest && e.target.closest(".bar");
    const t = $("#tip");
    if (!bar) { t.hidden = true; return; }
    t.textContent = bar.dataset.tip;
    t.hidden = false;
    const r = bar.getBoundingClientRect();
    t.style.left = `${Math.min(Math.max(r.left + r.width / 2, 90), window.innerWidth - 90)}px`;
    t.style.top = `${r.top + window.scrollY - 8}px`;
  }

  function start() {
    $("#repRange").addEventListener("click", (e) => { const b = e.target.closest("[data-r]"); if (b) { range = b.dataset.r; show(); } });
    ["#repFrom", "#repTo"].forEach((s) => $(s).addEventListener("change", () => { range = "custom"; show(); }));
    const body = $("#repBody");
    ["mouseover", "focusin"].forEach((ev) => body.addEventListener(ev, tip));
    ["mouseleave", "focusout"].forEach((ev) => body.addEventListener(ev, () => { $("#tip").hidden = true; }));
  }
  return { start, show };
})();
