/* Kitchen screen for a tablet: what to make (oldest/earliest first), tap to start, tap when ready.
   Chimes on new orders and can print a kitchen ticket for each one. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const AUTO_KEY = "seren-kitchen-autoprint";
  let seen = null;

  async function api(path, body) {
    const res = await fetch(`/api/admin${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "X-Seren": "1", "Content-Type": "application/json" } : { "X-Seren": "1" },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    if (res.status === 401) { location.href = "./"; throw new Error("Please log in"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    return data;
  }

  const time12 = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`; };
  const minsAgo = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

  function card(o) {
    const where = o.mode === "dinein" ? `Table ${o.table}` : o.mode === "delivery" ? "Delivery" : o.mode === "pickup" ? "Pickup" : "Counter";
    const when = o.mode === "pickup" || o.mode === "delivery" ? `${o.date === today() ? "" : `${o.date} · `}${time12(o.time)}` : `${minsAgo(o.createdAt)} min ago`;
    const late = (o.mode === "dinein" || o.mode === "counter") && minsAgo(o.createdAt) >= 20 && o.status !== "ready";
    const next = o.status === "ready" ? null : o.status === "preparing" ? ["ready", "Ready ✓"] : ["preparing", "Start"];
    return `<article class="k-card ${o.mode} ${late ? "late" : ""}">
      <div class="k-row"><b class="k-where">${esc(where)}</b><span class="k-when">${esc(when)}</span></div>
      <div class="k-sub">${esc(o.code)}${o.name ? ` · ${esc(o.name)}` : ""}${o.tab ? " · tab" : ""}${o.paid ? "" : o.tab ? "" : " · not paid"}</div>
      <ul>${o.lines.map((l) => `<li><b>${l.qty}×</b> ${esc(l.name)}</li>`).join("")}</ul>
      ${o.notes ? `<p class="k-note">${esc(o.notes)}</p>` : ""}
      <div class="k-row">
        ${next ? `<button class="k-go" type="button" data-move="${next[0]}" data-code="${esc(o.code)}">${next[1]}</button>` : `<span class="k-done">Waiting for pickup / serving</span>`}
        <a class="k-btn" href="/kot/${encodeURIComponent(o.code)}" target="_blank" rel="noopener">Ticket</a>
      </div>
    </article>`;
  }

  async function load() {
    try {
      const { orders } = await api("/kitchen");
      const todo = orders.filter((o) => o.status === "paid" || o.status === "on_tab");
      const doing = orders.filter((o) => o.status === "preparing");
      const ready = orders.filter((o) => o.status === "ready");
      $("#todo").innerHTML = todo.map(card).join("") || `<p class="k-empty">Nothing waiting</p>`;
      $("#doing").innerHTML = doing.map(card).join("") || `<p class="k-empty">—</p>`;
      $("#ready").innerHTML = ready.map(card).join("") || `<p class="k-empty">—</p>`;
      $("#nTodo").textContent = todo.length; $("#nDoing").textContent = doing.length; $("#nReady").textContent = ready.length;
      $("#msg").hidden = true;
      const fresh = seen ? todo.filter((o) => !seen.has(o.code)) : [];
      if (fresh.length) {
        chime();
        if ($("#autoPrint").checked) fresh.forEach((o) => printTicket(o.code));
      }
      seen = new Set(orders.map((o) => o.code));
    } catch (e) {
      $("#msg").hidden = false; $("#msg").textContent = `${e.message}. Retrying…`;
    }
  }

  // Prints through a hidden frame, so the screen stays put.
  function printTicket(code) {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0";
    f.src = `/kot/${encodeURIComponent(code)}`;
    f.onload = () => { try { f.contentWindow.print(); } catch (e) { /* printing blocked */ } setTimeout(() => f.remove(), 60000); };
    document.body.appendChild(f);
  }

  function chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [523, 784, 1046].forEach((f, i) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
        const t = ctx.currentTime + i * 0.18;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.start(t); o.stop(t + 0.36);
      });
    } catch (e) { /* tap the screen once to allow sound */ }
  }

  let toastTimer;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2200); }

  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-move]");
    if (!b) return;
    b.disabled = true;
    try { await api(`/orders/${encodeURIComponent(b.dataset.code)}/status`, { to: b.dataset.move }); load(); }
    catch (ex) { toast(ex.message); b.disabled = false; }
  });
  try { $("#autoPrint").checked = localStorage.getItem(AUTO_KEY) === "1"; } catch (e) { /* storage blocked */ }
  $("#autoPrint").addEventListener("change", (e) => { try { localStorage.setItem(AUTO_KEY, e.target.checked ? "1" : "0"); } catch (ex) { /* storage blocked */ } });
  const tick = () => { $("#clock").textContent = new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }); };
  tick(); setInterval(tick, 15000);
  load(); setInterval(() => { if (!document.hidden) load(); }, 10000);
})();
