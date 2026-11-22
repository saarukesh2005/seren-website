/* New bill tab: ring up a walk-in customer at the counter and print the bill. */
SA.counter = (function () {
  "use strict";
  const { esc, money, api, toast } = SA;
  const $ = (s) => document.querySelector(s);
  let cart = {};   // id -> qty
  let cat = "";
  let q = "";

  const items = () => (SA.state.catalog ? SA.state.catalog.items : []);
  const sellable = () => items().filter((i) => i.price !== null && i.available);

  function renderPick() {
    const cats = SA.state.catalog ? SA.state.catalog.categories : {};
    $("#pickCats").innerHTML = [["", "All"], ...Object.entries(cats)].map(([k, l]) => `<button type="button" data-cat="${esc(k)}" aria-pressed="${k === cat}">${esc(l)}</button>`).join("");
    const list = sellable().filter((i) => (!cat || i.category === cat) && (!q || i.name.toLowerCase().includes(q)));
    $("#pickList").innerHTML = list.length
      ? list.map((i) => `<li><button type="button" data-add="${esc(i.id)}"><b>${esc(i.name)}</b><span>${esc(money(i.price))}${i.unit ? ` · ${esc(i.unit)}` : ""}</span></button></li>`).join("")
      : `<li class="empty">${sellable().length ? "Nothing matches" : "Set prices in Menu & prices first"}</li>`;
  }

  function renderBill() {
    const byId = new Map(items().map((i) => [i.id, i]));
    const lines = Object.entries(cart).map(([id, qty]) => ({ ...byId.get(id), qty }));
    $("#billLines").innerHTML = lines.length
      ? lines.map((l) => `<li><span>${esc(l.name)}</span><span class="qty"><button type="button" data-q="${esc(l.id)}" data-d="-1" aria-label="One fewer">−</button><b>${l.qty}</b><button type="button" data-q="${esc(l.id)}" data-d="1" aria-label="One more">+</button></span><b>${esc(money(l.price * l.qty))}</b></li>`).join("")
      : `<li class="opt">Tap products to add them</li>`;
    $("#billTotal").textContent = money(lines.reduce((n, l) => n + l.price * l.qty, 0));
  }

  function setQty(id, qty) {
    const { [id]: _old, ...rest } = cart;
    cart = qty > 0 ? { ...rest, [id]: Math.min(qty, 50) } : rest;
    renderBill();
  }

  async function submit(e) {
    e.preventDefault();
    const f = e.target;
    const err = $("#billErr");
    const field = (n) => f.elements.namedItem(n).value.trim();
    if (!Object.keys(cart).length) { err.textContent = "Add at least one product"; return; }
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true; err.textContent = "";
    // open the print window now (browsers block pop-ups opened after a network wait)
    const win = window.open("about:blank", "_blank");
    try {
      const { order } = await api("/counter", {
        items: Object.entries(cart).map(([id, qty]) => ({ id, qty })),
        table: field("table"), name: field("name"), phone: field("phone"), gstin: field("gstin"), method: field("method"), utr: field("utr").replace(/\s+/g, ""),
        coupon: field("coupon"), optIn: f.elements.namedItem("optIn").checked, points: Number(f.elements.namedItem("points")?.value || 0) || 0,
      });
      toast(`Bill ${order.invoice_no} created`);
      if (win) win.location.href = `/invoice/${encodeURIComponent(order.code)}?size=80mm`;
      cart = {}; f.reset(); renderBill(); $("#loyalBox").hidden = true;
    } catch (ex) {
      if (win) win.close();
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  }

  function start() {
    $("#pickCats").addEventListener("click", (e) => { const b = e.target.closest("[data-cat]"); if (b) { cat = b.dataset.cat; renderPick(); } });
    $("#pickSearch").addEventListener("input", (e) => { q = e.target.value.trim().toLowerCase(); renderPick(); });
    $("#pickList").addEventListener("click", (e) => { const b = e.target.closest("[data-add]"); if (b) setQty(b.dataset.add, (cart[b.dataset.add] || 0) + 1); });
    $("#billLines").addEventListener("click", (e) => { const b = e.target.closest("[data-q]"); if (b) setQty(b.dataset.q, (cart[b.dataset.q] || 0) + Number(b.dataset.d)); });
    $("#billForm").addEventListener("submit", submit);
    $("#billForm").addEventListener("change", (e) => { if (e.target.name === "method") $(".utr-field").hidden = e.target.value !== "upi"; });
    $("#billForm").elements.namedItem("phone").addEventListener("input", (e) => lookupPoints(e.target.value));
  }
  // Loyalty: when a known customer's number is typed, show their points and let staff spend them.
  let lookupTimer;
  function lookupPoints(raw) {
    clearTimeout(lookupTimer);
    const box = $("#loyalBox");
    const phone = String(raw).replace(/\D/g, "").slice(-10);
    const loyalty = SA.state.settings && SA.state.settings.loyalty;
    if (!loyalty || !loyalty.enabled || !/^[6-9]\d{9}$/.test(phone)) { box.hidden = true; return; }
    lookupTimer = setTimeout(async () => {
      try {
        const { customer } = await api(`/customers/${phone}/points`);
        if (!customer) { box.hidden = false; box.innerHTML = `<span class="opt">New customer: they'll start earning points with this bill.</span>`; return; }
        box.hidden = false;
        box.innerHTML = `<b>${esc(customer.name || "Customer")}</b> has <b>${customer.points}</b> points (worth ${esc(money(customer.points * loyalty.pointValue))}).
          ${customer.points ? `<label>Use points <span class="opt">(0–${customer.points})</span><input name="points" type="number" min="0" max="${customer.points}" value="0" inputmode="numeric"></label>` : ""}`;
      } catch (e) { box.hidden = true; }
    }, 350);
  }

  function show() { renderPick(); renderBill(); }
  return { start, show };
})();
