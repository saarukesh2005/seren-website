/* Shared by the order box and the order page: talking to the order system and the UPI payment panel. */
window.SerenPay = (function () {
  "use strict";
  const API = String((window.SEREN_CONFIG || {}).api || "").replace(/\/+$/, "");
  const ORDERS_KEY = "seren-orders-v1";
  const QR_SRC = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
  const QR_SRI = "sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (paise) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

  async function api(path, opts = {}) {
    if (!API) throw new Error("Online ordering isn't switched on yet.");
    let res;
    try {
      res = await fetch(API + path, {
        method: opts.method || "GET",
        headers: opts.body ? { "Content-Type": "application/json" } : {},
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      throw new Error("Couldn't reach SEREN. Check your internet and try again.");
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) {
      const err = new Error(data.error || "Something went wrong. Please try again.");
      err.status = res.status; // callers can tell "wrong table PIN" (403 + needPin) from other problems
      err.needPin = data.needPin === true;
      throw err;
    }
    return data;
  }

  /* The 4-digit PIN staff tell guests when seating a table. Remembered for this visit only (one per table). */
  const PIN_RE = /^\d{4}$/;
  const pinKey = (table) => `seren-pin-v1:${String(table).toLowerCase()}`;
  function tablePin(table) {
    try { const v = sessionStorage.getItem(pinKey(table)); return PIN_RE.test(v || "") ? v : ""; } catch (e) { return ""; }
  }
  function rememberPin(table, pin) {
    try { if (PIN_RE.test(String(pin))) sessionStorage.setItem(pinKey(table), String(pin)); } catch (e) { /* storage blocked: the guest types it again next time */ }
  }
  function forgetPin(table) {
    try { sessionStorage.removeItem(pinKey(table)); } catch (e) { /* nothing was saved anyway */ }
  }

  /* orders placed on this device, newest first, so customers can find them again.
     Only well-formed entries from the last 30 days are trusted: anything else in storage is ignored. */
  const CODE_RE = /^SRN-[A-Z0-9]{6}$/;
  const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
  const ORDER_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  function savedOrders() {
    let list;
    try { list = JSON.parse(localStorage.getItem(ORDERS_KEY) || "[]"); } catch (e) { return []; }
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    return list
      .filter((o) => o && typeof o === "object" && typeof o.code === "string" && typeof o.token === "string" && CODE_RE.test(o.code) && TOKEN_RE.test(o.token))
      .map((o) => ({ code: o.code, token: o.token, at: Number.isFinite(o.at) ? Math.min(o.at, now) : now })) // older saves had no timestamp: they start their 30 days now
      .filter((o) => now - o.at <= ORDER_MAX_AGE);
  }
  function rememberOrder(code, token) {
    if (!CODE_RE.test(String(code)) || !TOKEN_RE.test(String(token))) return;
    const next = [{ code, token, at: Date.now() }, ...savedOrders().filter((o) => o.code !== code)].slice(0, 10);
    try { localStorage.setItem(ORDERS_KEY, JSON.stringify(next)); } catch (e) { /* private mode: the link still works */ }
  }
  function forgetOrders() {
    try { localStorage.removeItem(ORDERS_KEY); } catch (e) { /* storage blocked: nothing was saved anyway */ }
  }
  const orderUrl = (code, token) => `order.html#${encodeURIComponent(code)}.${encodeURIComponent(token)}`;
  const invoiceUrl = (code, token) => `${API}/invoice/${encodeURIComponent(code)}?t=${encodeURIComponent(token)}`;

  let qrLoading;
  function loadQr() {
    if (window.qrcode) return Promise.resolve();
    qrLoading = qrLoading || new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = QR_SRC; s.integrity = QR_SRI; s.crossOrigin = "anonymous";
      s.onload = resolve; s.onerror = () => { qrLoading = null; reject(new Error("QR code didn't load")); };
      document.head.appendChild(s);
    });
    return qrLoading;
  }

  const isPhone = () => window.matchMedia("(pointer:coarse)").matches || window.innerWidth < 700;

  /* The payment link comes from the server. Only trust it if it is a UPI link that pays the UPI ID shown
     on screen, for exactly this order's total. Returns the cleaned link, or null. */
  function checkedUpiLink(pay) {
    try {
      const u = new URL(String(pay.upi));
      const one = (k) => { const v = u.searchParams.getAll(k); return v.length === 1 ? v[0] : null; };
      const pa = one("pa"), am = one("am"), cu = u.searchParams.get("cu");
      if (u.protocol !== "upi:" || u.hostname !== "pay") return null;
      if (!pa || !pay.upiId || pa.trim().toLowerCase() !== String(pay.upiId).trim().toLowerCase()) return null;
      if (!am || !/^\d+(\.\d{1,2})?$/.test(am) || !Number.isFinite(Number(pay.total)) || Math.abs(Number(am) - Number(pay.total) / 100) >= 0.005) return null;
      if (cu !== null && cu !== "INR") return null;
      return u.href;
    } catch (e) { return null; }
  }

  /**
   * Draws the "pay with UPI" panel into `el`.
   * pay = { code, token, total, upi, upiId, upiName, expiresAt }; onSubmitted runs after the customer sends their UPI ref.
   */
  function payPanel(el, pay, onSubmitted) {
    const upi = checkedUpiLink(pay);
    if (!upi) {
      el.innerHTML = `<div class="pay"><p class="err" role="alert">Payment details look wrong — please call the shop</p></div>`;
      return;
    }
    const mins = pay.expiresAt ? Math.max(0, Math.round((new Date(pay.expiresAt) - Date.now()) / 60000)) : null;
    el.innerHTML = `
      <div class="pay">
        <p class="pay-amt"><span>Pay</span> ${esc(money(pay.total))}</p>
        <p class="pay-note">Order <b>${esc(pay.code)}</b>${mins ? ` · please pay within ${mins} min` : ""}</p>
        ${isPhone() ? `<a class="pill fill pay-app" href="${esc(upi)}">Pay with GPay, PhonePe or any UPI app</a>` : ""}
        <div class="pay-qr" aria-label="UPI QR code for ${esc(money(pay.total))}"><span class="hand">Loading QR…</span></div>
        <p class="pay-id">${isPhone() ? "Or pay" : "Scan with any UPI app, or pay"} to <b>${esc(pay.upiId)}</b> (${esc(pay.upiName)})
          <button type="button" class="linkish" data-copy="${esc(pay.upiId)}">Copy UPI ID</button></p>
        <form class="utr" novalidate>
          <label for="utr-${esc(pay.code)}">After paying, enter the 12-digit <b>UPI Ref No. / UTR</b> from your payment receipt</label>
          <div class="utr-row">
            <input id="utr-${esc(pay.code)}" name="utr" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="e.g. 412345678901" required>
            <button class="pill fill" type="submit">I've paid</button>
          </div>
          <p class="err" role="alert"></p>
        </form>
      </div>`;
    loadQr()
      .then(() => {
        const qr = window.qrcode(0, "M");
        qr.addData(upi);
        qr.make();
        el.querySelector(".pay-qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      })
      .catch(() => { el.querySelector(".pay-qr").innerHTML = `<span>QR code couldn't load. Use the UPI ID below.</span>`; });

    el.querySelector("[data-copy]").addEventListener("click", async (e) => {
      try { await navigator.clipboard.writeText(e.currentTarget.dataset.copy); e.currentTarget.textContent = "Copied"; }
      catch (err) { e.currentTarget.textContent = "Select and copy the ID"; }
    });
    const form = el.querySelector("form.utr");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector("button");
      const err = form.querySelector(".err");
      const utr = form.utr.value.replace(/\s+/g, "");
      if (!/^\d{12}$/.test(utr)) { err.textContent = "The UPI reference is 12 digits. Find it in your payment app's receipt."; form.utr.focus(); return; }
      btn.disabled = true; err.textContent = "";
      try {
        await api(`/api/orders/${encodeURIComponent(pay.code)}/payment`, { method: "POST", body: { t: pay.token, utr } });
        onSubmitted();
      } catch (ex) {
        err.textContent = ex.message; btn.disabled = false;
      }
    });
  }

  return { enabled: Boolean(API), api, PIN_RE, tablePin, rememberPin, forgetPin, money, esc, savedOrders, rememberOrder, forgetOrders, orderUrl, invoiceUrl, payPanel };
})();
