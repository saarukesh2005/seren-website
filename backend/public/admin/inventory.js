/* Stock tab: raw materials in stock, purchases, wastage and counts, recipes per product, food cost, history. */
SA.inventory = (function () {
  "use strict";
  const { esc, money, api, toast, ago, toPaise } = SA;
  const $ = (s) => document.querySelector(s);
  const VIEWS = [["stock", "Ingredients"], ["buy", "Add purchase"], ["waste", "Wastage & count"], ["recipes", "Recipes"], ["cost", "Food cost"], ["history", "History"]];
  const UNIT_WORD = { g: "kg", ml: "litre", pcs: "piece" };
  const REASONS = { sale: "Sold", purchase: "Bought", wastage: "Wasted", count: "Stock count", refund: "Refund" };
  let view = "stock";
  let ings = [];
  let vendors = [];
  let editing = null;
  let built = false;
  let gen = 0; // a newer screen request makes a slower, older one stop before it draws

  /* ---------- small helpers ---------- */
  const num = (v) => { const s = String(v ?? "").trim(); return s === "" ? undefined : Number(s); };
  const fmt = (n) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 });
  const qty = (i) => `${fmt(i.onHand)} ${i.unit}`;
  // the owner thinks "₹ per kg"; the server keeps paise per 1000 g (ml, pieces)
  const costToInput = (rupees, unit) => (rupees === undefined ? undefined : Math.round(rupees * 100 * (unit === "pcs" ? 1000 : 1)));
  const costShown = (i) => (i.cost ? `${money(i.unit === "pcs" ? Math.round(i.cost / 1000) : i.cost)} per ${UNIT_WORD[i.unit]}` : "not set");
  const costField = (i) => String((i.unit === "pcs" ? i.cost / 100000 : i.cost / 100) || "");
  const byId = (id) => ings.find((i) => i.id === Number(id));
  const err = (id, msg) => { const el = $(`#${id}`); if (el) el.textContent = msg || ""; };

  const ingOptions = (selected) => `<option value="">Choose…</option>${ings.filter((i) => i.active || i.id === selected)
    .map((i) => `<option value="${i.id}" ${i.id === selected ? "selected" : ""}>${esc(i.name)}${i.active ? "" : " (hidden)"}</option>`).join("")}`;

  async function loadIngredients() {
    const data = await api("/stock");
    ings = data.ingredients;
    return data;
  }

  /* ---------- shell ---------- */
  function build() {
    if (built) return;
    built = true;
    $("#tab-stock").innerHTML = `<div class="chips subtabs" id="invTabs" role="group" aria-label="Stock section"></div><div id="invBody" class="inv-body"></div>`;
    $("#invTabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-view]");
      if (b) { view = b.dataset.view; editing = null; render(); }
    });
    const body = $("#invBody");
    body.addEventListener("click", onClick);
    body.addEventListener("submit", onSubmit);
    body.addEventListener("change", onChange);
    body.addEventListener("input", onInput);
  }

  async function show() {
    build();
    try { await loadIngredients(); } catch (e) { toast(e.message, true); }
    render();
  }

  async function render() {
    $("#invTabs").innerHTML = VIEWS.map(([v, label]) => `<button type="button" data-view="${v}" aria-pressed="${v === view}">${esc(label)}</button>`).join("");
    const my = ++gen;
    const live = () => my === gen;
    const views = { stock: viewStock, buy: viewBuy, waste: viewWaste, recipes: viewRecipes, cost: viewCost, history: () => viewHistory("", live) };
    try { await views[view](live); } catch (e) { toast(e.message, true); }
  }

  /* ---------- ingredients ---------- */
  function viewStock() {
    const low = ings.filter((i) => i.low);
    const edit = editing ? byId(editing) : null;
    $("#invBody").innerHTML = `
      ${low.length ? `<div class="notice inv-alert"><b>Running low:</b> ${low.map((i) => `${esc(i.name)} (${esc(qty(i))})`).join(", ")}</div>` : ""}
      ${edit ? `<form class="box inv-form" id="editIngForm"><h3>Change ${esc(edit.name)}</h3>
        <div class="formgrid">
          <label>Name<input name="name" maxlength="40" required value="${esc(edit.name)}"></label>
          <label>Warn me when it falls to <span class="opt">(${esc(edit.unit)})</span><input name="lowAt" inputmode="decimal" value="${edit.lowAt}"></label>
          <label>Cost ₹ per ${UNIT_WORD[edit.unit]}<input name="cost" inputmode="decimal" value="${esc(costField(edit))}"></label>
        </div>
        <label class="check"><input type="checkbox" name="active" ${edit.active ? "checked" : ""}> Still in use (untick to hide it from lists)</label>
        <p class="err" id="editIngErr" role="alert"></p>
        <div class="btns"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-act="cancelEdit">Cancel</button></div></form>` : ""}
      <form class="box inv-form" id="addIngForm"><h3>Add an ingredient</h3>
        <div class="formgrid">
          <label>Name<input name="name" maxlength="40" required placeholder="Maida"></label>
          <label>Counted in<select name="unit"><option value="g">grams (g)</option><option value="ml">millilitres (ml)</option><option value="pcs">pieces (pcs)</option></select></label>
          <label>In stock now <span class="opt">(optional)</span><input name="onHand" inputmode="decimal" placeholder="0"></label>
          <label>Warn me when it falls to <span class="opt">(optional)</span><input name="lowAt" inputmode="decimal" placeholder="0"></label>
          <label>Cost ₹ per kg / litre / piece <span class="opt">(optional)</span><input name="cost" inputmode="decimal" placeholder="e.g. 45"></label>
        </div>
        <p class="err" id="addIngErr" role="alert"></p>
        <button class="btn plum" type="submit">Add ingredient</button></form>
      <div class="table-wrap"><table class="grid inv-table"><thead><tr><th>Ingredient</th><th class="r">In stock</th><th class="r">Warn at</th><th>Cost</th><th></th></tr></thead><tbody>
        ${ings.length ? ings.map((i) => `<tr class="${i.active ? "" : "inv-off"}">
          <td><b>${esc(i.name)}</b>${i.active ? "" : ` <span class="opt">(hidden)</span>`}</td>
          <td class="r"><span class="${i.onHand < 0 ? "inv-neg" : i.low ? "inv-lowtext" : ""}">${esc(qty(i))}</span>${i.onHand < 0 ? ` <span class="badge inv-b-neg">Below zero</span>` : i.low ? ` <span class="badge inv-b-low">Low</span>` : ""}</td>
          <td class="r">${esc(fmt(i.lowAt))} ${esc(i.unit)}</td><td>${esc(costShown(i))}</td>
          <td class="r"><button class="btn ghost small" type="button" data-act="edit" data-id="${i.id}">Change</button></td></tr>`).join("")
          : `<tr><td colspan="5" class="empty">Add your first ingredient above</td></tr>`}</tbody></table></div>`;
  }

  async function saveNewIngredient(f) {
    const v = (n) => f.elements.namedItem(n).value;
    const unit = v("unit");
    const body = { name: v("name").trim(), unit };
    for (const k of ["onHand", "lowAt"]) { const n = num(v(k)); if (n !== undefined) body[k] = n; }
    const c = costToInput(num(v("cost")), unit);
    if (c !== undefined) body.cost = c;
    await api("/stock/ingredients", body);
    toast("Ingredient added");
  }

  async function saveEditedIngredient(f) {
    const v = (n) => f.elements.namedItem(n).value;
    const cur = byId(editing);
    const body = { name: v("name").trim(), active: f.elements.namedItem("active").checked };
    const low = num(v("lowAt"));
    body.lowAt = low === undefined ? 0 : low;
    const c = costToInput(num(v("cost")), cur.unit);
    body.cost = c === undefined ? 0 : c;
    await api(`/stock/ingredients/${cur.id}`, body);
    editing = null;
    toast("Saved");
  }

  /* ---------- purchases ---------- */
  const buyRow = () => `<div class="inv-row" data-row>
    <label>Item<select name="ing">${ingOptions()}</select></label>
    <label>Quantity <span class="opt inv-unit">(unit)</span><input name="qty" inputmode="decimal" placeholder="0"></label>
    <label>Amount paid ₹<input name="amt" inputmode="decimal" placeholder="0"></label>
    <button class="btn ghost small inv-del" type="button" data-act="delRow" aria-label="Remove this item">✕</button></div>`;

  async function viewBuy(live) {
    if (!vendors.length) { try { vendors = (await api("/stock/vendors")).vendors; } catch (e) { /* the form still works without suggestions */ } }
    if (!live()) return;
    $("#invBody").innerHTML = ings.length ? `
      <form class="box inv-form" id="buyForm"><h3>Add a purchase</h3>
        <p class="meta lead">Type what you bought and what you paid. Stock goes up and the cost of each ingredient updates by itself.</p>
        <div class="formgrid">
          <label>Bought from <span class="opt">(optional)</span><input name="vendor" maxlength="40" list="invVendors" autocomplete="off" placeholder="Shop or supplier name"></label>
          <label>Bill number <span class="opt">(optional)</span><input name="billNo" maxlength="30"></label>
          <label>Date<input type="date" name="day" value="${esc(SA.todayIST())}" max="${esc(SA.todayIST())}" required></label>
        </div>
        <datalist id="invVendors">${vendors.map((v) => `<option value="${esc(v.name)}"></option>`).join("")}</datalist>
        <div id="buyRows" class="inv-rows">${buyRow()}${buyRow()}</div>
        <button class="btn ghost small" type="button" data-act="addRow">+ Add another item</button>
        <div class="inv-total"><span>Total</span><b id="buyTotal">₹0</b></div>
        <p class="err" id="buyErr" role="alert"></p>
        <button class="btn primary" type="submit">Save purchase</button></form>
      <h2 class="sec">Recent purchases</h2><div id="buyList"></div>` : `<p class="empty">Add ingredients first (Ingredients tab)</p>`;
    if (ings.length) loadPurchases();
  }

  async function loadPurchases() {
    try {
      const { purchases } = await api("/stock/purchases?limit=20");
      const el = $("#buyList");
      if (!el) return;
      el.innerHTML = `<div class="table-wrap"><table class="grid inv-table"><thead><tr><th>Date</th><th>From</th><th>What</th><th class="r">Total</th></tr></thead><tbody>
        ${purchases.length ? purchases.map((p) => `<tr><td>${esc(SA.day(p.day))}${p.billNo ? `<br><span class="opt">Bill ${esc(p.billNo)}</span>` : ""}</td><td>${esc(p.vendor || "—")}</td>
          <td>${p.lines.map((l) => `${esc(l.name)} ${esc(fmt(l.qty))}`).join(", ")}</td><td class="r">${esc(money(p.total))}</td></tr>`).join("")
          : `<tr><td colspan="4" class="empty">No purchases yet</td></tr>`}</tbody></table></div>`;
    } catch (e) { toast(e.message, true); }
  }

  function updateBuyTotal() {
    const total = [...document.querySelectorAll("#buyRows [name=amt]")].reduce((n, el) => { const p = toPaise(el.value); return n + (Number.isFinite(p) ? p : 0); }, 0);
    const el = $("#buyTotal");
    if (el) el.textContent = money(total);
  }

  async function savePurchase(f) {
    const lines = [];
    for (const row of f.querySelectorAll("[data-row]")) {
      const ing = row.querySelector("[name=ing]").value;
      const q = row.querySelector("[name=qty]").value.trim();
      const a = row.querySelector("[name=amt]").value.trim();
      if (!ing && !q && !a) continue;
      const amount = toPaise(a);
      if (!ing || q === "" || amount === null || Number.isNaN(amount)) throw new Error("Each row needs an item, a quantity and the amount paid");
      lines.push({ ingredientId: Number(ing), qty: Number(q), amount });
    }
    if (!lines.length) throw new Error("Add at least one item");
    const v = (n) => f.elements.namedItem(n).value.trim();
    await api("/stock/purchases", { vendorName: v("vendor"), billNo: v("billNo"), day: v("day"), lines });
    vendors = [];
    toast("Purchase saved");
  }

  /* ---------- wastage and counts ---------- */
  function viewWaste() {
    $("#invBody").innerHTML = ings.length ? `<div class="inv-two">
      <form class="box inv-form" id="wasteForm"><h3>Record wastage</h3>
        <p class="meta">Spoiled, dropped, burnt or thrown away.</p>
        <label>Ingredient<select name="ing" required>${ingOptions()}</select></label>
        <label>How much <span class="opt inv-unit">(unit)</span><input name="qty" inputmode="decimal" required></label>
        <label>Why <span class="opt">(optional)</span><input name="reason" maxlength="80" placeholder="Expired, spilled…"></label>
        <p class="err" id="wasteErr" role="alert"></p>
        <button class="btn plum" type="submit">Record wastage</button></form>
      <form class="box inv-form" id="countForm"><h3>Stock count</h3>
        <p class="meta">Weighed or counted the shelf? Type what is really there and the stock is corrected.</p>
        <label>Ingredient<select name="ing" required>${ingOptions()}</select></label>
        <p class="meta inv-now" id="countNow"></p>
        <label>What you counted <span class="opt inv-unit">(unit)</span><input name="counted" inputmode="decimal" required></label>
        <p class="err" id="countErr" role="alert"></p>
        <button class="btn plum" type="submit">Save count</button></form></div>` : `<p class="empty">Add ingredients first (Ingredients tab)</p>`;
  }

  /* ---------- recipes ---------- */
  const recipeRow = (l) => `<div class="inv-row inv-rrow" data-row>
    <label>Ingredient<select name="ing">${ingOptions(l ? l.ingredientId : undefined)}</select></label>
    <label>Used per item <span class="opt inv-unit">(${l ? esc(l.unit) : "unit"})</span><input name="qty" inputmode="decimal" value="${l ? esc(String(l.qty)) : ""}"></label>
    <button class="btn ghost small inv-del" type="button" data-act="delRow" aria-label="Remove this ingredient">✕</button></div>`;

  async function viewRecipes(live) {
    if (!SA.state.catalog) { try { await SA.prices.loadCatalog(); } catch (e) { /* shown below */ } }
    const items = [...((SA.state.catalog && SA.state.catalog.items) || [])].sort((a, b) => a.name.localeCompare(b.name));
    let counts = {};
    try { counts = (await api("/stock")).recipes || {}; } catch (e) { /* only the ticks are missing */ }
    if (!live()) return;
    $("#invBody").innerHTML = ings.length ? `
      <form class="box inv-form" id="recipeForm"><h3>What goes into each item</h3>
        <p class="meta lead">Pick a product and list what one piece uses. When it is sold, these amounts leave your stock. A tick means a recipe is saved.</p>
        <label>Product<select name="product" id="recipeProduct"><option value="">Choose…</option>${items.map((c) => `<option value="${esc(c.id)}">${counts[c.id] ? "✓ " : ""}${esc(c.name)}</option>`).join("")}</select></label>
        <div id="recipeRows" class="inv-rows"></div>
        <div class="btns"><button class="btn ghost small" type="button" data-act="addRecipeRow" id="addRecipeRow" hidden>+ Add ingredient</button></div>
        <p class="err" id="recipeErr" role="alert"></p>
        <button class="btn primary" type="submit" id="saveRecipe" hidden>Save recipe</button></form>` : `<p class="empty">Add ingredients first (Ingredients tab)</p>`;
  }

  async function loadRecipe(productId) {
    const rows = $("#recipeRows");
    $("#addRecipeRow").hidden = !productId; $("#saveRecipe").hidden = !productId;
    if (!productId) { rows.innerHTML = ""; return; }
    try {
      const { lines } = await api(`/stock/recipes/${encodeURIComponent(productId)}`);
      rows.innerHTML = lines.length ? lines.map(recipeRow).join("") : recipeRow();
    } catch (e) { toast(e.message, true); }
  }

  async function saveRecipe(f) {
    const lines = [];
    for (const row of f.querySelectorAll("[data-row]")) {
      const ing = row.querySelector("[name=ing]").value;
      const q = row.querySelector("[name=qty]").value.trim();
      if (!ing && !q) continue;
      if (!ing || q === "") throw new Error("Each row needs an ingredient and an amount");
      lines.push({ ingredientId: Number(ing), qty: Number(q) });
    }
    await api(`/stock/recipes/${encodeURIComponent(f.elements.namedItem("product").value)}`, { lines });
    toast(lines.length ? "Recipe saved" : "Recipe removed");
  }

  /* ---------- food cost ---------- */
  async function viewCost(live) {
    const { items } = await api("/stock/food-cost");
    if (!live()) return;
    const tone = (p) => (p === null ? "" : p > 40 ? "inv-neg" : p > 30 ? "inv-lowtext" : "inv-good");
    $("#invBody").innerHTML = `<p class="lead">What the ingredients of one piece cost, against today's selling price. Under 30% is comfortable; over 40% is worth a look.</p>
      <div class="table-wrap"><table class="grid inv-table"><thead><tr><th>Product</th><th class="r">Selling price</th><th class="r">Ingredients cost</th><th class="r">Food cost</th></tr></thead><tbody>
      ${items.length ? items.map((i) => `<tr><td><b>${esc(i.name)}</b>${i.unknownCosts ? `<br><span class="opt">${i.unknownCosts} ingredient${i.unknownCosts === 1 ? " has" : "s have"} no cost set yet</span>` : ""}</td>
        <td class="r">${i.price === null ? "not priced" : esc(money(i.price))}</td><td class="r">${esc(money(i.cost))}</td>
        <td class="r"><b class="${tone(i.costPercent)}">${i.costPercent === null ? "—" : `${i.costPercent}%`}</b></td></tr>`).join("")
        : `<tr><td colspan="4" class="empty">Save a recipe to see its food cost</td></tr>`}</tbody></table></div>`;
  }

  /* ---------- history ---------- */
  async function viewHistory(filter = "", live = () => true) {
    $("#invBody").innerHTML = `<label class="inv-filter">Show<select id="histFilter"><option value="">All ingredients</option>${ings.map((i) => `<option value="${i.id}" ${String(i.id) === String(filter) ? "selected" : ""}>${esc(i.name)}</option>`).join("")}</select></label><div id="histList"></div>`;
    const { moves } = await api(`/stock/moves?limit=100${filter ? `&ingredient=${encodeURIComponent(filter)}` : ""}`);
    if (!live()) return;
    $("#histList").innerHTML = `<div class="table-wrap"><table class="grid inv-table"><thead><tr><th>When</th><th>Ingredient</th><th class="r">Change</th><th>Why</th><th>By</th></tr></thead><tbody>
      ${moves.length ? moves.map((m) => `<tr><td>${esc(ago(m.at))}</td><td>${esc(m.name)}</td>
        <td class="r"><b class="${m.delta < 0 ? "inv-neg" : "inv-good"}">${m.delta > 0 ? "+" : ""}${esc(fmt(m.delta))} ${esc(m.unit)}</b></td>
        <td>${esc(REASONS[m.reason] || m.reason)}${m.ref ? `<br><span class="opt">${esc(m.ref)}</span>` : ""}</td><td>${esc(m.actor || "")}</td></tr>`).join("")
        : `<tr><td colspan="5" class="empty">Nothing yet</td></tr>`}</tbody></table></div>`;
  }

  /* ---------- events ---------- */
  function onClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "edit") { editing = Number(b.dataset.id); render(); window.scrollTo({ top: 0 }); }
    else if (act === "cancelEdit") { editing = null; render(); }
    else if (act === "addRow") { $("#buyRows").insertAdjacentHTML("beforeend", buyRow()); }
    else if (act === "addRecipeRow") { $("#recipeRows").insertAdjacentHTML("beforeend", recipeRow()); }
    else if (act === "delRow") { b.closest("[data-row]").remove(); updateBuyTotal(); }
  }

  function onChange(e) {
    const t = e.target;
    if (t.name === "ing") {
      const i = byId(t.value);
      const label = (t.closest("[data-row]") || t.closest("form")).querySelector(".inv-unit");
      if (label) label.textContent = `(${i ? i.unit : "unit"})`;
      if (t.form.id === "countForm") $("#countNow").textContent = i ? `Stock now: ${qty(i)}` : "";
    } else if (t.id === "recipeProduct") loadRecipe(t.value);
    else if (t.id === "histFilter") viewHistory(t.value).catch((x) => toast(x.message, true));
  }

  function onInput(e) { if (e.target.name === "amt") updateBuyTotal(); }

  const SUBMITS = {
    addIngForm: [saveNewIngredient, "addIngErr"], editIngForm: [saveEditedIngredient, "editIngErr"], buyForm: [savePurchase, "buyErr"],
    recipeForm: [saveRecipe, "recipeErr"],
    wasteForm: [async (f) => {
      const v = (n) => f.elements.namedItem(n).value;
      await api("/stock/wastage", { ingredientId: Number(v("ing")), qty: Number(v("qty")), reason: v("reason").trim() });
      toast("Wastage recorded");
    }, "wasteErr"],
    countForm: [async (f) => {
      const v = (n) => f.elements.namedItem(n).value;
      const r = await api("/stock/count", { ingredientId: Number(v("ing")), counted: Number(v("counted")) });
      toast(r.delta ? `Stock corrected (${r.delta > 0 ? "+" : ""}${fmt(r.delta)} ${r.unit})` : "Stock already matches");
    }, "countErr"],
  };

  async function onSubmit(e) {
    const entry = SUBMITS[e.target.id];
    if (!entry) return;
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true; err(entry[1]);
    try {
      await entry[0](e.target);
      await loadIngredients();
      await render();
    } catch (ex) { err(entry[1], ex.message); }
    finally { btn.disabled = false; }
  }

  return { show };
})();
