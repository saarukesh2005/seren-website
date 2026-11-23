/* Cash tab: open the drawer with a float, put cash in / take cash out, close the drawer with a blind count,
   see past drawers, and keep the shop's expenses. Plain words on purpose: this is used at the counter, on a phone. */
SA.money = (function () {
  "use strict";
  const { esc, money, api, toast, toPaise, todayIST } = SA;
  const $ = (s) => document.querySelector(s);
  const CATEGORIES = ["Milk & dairy", "Groceries", "Packaging", "Gas", "Electricity", "Rent", "Salaries", "Repairs", "Other"];
  const METHODS = [["cash", "Cash"], ["upi", "UPI"], ["card", "Card"], ["bank", "Bank transfer"]];
  const METHOD_LABEL = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank", platform: "Delivery apps", store_credit: "Store credit" };
  let ready = false;
  let shift = null;      // the open drawer, or null
  let blind = true;      // true = this login may not see how much cash is expected
  let result = null;     // what we show right after closing a drawer
  let moveMode = null;   // "in" | "out" | null (which cash form is open)
  let armed = null;      // the counted amount waiting for a second tap
  let range = "30";
  const canSeeMore = () => SA.can("reports");

  const clock = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  const stamp = (iso) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const overShort = (v) => (v === 0 ? "Exact, nothing over or short" : v > 0 ? `Over by ${money(v)}` : `Short by ${money(-v)}`);
  const asPaise = (value, allowZero) => {
    const p = toPaise(value);
    return Number.isInteger(p) && (allowZero ? p >= 0 : p > 0) ? p : null;
  };

  /* ---------- the drawer ---------- */
  function resultCard() {
    if (!result) return "";
    const s = result.shift;
    const bad = s.variance !== 0;
    return `<section class="box cash-card cash-result ${bad ? "cash-off" : "cash-ok"}" aria-live="polite">
      <h3>Drawer closed</h3>
      <p class="cash-verdict">${esc(overShort(s.variance))}</p>
      <div class="cash-stats">
        <div class="stat"><b>${esc(money(s.expected))}</b><span>Should have been there</span></div>
        <div class="stat"><b>${esc(money(s.counted))}</b><span>You counted</span></div>
      </div>
      ${bad ? `<p class="opt">The owner has been told about the difference.</p>` : ""}
      <button class="btn ghost" type="button" data-cash-done>OK</button>
    </section>`;
  }

  function movesList() {
    if (!shift.moves.length) return `<p class="opt">No cash put in or taken out yet.</p>`;
    return `<ul class="cash-moves">${shift.moves.map((m) => `<li><span class="cash-sign ${m.kind}">${m.kind === "in" ? "In" : "Out"}</span>
      <span>${esc(m.reason)}<small class="opt"> · ${esc(m.actor)}, ${esc(clock(m.at))}</small></span><b>${esc(money(m.amount))}</b></li>`).join("")}</ul>`;
  }

  function moveForm() {
    if (!moveMode) return "";
    const out = moveMode === "out";
    return `<form class="cash-form" id="cashMoveForm" autocomplete="off">
      <h4>${out ? "Take cash out of the drawer" : "Put cash into the drawer"}</h4>
      <label>Amount (₹)<input name="amount" inputmode="decimal" required></label>
      ${out ? `<label>What is it for?<select name="why"><option value="expense">A shop expense (milk, gas, packing…)</option><option value="other">Something else</option></select></label>
        <label data-why="expense">Type of expense<select name="category">${CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join("")}</select></label>
        <label data-why="expense">Note <span class="opt">(optional)</span><input name="note" maxlength="100"></label>
        <label data-why="other" hidden>Reason<input name="reason" maxlength="80"></label>`
        : `<label>Reason<input name="reason" maxlength="80" placeholder="e.g. change from the bank" required></label>`}
      <div class="cash-row"><button class="btn plum" type="submit">${out ? "Take it out" : "Put it in"}</button><button class="btn ghost" type="button" data-cash-cancel>Cancel</button></div>
    </form>`;
  }

  function openDrawer() {
    const more = !blind && shift.byMethod
      ? `<div class="cash-methods">${shift.byMethod.map((m) => `<span>${esc(METHOD_LABEL[m.method] || m.method)} <b>${esc(money(m.received - m.refunded))}</b></span>`).join("")}</div>` : "";
    return `<section class="box cash-card">
      <div class="cash-head"><h3>Drawer is open</h3><span class="opt">since ${esc(clock(shift.openedAt))} · opened by ${esc(shift.openedBy)}</span></div>
      <div class="cash-stats">
        <div class="stat"><b>${esc(money(shift.float))}</b><span>Cash you started with</span></div>
        <div class="stat"><b>${shift.bills}</b><span>Bills paid this time</span></div>
      </div>
      ${more}
      <h4>Cash put in or taken out</h4>${movesList()}
      <div class="cash-row">
        <button class="btn ghost" type="button" data-cash-move="in">Cash in</button>
        <button class="btn ghost" type="button" data-cash-move="out">Cash out</button>
      </div>
      ${moveForm()}
      <hr class="cash-rule">
      <form class="cash-form" id="cashCloseForm" autocomplete="off">
        <h4>Close the drawer</h4>
        <p class="opt">Count every note and coin in the drawer, then type the total. We will show you how it compares once you close.</p>
        <label>Cash counted (₹)<input name="counted" inputmode="decimal" required></label>
        <label>Note <span class="opt">(optional)</span><input name="note" maxlength="200"></label>
        <p class="err" id="cashCloseErr" role="alert"></p>
        <button class="btn primary" type="submit" id="cashCloseBtn">Close drawer</button>
      </form>
    </section>`;
  }

  function closedDrawer() {
    return `<section class="box cash-card">
      <h3>Drawer is closed</h3>
      <p class="lead">Count the cash you are starting with and type it here to open the drawer. Bills paid in cash are then counted against it.</p>
      <form class="cash-row" id="cashOpenForm" autocomplete="off">
        <label>Cash in the drawer now (₹)<input name="float" inputmode="decimal" required></label>
        <button class="btn plum" type="submit">Open drawer</button>
      </form>
    </section>`;
  }

  function renderDrawer() {
    $("#cashDrawer").innerHTML = resultCard() + (shift ? openDrawer() : closedDrawer());
  }

  let shiftReq = 0;
  async function loadShift() {
    const mine = ++shiftReq;
    try {
      const r = await api("/shift");
      if (mine !== shiftReq) return;   // a newer request is already on its way
      shift = r.shift;
      blind = r.blind !== false;
    } catch (e) { toast(e.message, true); }
    renderDrawer();
  }

  /* ---------- history ---------- */
  async function loadHistory() {
    if (!canSeeMore()) { $("#cashHist").innerHTML = ""; return; }
    try {
      const { shifts } = await api("/shifts?limit=20");
      const rows = shifts.map((s) => `<tr><td>${esc(stamp(s.openedAt))}<br><small class="opt">${esc(s.openedBy)}</small></td>
        <td class="r">${esc(money(s.float))}</td>
        <td class="r">${s.closedAt ? esc(money(s.expected)) : "—"}</td><td class="r">${s.closedAt ? esc(money(s.counted)) : "—"}</td>
        <td class="r ${s.variance ? "cash-bad" : ""}">${s.closedAt ? esc(s.variance === 0 ? "Exact" : s.variance > 0 ? `Over ${money(s.variance)}` : `Short ${money(-s.variance)}`) : "Open"}</td></tr>`).join("");
      $("#cashHist").innerHTML = `<section class="box cash-card"><h3>Past drawers</h3>
        ${shifts.length ? `<div class="table-wrap"><table class="grid"><thead><tr><th>Opened</th><th class="r">Started with</th><th class="r">Should be</th><th class="r">Counted</th><th class="r">Result</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="empty">No drawers yet</p>`}</section>`;
    } catch (e) { toast(e.message, true); }
  }

  /* ---------- expenses ---------- */
  function period() {
    const t = todayIST();
    return range === "today" ? [t, t] : [addDays(t, -(Number(range) - 1)), t];
  }

  async function loadExpenses() {
    if (!canSeeMore()) { $("#cashExp").innerHTML = ""; return; }
    const [from, to] = period();
    let data;
    try { data = await api(`/expenses?from=${from}&to=${to}`); } catch (e) { toast(e.message, true); return; }
    const mayDelete = ["owner", "manager"].includes(SA.state.user && SA.state.user.role);
    const rows = data.expenses.map((x) => `<tr><td>${esc(SA.day(x.day))}</td><td>${esc(x.category)}${x.note ? `<br><small class="opt">${esc(x.note)}</small>` : ""}</td>
      <td>${esc(METHOD_LABEL[x.method] || x.method)}</td><td class="r">${esc(money(x.amount))}</td>
      <td>${mayDelete && x.canDelete ? `<button class="btn ghost small" type="button" data-exp-del="${x.id}">Delete</button>` : ""}</td></tr>`).join("");
    $("#cashExp").innerHTML = `<section class="box cash-card">
      <h3>Expenses</h3>
      <form class="cash-form" id="expForm" autocomplete="off">
        <div class="formgrid">
          <label>Date<input type="date" name="day" value="${todayIST()}" max="${todayIST()}" required></label>
          <label>Type<select name="category">${CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join("")}</select></label>
          <label>Amount (₹)<input name="amount" inputmode="decimal" required></label>
          <label>Paid by<select name="method">${METHODS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
        </div>
        <label>Note <span class="opt">(optional)</span><input name="note" maxlength="200"></label>
        <p class="opt">Took the money out of the drawer? Use "Cash out" above instead, so the drawer count stays right.</p>
        <p class="err" id="expErr" role="alert"></p>
        <button class="btn plum" type="submit">Add expense</button>
      </form>
      <div class="chips cash-range" role="group" aria-label="Show expenses for">${[["today", "Today"], ["7", "7 days"], ["30", "30 days"]].map(([k, l]) => `<button type="button" data-exp-range="${k}" aria-pressed="${k === range}">${l}</button>`).join("")}</div>
      <p><b>${esc(money(data.total.amount))}</b> spent in this time (${data.total.n} ${data.total.n === 1 ? "entry" : "entries"})</p>
      ${data.byCategory.length ? `<ul class="split cash-cats">${data.byCategory.map((c) => `<li><span>${esc(c.k)}</span><span class="track" aria-hidden="true"><i style="width:${data.total.amount ? (c.amount / data.total.amount) * 100 : 0}%"></i></span><b>${esc(money(c.amount))}</b><span class="opt">${c.n}</span></li>`).join("")}</ul>` : ""}
      ${data.expenses.length ? `<div class="table-wrap"><table class="grid"><thead><tr><th>Date</th><th>What</th><th>Paid by</th><th class="r">Amount</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="empty">No expenses in this time</p>`}
    </section>`;
  }

  /* ---------- actions ---------- */
  async function openShift(form) {
    const float = asPaise(form.float.value, true);
    if (float === null) { toast("Type the cash you are starting with, like 2000", true); return; }
    try {
      await api("/shift/open", { float });
      result = null;
      toast("Drawer opened");
      await loadShift();
    } catch (e) { toast(e.message, true); }
  }

  async function addMove(form) {
    const amount = asPaise(form.amount.value);
    if (amount === null) { toast("Type an amount above zero", true); return; }
    const body = { kind: moveMode, amount };
    if (moveMode === "out" && form.why.value === "expense") {
      body.reason = "expense"; body.category = form.category.value; body.note = form.note.value;
    } else body.reason = form.reason.value;
    try {
      await api("/shift/cash", body);
      toast(moveMode === "in" ? "Cash put in" : "Cash taken out");
      moveMode = null;
      await loadShift();
      if (body.reason === "expense") loadExpenses();
    } catch (e) { toast(e.message, true); }
  }

  async function closeShift(form) {
    const counted = asPaise(form.counted.value, true);
    const err = $("#cashCloseErr");
    err.textContent = "";
    if (counted === null) { err.textContent = "Type the cash you counted, like 5400"; return; }
    if (armed !== counted) {   // first tap: ask to be sure
      armed = counted;
      $("#cashCloseBtn").textContent = `Tap again to close with ${money(counted)} counted`;
      return;
    }
    try {
      result = await api("/shift/close", { counted, note: form.note.value });
      armed = null; moveMode = null;
      await loadShift();
      loadHistory();
    } catch (e) { err.textContent = e.message; armed = null; $("#cashCloseBtn").textContent = "Close drawer"; }
  }

  async function addExpense(form) {
    const err = $("#expErr");
    err.textContent = "";
    const amount = asPaise(form.amount.value);
    if (amount === null) { err.textContent = "Type an amount above zero"; return; }
    try {
      await api("/expenses", { day: form.day.value, category: form.category.value, amount, method: form.elements.method.value, note: form.note.value });
      toast("Expense added");
      loadExpenses();
    } catch (e) { err.textContent = e.message; }
  }

  function onClick(e) {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.cashMove) { moveMode = t.dataset.cashMove; renderDrawer(); const a = document.querySelector("#cashMoveForm [name=amount]"); if (a) a.focus(); }
    else if (t.hasAttribute("data-cash-cancel")) { moveMode = null; renderDrawer(); }
    else if (t.hasAttribute("data-cash-done")) { result = null; renderDrawer(); }
    else if (t.dataset.expRange) { range = t.dataset.expRange; loadExpenses(); }
    else if (t.dataset.expDel) {
      api(`/expenses/${t.dataset.expDel}/delete`, {}).then(() => { toast("Expense deleted"); loadExpenses(); }).catch((ex) => toast(ex.message, true));
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    const f = e.target;
    if (f.id === "cashOpenForm") openShift(f);
    else if (f.id === "cashMoveForm") addMove(f);
    else if (f.id === "cashCloseForm") closeShift(f);
    else if (f.id === "expForm") addExpense(f);
  }

  function onChange(e) {
    if (e.target.name === "why") {
      document.querySelectorAll("#cashMoveForm [data-why]").forEach((l) => { l.hidden = l.dataset.why !== e.target.value; });
    }
  }

  function onInput(e) {
    if (e.target.name === "counted" && armed !== null) { armed = null; $("#cashCloseBtn").textContent = "Close drawer"; }
  }

  function init() {
    ready = true;
    $("#tab-cash").innerHTML = `<p class="lead">Your cash drawer, in plain words: open it, note cash in and out, and count it when you close.</p>
      <div id="cashDrawer"></div><div id="cashHist"></div><div id="cashExp"></div>`;
    const root = $("#tab-cash");
    root.addEventListener("click", onClick);
    root.addEventListener("submit", onSubmit);
    root.addEventListener("change", onChange);
    root.addEventListener("input", onInput);
  }

  function show() {
    if (!ready) init();
    loadShift(); loadHistory(); loadExpenses();
  }
  return { show };
})();
