/* SEREN Counter: talking to the order system, remembering products for offline use,
   and the queue of bills taken while the internet was down (sent automatically when it's back). */
window.POS = (function () {
  "use strict";
  const KEYS = { catalog: "seren-pos-catalog", settings: "seren-pos-settings", queue: "seren-pos-queue", held: "seren-pos-held", favs: "seren-pos-favs", prefs: "seren-pos-prefs" };
  const read = (k, fallback) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; } catch (e) { return fallback; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } };
  const listeners = new Map();
  const on = (ev, fn) => listeners.set(ev, [...(listeners.get(ev) || []), fn]);
  const emit = (ev, data) => (listeners.get(ev) || []).forEach((fn) => fn(data));

  class NetworkError extends Error {}

  async function api(path, body) {
    let res;
    try {
      res = await fetch(`/api/admin${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? { "X-Seren": "1" } : { "X-Seren": "1", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
    } catch (e) {
      setOnline(false);
      throw new NetworkError("No internet connection");
    }
    setOnline(true);
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (res.status === 401 && path !== "/login") emit("logout");
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /**
   * Some actions need a manager's OK (big discount, many points, cancelling food from the kitchen). When the
   * order system asks for it, a manager types their name and PIN right here and the same request is sent again.
   */
  async function withApproval(send, body) {
    try {
      return await send(body);
    } catch (e) {
      if (!(e.data && e.data.needApproval) || !window.POSX) throw e;
      const ok = await POSX.askManager(e.data.what || e.message, e.data.error);
      if (!ok) throw new Error("Cancelled: needs a manager's OK");
      return withApproval(send, { ...body, approval: ok });
    }
  }

  /* ---------- products and settings, kept on this PC for offline billing ---------- */
  let catalog = read(KEYS.catalog, null);
  let settings = read(KEYS.settings, null);

  async function refresh() {
    try {
      const [c, s] = await Promise.all([api("/catalog"), api("/settings")]);
      catalog = { categories: c.categories, items: c.items, at: Date.now() };
      settings = s.settings;
      write(KEYS.catalog, catalog);
      write(KEYS.settings, settings);
      setOnline(true);
      return true;
    } catch (e) {
      if (e instanceof NetworkError) setOnline(false);
      else throw e;
      return false;
    }
  }

  // products the counter can sell right now (priced, on sale, not hidden)
  const sellable = () => (catalog ? catalog.items.filter((i) => i.price !== null && i.available && !i.hidden) : []);

  /* ---------- online / offline ---------- */
  let online = navigator.onLine;
  function setOnline(v) {
    if (v === online) return;
    online = v;
    emit("online", v);
    if (v) sync();
  }
  window.addEventListener("online", () => { refresh(); sync(); });
  window.addEventListener("offline", () => setOnline(false));

  /* ---------- bills ---------- */
  const newRef = () => `POS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

  // The exact price from the order system. Returns { quote, body } — body carries any manager approval given.
  async function quote(payload) {
    let sent = payload;
    const res = await withApproval((b) => { sent = b; return api("/counter/quote", b); }, payload);
    return { quote: res.quote, body: sent };
  }

  // Sends a bill. If the internet is down, the bill waits in the queue (same id, so it's never saved twice).
  async function sendBill(payload) {
    const bill = { ...payload, clientRef: payload.clientRef || newRef() };
    try {
      const res = await api("/counter", bill);
      setOnline(true);
      return { order: res.order, duplicate: Boolean(res.duplicate) };
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      setOnline(false);
      // who rang it up is kept, because someone else may be logged in when it is finally sent
      const who = (window.POSApp && POSApp.user && POSApp.user.name) || "";
      const { approval: _pin, ...safe } = bill; // a manager's PIN is never stored on the PC
      const queued = { ...safe, offlineAt: new Date().toISOString(), estimate: payload.estimate, rungBy: who };
      write(KEYS.queue, [...queue(), queued]);
      emit("queue", queue());
      return { offline: true, bill: queued };
    }
  }

  const queue = () => read(KEYS.queue, []);
  let syncing = false;
  async function sync() {
    if (syncing || !queue().length) return;
    syncing = true;
    try {
      for (const bill of queue()) {
        try {
          const { estimate, ...payload } = bill;
          const res = await api("/counter", payload);
          write(KEYS.queue, queue().filter((b) => b.clientRef !== bill.clientRef));
          emit("synced", { bill, order: res.order });
        } catch (e) {
          if (e instanceof NetworkError) { setOnline(false); break; }
          // the server refused it (e.g. a product is now sold out): keep it and show it to staff
          write(KEYS.queue, queue().map((b) => (b.clientRef === bill.clientRef ? { ...b, problem: e.message } : b)));
        }
      }
    } finally {
      syncing = false;
      emit("queue", queue());
    }
  }
  // Removing a bill the order system refused: the owner sees it in the activity log.
  function dropQueued(ref) {
    const bill = queue().find((b) => b.clientRef === ref);
    write(KEYS.queue, queue().filter((b) => b.clientRef !== ref));
    emit("queue", queue());
    if (bill) api("/counter/dropped", { clientRef: ref, estimate: Number(bill.estimate) || 0, problem: String(bill.problem || "").slice(0, 120), rungBy: String(bill.rungBy || "") }).catch(() => { /* logged next time */ });
  }
  setInterval(() => { if (queue().length) sync(); }, 15000);

  /* ---------- held bills and favourites (this PC only) ---------- */
  const held = () => read(KEYS.held, []);
  function hold(cart) { const next = [{ id: newRef(), at: Date.now(), cart }, ...held()].slice(0, 12); write(KEYS.held, next); emit("held", next); }
  function unhold(id) { const h = held().find((x) => x.id === id); write(KEYS.held, held().filter((x) => x.id !== id)); emit("held", held()); return h ? h.cart : null; }
  const favs = () => read(KEYS.favs, {});
  function countSale(lines) { const f = { ...favs() }; lines.forEach((l) => { f[l.id] = (f[l.id] || 0) + l.qty; }); write(KEYS.favs, f); }
  const prefs = () => ({ paper: 80, autoPrint: true, printer: "", ...read(KEYS.prefs, {}) });
  const setPrefs = (p) => write(KEYS.prefs, { ...prefs(), ...p });

  return {
    api, withApproval, refresh, sync, quote, sendBill, queue, dropQueued, hold, unhold, held, favs, countSale, prefs, setPrefs, on,
    get catalog() { return catalog; }, get settings() { return settings; }, get online() { return online; }, sellable, NetworkError,
  };
})();
