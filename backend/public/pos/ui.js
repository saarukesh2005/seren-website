/* The counter screen: product tiles, the bill, held bills, printer settings, connection status,
   and the customer-facing screen (sent over a BroadcastChannel to display.html). */
window.POSUI = (function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const { money } = SerenReceipt;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const channel = "BroadcastChannel" in window ? new BroadcastChannel("seren-pos") : null;
  let cart = {};          // id -> qty
  let cat = "fav";
  let query = "";
  let quoteTotal = null;  // exact total from the order system (after coupon / points), when known
  let toastTimer;

  const items = () => POS.sellable();
  const byId = () => new Map(items().map((i) => [i.id, i]));
  const lines = () => { const m = byId(); return Object.entries(cart).filter(([id]) => m.has(id)).map(([id, qty]) => ({ ...m.get(id), qty })); };
  const estimate = () => lines().reduce((n, l) => n + l.price * l.qty, 0);
  const extras = () => ({
    phone: $("#phone").value.trim(), name: $("#cname").value.trim(), table: $("#table").value.trim(),
    coupon: $("#coupon").value.trim(), points: Number(($("#usePoints") || {}).value || 0) || 0,
  });

  function toast(msg, bad) {
    const t = $("#toast");
    t.textContent = msg; t.classList.toggle("bad", Boolean(bad)); t.classList.add("on");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), bad ? 4500 : 2200);
  }

  /* ---------- product tiles ---------- */
  function photo(i) {
    if (i.photo) return `/img/${encodeURIComponent(i.photo)}`;
    const site = POS.settings && POS.settings.siteUrl;
    return i.img && site ? `${site.replace(/\/?$/, "/")}img/${encodeURIComponent(i.img)}.webp` : "";
  }

  function renderCats() {
    const cats = (POS.catalog && POS.catalog.categories) || {};
    $("#cats").innerHTML = [["fav", "★ Top"], ["all", "All"], ...Object.entries(cats)]
      .map(([k, l]) => `<button type="button" data-cat="${esc(k)}" aria-pressed="${k === cat}">${esc(l)}</button>`).join("");
  }

  function visible() {
    const f = POS.favs();
    let list = items();
    if (query) list = list.filter((i) => i.name.toLowerCase().includes(query));
    else if (cat === "fav") list = [...list].sort((a, b) => (f[b.id] || 0) - (f[a.id] || 0)).slice(0, 18);
    else if (cat !== "all") list = list.filter((i) => i.category === cat);
    return list;
  }

  function renderGrid() {
    const list = visible();
    $("#grid").innerHTML = list.length
      ? list.map((i) => {
          const src = photo(i);
          const left = i.leftToday !== null && i.leftToday !== undefined ? `<i class="left ${i.leftToday <= 3 ? "low" : ""}">${i.leftToday} left</i>` : "";
          return `<button class="tile" type="button" data-add="${esc(i.id)}" ${i.leftToday === 0 ? "disabled" : ""}>
            ${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : ""}
            <span class="nm">${esc(i.name)}</span><span class="pr">${esc(money(i.price))}</span>${left}
            ${cart[i.id] ? `<b class="q">${cart[i.id]}</b>` : ""}</button>`;
        }).join("")
      : `<p class="empty">${items().length ? "Nothing matches" : "No priced products yet. Set prices in the dashboard (Menu)."}</p>`;
  }

  /* ---------- the bill ---------- */
  function setQty(id, qty) {
    const { [id]: _old, ...rest } = cart;
    cart = qty > 0 ? { ...rest, [id]: Math.min(qty, 50) } : rest;
    quoteTotal = null;
    render();
  }
  const add = (id) => setQty(id, (cart[id] || 0) + 1);

  function renderBill() {
    const ls = lines();
    $("#lines").innerHTML = ls.length
      ? ls.map((l) => `<li><span class="n">${esc(l.name)}<small>${esc(money(l.price))}${l.unit ? ` · ${esc(l.unit)}` : ""}</small></span>
          <span class="qty"><button type="button" data-q="${esc(l.id)}" data-d="-1" aria-label="One fewer">−</button><b>${l.qty}</b><button type="button" data-q="${esc(l.id)}" data-d="1" aria-label="One more">+</button></span>
          <b class="amt">${esc(money(l.price * l.qty))}</b></li>`).join("")
      : `<li class="empty">Tap products to start a bill</li>`;
    const count = ls.reduce((n, l) => n + l.qty, 0);
    $("#itemCount").textContent = `${count} item${count === 1 ? "" : "s"}`;
    const ex = extras();
    const needsQuote = ex.coupon || ex.points;
    $("#total").textContent = money(quoteTotal ?? estimate());
    $("#estNote").textContent = needsQuote && quoteTotal === null ? "discount worked out at payment" : "";
    document.querySelectorAll("[data-pay]").forEach((b) => { b.disabled = !ls.length; });
    $("#holdBtn").disabled = !ls.length;
    broadcast({ type: "cart", lines: ls.map((l) => ({ name: l.name, qty: l.qty, amount: l.price * l.qty })), total: quoteTotal ?? estimate() });
  }

  function render() { renderGrid(); renderBill(); }

  function clear() {
    cart = {}; quoteTotal = null;
    ["#phone", "#cname", "#table", "#coupon"].forEach((s) => { $(s).value = ""; });
    $("#loyal").hidden = true; $("#loyal").innerHTML = "";
    $("#extras").open = false;
    render();
  }

  /* ---------- loyalty lookup ---------- */
  let lookupTimer;
  function lookup() {
    clearTimeout(lookupTimer);
    const phone = $("#phone").value.replace(/\D/g, "").slice(-10);
    const box = $("#loyal");
    const loyalty = POS.settings && POS.settings.loyalty;
    if (!/^[6-9]\d{9}$/.test(phone) || !POS.online) { box.hidden = true; return; }
    lookupTimer = setTimeout(async () => {
      try {
        const { customer } = await POS.api(`/customers/${phone}/points`);
        if (!customer) { box.hidden = false; box.textContent = "New customer"; return; }
        if (!$("#cname").value) $("#cname").value = customer.name || "";
        box.hidden = false;
        box.innerHTML = `<b>${esc(customer.name || "Customer")}</b> · ${customer.points} points${loyalty && loyalty.enabled && customer.points
          ? ` (worth ${esc(money(customer.points * loyalty.pointValue))}) <label>Use <input id="usePoints" type="number" min="0" max="${customer.points}" value="0"></label>` : ""}`;
      } catch (e) { box.hidden = true; }
    }, 350);
  }

  /* ---------- customer screen ---------- */
  function broadcast(msg) { if (channel) channel.postMessage(msg); }
  function openDisplay() {
    const w = window.open("display", "seren-display", "popup,width=1024,height=768");
    if (!w) toast("Allow pop-ups to open the customer screen", true);
    setTimeout(renderBill, 800);
  }

  /* ---------- held bills ---------- */
  function hold() {
    if (!lines().length) return;
    POS.hold({ cart, extras: extras() });
    clear();
    toast("Bill held. Press F6 to bring it back.");
  }
  function showHeld() {
    const d = $("#heldDlg");
    const list = POS.held();
    d.innerHTML = `<div class="dlg-in"><div class="dlg-head"><h2 id="heldTitle">Held bills</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>
      ${list.length ? `<ul class="held">${list.map((h) => {
        const n = Object.values(h.cart.cart).reduce((a, b) => a + b, 0);
        const who = h.cart.extras.name || (h.cart.extras.table ? `Table ${h.cart.extras.table}` : "Walk-in");
        return `<li><button type="button" data-unhold="${esc(h.id)}"><b>${esc(who)}</b><span>${n} item${n === 1 ? "" : "s"} · held ${esc(new Date(h.at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }))}</span></button></li>`;
      }).join("")}</ul>` : `<p class="empty">No held bills</p>`}</div>`;
    d.showModal();
  }
  function unhold(id) {
    if (lines().length) POS.hold({ cart, extras: extras() }); // keep what's on screen
    const h = POS.unhold(id);
    if (!h) return;
    cart = h.cart; quoteTotal = null;
    $("#phone").value = h.extras.phone || ""; $("#cname").value = h.extras.name || ""; $("#table").value = h.extras.table || ""; $("#coupon").value = h.extras.coupon || "";
    $("#extras").open = Boolean(h.extras.phone || h.extras.name || h.extras.table || h.extras.coupon);
    $("#heldDlg").close();
    render();
  }

  /* ---------- printer settings ---------- */
  async function showPrinter() {
    const d = $("#printerDlg");
    const p = POS.prefs();
    const list = await POSPrint.printers();
    d.innerHTML = `<form class="dlg-in" id="printerForm"><div class="dlg-head"><h2 id="printerTitle">Receipt printer</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>
      ${POSPrint.native
        ? `<label>Printer<select name="printer"><option value="">Windows default printer</option>${list.map((x) => `<option value="${esc(x.name)}" ${x.name === p.printer ? "selected" : ""}>${esc(x.displayName || x.name)}${x.isDefault ? " (default)" : ""}</option>`).join("")}</select></label>
           <p class="hint">Prints silently, no print window. To open the cash drawer automatically, switch on "open cash drawer" in your printer's Windows settings (most receipt printers have it).</p>`
        : `<p class="hint">You're using the counter in a browser, so receipts open the browser's print window. The SEREN Counter Windows app prints silently.</p>`}
      <fieldset class="seg"><legend>Paper width</legend>
        ${[80, 58].map((w) => `<label><input type="radio" name="paper" value="${w}" ${p.paper === w ? "checked" : ""}><span>${w} mm</span></label>`).join("")}</fieldset>
      <label class="check"><input type="checkbox" name="autoPrint" ${p.autoPrint ? "checked" : ""}> Print a receipt after every bill</label>
      <div class="btns"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" id="testPrint">Print a test receipt</button></div>
    </form>`;
    const form = d.querySelector("#printerForm");
    const save = () => POS.setPrefs({ printer: form.elements.namedItem("printer") ? form.elements.namedItem("printer").value : "", paper: Number(form.elements.namedItem("paper").value), autoPrint: form.elements.namedItem("autoPrint").checked });
    form.addEventListener("submit", (e) => { e.preventDefault(); save(); d.close(); toast("Printer saved"); });
    d.querySelector("#testPrint").addEventListener("click", async () => {
      save();
      const m = SerenReceipt.receiptModel({ offline: true, ref: "TEST-PRINT", at: new Date().toISOString(), method: "test", total: 12300, lines: [{ name: "Test bombolone", qty: 1, amount: 12300 }] }, POS.settings || {}, {});
      try { await POSPrint.printReceipt({ ...m, title: "TEST RECEIPT", note: "If you can read this, the printer works." }); toast("Test sent to the printer"); }
      catch (e) { toast(e.message || "Printing failed", true); }
    });
    d.showModal();
  }

  /* ---------- connection status and bills waiting to send ---------- */
  function renderStatus() {
    const q = POS.queue();
    const problems = q.filter((b) => b.problem).length;
    const s = $("#status");
    s.className = `status ${POS.online ? "on" : "off"} ${problems ? "warn" : ""}`;
    s.textContent = POS.online ? (q.length ? `Online · sending ${q.length}` : "Online") : `Offline · ${q.length} bill${q.length === 1 ? "" : "s"} waiting`;
    if (problems) s.textContent += ` · ${problems} need a look`;
  }
  function showQueue() {
    const d = $("#queueDlg");
    const q = POS.queue();
    d.innerHTML = `<div class="dlg-in"><div class="dlg-head"><h2 id="queueTitle">Bills waiting to send</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>
      <p class="hint">${POS.online ? "Online." : "Offline."} Bills taken without internet are sent automatically when it's back; each gets its bill number then.</p>
      ${q.length ? `<ul class="held">${q.map((b) => `<li class="${b.problem ? "problem" : ""}"><div><b>${esc(b.clientRef)}</b><span>${esc(money(b.estimate || 0))} · ${esc(b.method.toUpperCase())} · ${esc(new Date(b.offlineAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }))}</span>
        ${b.problem ? `<span class="err">${esc(b.problem)}</span><div class="btns"><button class="btn ghost small" type="button" data-retry>Try again</button><button class="btn ghost small" type="button" data-drop="${esc(b.clientRef)}">Remove (I'll bill it again)</button></div>` : ""}</div></li>`).join("")}</ul>`
      : `<p class="empty">Nothing waiting</p>`}</div>`;
    d.showModal();
  }

  function start() {
    renderCats(); render(); renderStatus();
    $("#cats").addEventListener("click", (e) => { const b = e.target.closest("[data-cat]"); if (!b) return; cat = b.dataset.cat; query = ""; $("#search").value = ""; renderCats(); renderGrid(); });
    $("#search").addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); renderGrid(); });
    $("#search").addEventListener("keydown", (e) => { if (e.key === "Enter") { const first = visible()[0]; if (first) { add(first.id); e.target.select(); } } });
    $("#grid").addEventListener("click", (e) => { const t = e.target.closest("[data-add]"); if (t) add(t.dataset.add); });
    $("#grid").addEventListener("error", (e) => { if (e.target.tagName === "IMG") e.target.remove(); }, true); // offline: no photo, just the name
    $("#lines").addEventListener("click", (e) => { const b = e.target.closest("[data-q]"); if (b) setQty(b.dataset.q, (cart[b.dataset.q] || 0) + Number(b.dataset.d)); });
    $("#clearBtn").addEventListener("click", () => { if (!lines().length || window.confirm("Clear this bill?")) clear(); });
    $("#holdBtn").addEventListener("click", hold);
    $("#heldBtn").addEventListener("click", showHeld);
    $("#displayBtn").addEventListener("click", openDisplay);
    $("#printerBtn").addEventListener("click", showPrinter);
    $("#status").addEventListener("click", showQueue);
    $("#phone").addEventListener("input", lookup);
    ["#coupon", "#phone"].forEach((s) => $(s).addEventListener("input", () => { quoteTotal = null; renderBill(); }));
    $("#extras").addEventListener("input", (e) => { if (e.target.id === "usePoints") { quoteTotal = null; renderBill(); } });
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) e.target.closest("dialog").close();
      const u = e.target.closest("[data-unhold]"); if (u) unhold(u.dataset.unhold);
      const dr = e.target.closest("[data-drop]");
      if (dr && window.confirm("Remove this bill from the queue? Only do this if you'll bill it again.")) { POS.dropQueued(dr.dataset.drop); showQueue(); }
      if (e.target.closest("[data-retry]")) { POS.sync().then(showQueue); }
    });
    POS.on("online", renderStatus);
    POS.on("queue", renderStatus);
    POS.on("held", (h) => { $("#heldCount").textContent = h.length; });
    POS.on("synced", ({ order }) => toast(`Offline bill sent · ${order.invoice_no}`));
    $("#heldCount").textContent = POS.held().length;
  }

  return { start, render, renderCats, clear, hold, showHeld, toast, lines, extras, estimate, broadcast, setQuote: (t) => { quoteTotal = t; renderBill(); }, focusSearch: () => $("#search").focus() };
})();
