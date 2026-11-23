/* Dashboard start-up: login, what each role can see, tabs, and the "finish setting up" checklist. */
(function () {
  "use strict";
  const { api, toast, esc } = SA;
  const $ = (s) => document.querySelector(s);
  let started = false;

  SA.can = (perm) => {
    const p = SA.state.perms || [];
    return p.includes("*") || (perm !== "owner" && p.includes(perm));
  };

  function showLogin() {
    $("#app").hidden = true; $("#login").hidden = false;
    SA.orders.stop(); SA.tablesTab.stop();
    setTimeout(() => $("#who").focus(), 50);
  }

  async function showApp(me) {
    SA.state.user = me.user;
    SA.state.perms = me.perms;
    if (me.user.role === "kitchen") { location.href = "kitchen.html"; return; }
    $("#login").hidden = true; $("#app").hidden = false;
    $("#whoAmI").textContent = `${me.user.name} · ${me.user.roleName}`;
    document.querySelectorAll("[data-perm]").forEach((el) => { el.hidden = !SA.can(el.dataset.perm); });
    if (started) return;
    started = true;
    SA.counter.start(); SA.prices.start(); SA.settings.start(); SA.customers.start(); SA.reports.start();
    try {
      await Promise.all([SA.prices.loadCatalog(), SA.settings.load()]);
    } catch (e) { toast(e.message, true); }
    if (SA.can("orders")) { SA.orders.start(); setupNotice(); }
    if (SA.can("tables")) SA.tablesTab.start();
    tab(SA.can("orders") ? "orders" : SA.can("counter") ? "counter" : "menu");
    if ("Notification" in window && Notification.permission === "default") {
      document.addEventListener("click", () => Notification.requestPermission(), { once: true });
    }
  }

  // Tells the owner what's still missing before customers can order.
  function setupNotice() {
    const s = SA.state.settings;
    const n = $("#setupNotice");
    if (!s || !SA.state.catalog || !SA.can("owner")) { n.hidden = true; return; }
    const priced = SA.state.catalog.items.filter((i) => i.price !== null).length;
    const todo = [];
    if (!s.upiId) todo.push(["settings", "Add your UPI ID"]);
    if (!priced) todo.push(["menu", "Set prices for what you sell"]);
    if (!s.acceptingOrders) todo.push(["settings", 'Switch on "Taking online orders"']);
    n.hidden = !todo.length;
    n.innerHTML = todo.length ? `<b>Before customers can order online:</b><ol>${todo.map(([t, label]) => `<li><button class="btn ghost small" type="button" data-go="${t}">${esc(label)}</button></li>`).join("")}</ol>` : "";
  }

  function tab(name) {
    document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === name ? "page" : "false"));
    document.querySelectorAll(".tab").forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
    if (name === "orders") { $("#newDot").hidden = true; document.title = "SEREN Orders"; SA.orders.load(); setupNotice(); }
    if (name === "tables") { $("#callDot").hidden = true; SA.tablesTab.load(); }
    if (name === "counter") SA.counter.show();
    if (name === "cash") SA.money.show();
    if (name === "menu" && SA.state.catalog) SA.prices.render();
    if (name === "stock") SA.inventory.show();
    if (name === "customers") SA.customers.show();
    if (name === "reports") SA.reports.show();
    if (name === "settings" && SA.state.settings) SA.settings.render();
    window.scrollTo({ top: 0 });
  }
  SA.tab = tab;

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true; $("#loginErr").textContent = "";
    try {
      await api("/login", { name: $("#who").value.trim(), password: $("#pw").value });
      $("#pw").value = "";
      showApp(await api("/me"));
    } catch (ex) { $("#loginErr").textContent = ex.message; }
    finally { btn.disabled = false; }
  });
  $("#logout").addEventListener("click", async () => { try { await api("/logout", {}); } catch (e) { /* already out */ } location.reload(); });
  document.querySelector(".tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) tab(b.dataset.tab); });
  $("#setupNotice").addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) tab(b.dataset.go); });
  document.addEventListener("sa:logout", showLogin);
  document.addEventListener("sa:settings", setupNotice);
  window.addEventListener("hashchange", () => { if (/^#SRN-/.test(location.hash)) tab("orders"); });

  api("/me").then(showApp).catch(showLogin);
})();
