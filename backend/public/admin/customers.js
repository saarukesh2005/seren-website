/* Customers tab: the customer list (points, favourites, offers consent), coupons, offer messages, feedback. */
SA.customers = (function () {
  "use strict";
  const { esc, money, api, toast, ago, toPaise } = SA;
  const $ = (s) => document.querySelector(s);
  let sub = "list";

  function show() {
    document.querySelectorAll("#custTabs [data-sub]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sub === sub)));
    ({ list, coupons, broadcast, feedback })[sub]();
  }

  /* ---------- customers ---------- */
  async function list(q = "") {
    const body = $("#custBody");
    if (!body.querySelector("#custSearch")) {
      body.innerHTML = `<input type="search" id="custSearch" placeholder="Search name or mobile" aria-label="Search customers"><div class="table-wrap"><table class="grid" id="custTable"></table></div>`;
      let t;
      body.querySelector("#custSearch").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => list(e.target.value.trim()), 300); });
    }
    try {
      const { customers } = await api(`/customers?q=${encodeURIComponent(q)}`);
      $("#custTable").innerHTML = `<thead><tr><th>Customer</th><th>Orders</th><th>Spent</th><th>Points</th><th>Usually orders</th><th>Last order</th><th>Offers on WhatsApp</th></tr></thead>
        <tbody>${customers.length ? customers.map((c) => `<tr>
          <td><b>${esc(c.name || "—")}</b><br><a href="https://wa.me/91${esc(c.phone)}" target="_blank" rel="noopener">${esc(c.phone)}</a></td>
          <td>${c.orders}</td><td>${esc(money(c.spent))}</td><td>${c.points}</td><td>${esc(c.favourite || "")}</td><td>${esc(ago(c.last_at))}</td>
          <td><label class="switch"><input type="checkbox" data-optin="${esc(c.phone)}" ${c.opt_in ? "checked" : ""}> ${c.opt_in ? "Yes" : "No"}</label></td></tr>`).join("")
        : `<tr><td colspan="7" class="empty">Customers appear here after their first paid order</td></tr>`}</tbody>`;
    } catch (e) { toast(e.message, true); }
  }

  /* ---------- coupons ---------- */
  async function coupons() {
    const body = $("#custBody");
    try {
      const { coupons: rows } = await api("/coupons");
      body.innerHTML = `
        ${SA.can("offers") ? `<form class="box couponform" id="couponForm"><h3>New coupon</h3>
          <div class="formgrid">
            <label>Code<input name="code" maxlength="20" required placeholder="WELCOME10"></label>
            <label>Type<select name="kind"><option value="percent">% off</option><option value="flat">₹ off</option></select></label>
            <label>How much<input name="value" inputmode="decimal" required placeholder="10"></label>
            <label>Minimum order ₹<input name="min_order" inputmode="decimal" placeholder="0"></label>
            <label>Max discount ₹ <span class="opt">(for % off)</span><input name="max_discount" inputmode="decimal" placeholder="no cap"></label>
            <label>Total uses <span class="opt">(empty = unlimited)</span><input name="max_uses" inputmode="numeric"></label>
            <label>Starts<input type="date" name="starts"></label>
            <label>Ends<input type="date" name="ends"></label>
            <label>Note <span class="opt">(for you)</span><input name="note" maxlength="100" placeholder="Diwali offer"></label>
          </div>
          <label class="check"><input type="checkbox" name="once_per_phone"> Once per customer (by mobile number)</label>
          <p class="err" id="couponErr" role="alert"></p>
          <button class="btn primary" type="submit">Create coupon</button></form>` : ""}
        <div class="table-wrap"><table class="grid"><thead><tr><th>Code</th><th>Discount</th><th>Rules</th><th>Used</th><th>Active</th></tr></thead><tbody>
          ${rows.length ? rows.map((c) => `<tr><td><b>${esc(c.code)}</b>${c.note ? `<br><span class="opt">${esc(c.note)}</span>` : ""}</td>
            <td>${c.kind === "percent" ? `${c.value}%${c.max_discount ? ` (max ${esc(money(c.max_discount))})` : ""}` : esc(money(c.value))}</td>
            <td class="opt">${[c.min_order ? `min ${money(c.min_order)}` : "", c.starts ? `from ${c.starts}` : "", c.ends ? `until ${c.ends}` : "", c.once_per_phone ? "once per customer" : ""].filter(Boolean).map(esc).join(" · ") || "—"}</td>
            <td>${c.uses}${c.max_uses ? ` / ${c.max_uses}` : ""}</td>
            <td><label class="switch"><input type="checkbox" data-coupon="${esc(c.code)}" ${c.active ? "checked" : ""} ${SA.can("offers") ? "" : "disabled"}> ${c.active ? "On" : "Off"}</label></td></tr>`).join("")
          : `<tr><td colspan="5" class="empty">No coupons yet</td></tr>`}</tbody></table></div>`;
      const form = body.querySelector("#couponForm");
      if (form) form.addEventListener("submit", createCoupon);
    } catch (e) { toast(e.message, true); }
  }

  async function createCoupon(e) {
    e.preventDefault();
    const f = e.target;
    const v = (n) => f.elements.namedItem(n).value.trim();
    const kind = v("kind");
    const paise = (n) => { const p = toPaise(v(n)); return p === null ? 0 : p; };
    const body = {
      code: v("code").toUpperCase(), kind, value: kind === "percent" ? Number(v("value")) : paise("value"),
      min_order: paise("min_order"), max_discount: paise("max_discount"), max_uses: Number(v("max_uses") || 0),
      starts: v("starts"), ends: v("ends"), note: v("note"), once_per_phone: f.elements.namedItem("once_per_phone").checked,
    };
    if ([body.value, body.min_order, body.max_discount].some(Number.isNaN)) { $("#couponErr").textContent = "Amounts take numbers only"; return; }
    try { await api("/coupons", body); toast(`Coupon ${body.code} created`); coupons(); }
    catch (ex) { $("#couponErr").textContent = ex.message; }
  }

  /* ---------- offer messages ---------- */
  function broadcast() {
    $("#custBody").innerHTML = `<form class="box" id="bcForm"><h3>Send an offer on WhatsApp</h3>
      <p class="meta">Only customers who ticked "send me offers" get it. WhatsApp opens for each one with your message ready; you press send. Free, no WhatsApp business account needed. Use {name} for their first name.</p>
      <textarea name="text" rows="4" maxlength="1000" placeholder="Hi {name}! This weekend only: our new Pistachio Kunafa cookie, 10% off with code KUNAFA10."></textarea>
      <button class="btn primary" type="submit">Prepare messages</button></form><div id="bcList"></div>`;
    $("#bcForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const { links } = await api("/broadcast", { text: e.target.elements.namedItem("text").value });
        $("#bcList").innerHTML = links.length
          ? `<p class="meta">${links.length} customer${links.length === 1 ? "" : "s"}. Tap each to open WhatsApp:</p><ul class="bclist">${links.map((l) => `<li><a class="btn ghost small" href="${esc(l.url)}" target="_blank" rel="noopener" data-sent>${esc(l.name || l.phone)}</a></li>`).join("")}</ul>`
          : `<p class="empty">No customers have agreed to offers yet</p>`;
      } catch (ex) { toast(ex.message, true); }
    });
    $("#custBody").addEventListener("click", (e) => { const a = e.target.closest("[data-sent]"); if (a) a.classList.add("sent"); });
  }

  /* ---------- feedback ---------- */
  async function feedback() {
    try {
      const d = await api("/feedback");
      $("#custBody").innerHTML = `<div class="stats"><div class="stat"><b>${d.average ?? "—"}</b><span>Average rating</span></div><div class="stat"><b>${d.count}</b><span>Ratings</span></div></div>
        <ul class="fblist">${d.feedback.length ? d.feedback.map((f) => `<li class="box"><div class="row"><span class="stars-s" aria-label="${f.stars} stars">${"★".repeat(f.stars)}<span class="opt">${"★".repeat(5 - f.stars)}</span></span><span class="meta">${esc(ago(f.at))} · ${esc(f.code)}</span></div>
          ${f.comment ? `<p>${esc(f.comment)}</p>` : ""}<p class="meta">${esc(f.customer_name || "")}${f.customer_phone ? ` · <a href="https://wa.me/91${esc(f.customer_phone)}" target="_blank" rel="noopener">${esc(f.customer_phone)}</a>` : ""}</p></li>`).join("")
        : `<li class="empty">No ratings yet. Customers can rate an order on their order page once it's completed.</li>`}</ul>`;
    } catch (e) { toast(e.message, true); }
  }

  function start() {
    $("#custTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-sub]"); if (b) { sub = b.dataset.sub; $("#custBody").innerHTML = ""; show(); } });
    $("#custBody").addEventListener("change", async (e) => {
      const opt = e.target.closest("[data-optin]");
      const cp = e.target.closest("[data-coupon]");
      try {
        if (opt) { await api(`/customers/${opt.dataset.optin}`, { opt_in: opt.checked }); toast(opt.checked ? "Offers on" : "Offers off"); }
        if (cp) { await api(`/coupons/${encodeURIComponent(cp.dataset.coupon)}`, { active: cp.checked }); toast(cp.checked ? "Coupon on" : "Coupon off"); }
      } catch (ex) { toast(ex.message, true); }
    });
    if (!SA.can("offers")) document.querySelector('#custTabs [data-sub="broadcast"]').hidden = true;
  }
  return { start, show };
})();
