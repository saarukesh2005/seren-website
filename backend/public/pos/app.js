/* SEREN Counter start-up: login (works offline too once you've logged in on this PC), keyboard shortcuts,
   and the offline helper (service worker) that keeps the counter opening without internet. */
window.POSApp = (function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const app = { user: null };
  const USER_KEY = "seren-pos-user";

  function canCount(me) { return me.perms.includes("*") || me.perms.includes("counter"); }

  async function boot() {
    try {
      const me = await POS.api("/me");
      if (!canCount(me)) { showLogin("Your login can't make bills. Ask the owner."); return; }
      try { localStorage.setItem(USER_KEY, JSON.stringify(me.user)); } catch (e) { /* storage blocked */ }
      await POS.refresh();
      showApp(me.user);
    } catch (e) {
      // no internet: keep billing with what this PC remembers
      const remembered = (() => { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (x) { return null; } })();
      if (e instanceof POS.NetworkError && remembered && POS.catalog && localLock()) {
        offlineUnlock = remembered;
        $("#who").value = remembered.name === "Owner" ? "" : remembered.name;
        showLogin("No internet. Type your password to keep billing on this PC.");
      } else showLogin(e instanceof POS.NetworkError ? "No internet. Connect once to log in on this PC." : "");
    }
  }

  function showLogin(hint) {
    $("#app").hidden = true; $("#login").hidden = false;
    $("#loginHint").textContent = hint || "";
    setTimeout(() => $("#who").focus(), 50);
  }

  let started = false;
  function showApp(user) {
    app.user = user;
    $("#login").hidden = true; $("#app").hidden = false;
    $("#whoAmI").textContent = `${user.name}`;
    if (started) { POSUI.renderCats(); POSUI.render(); return; }
    started = true;
    POSUI.start();
    document.querySelectorAll("[data-pay]").forEach((b) => b.addEventListener("click", () => POSPay.start(b.dataset.pay)));
    $("#advBtn").addEventListener("click", POSX.advanceOrder);
    $("#appBtn").addEventListener("click", POSX.appOrder);
    POS.sync();
    setInterval(() => { if (POS.online && !document.hidden) POS.refresh().then(() => POSUI.render()); }, 120000);
  }

  /* Offline, the counter opens only with the password of the last person who logged in here. It is checked
     against a slow salted hash kept on this PC (PBKDF2, 200,000 rounds), never the password itself. */
  const LOCK_KEY = "seren-pos-lock";
  let offlineUnlock = null;
  const localLock = () => { try { return JSON.parse(localStorage.getItem(LOCK_KEY)); } catch (e) { return null; } };
  async function slowHash(password, saltB64) {
    const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" }, key, 256);
    return btoa(String.fromCharCode(...new Uint8Array(bits)));
  }
  async function saveLock(name, password) {
    if (!(window.crypto && crypto.subtle)) return;
    const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    try { localStorage.setItem(LOCK_KEY, JSON.stringify({ name, salt, hash: await slowHash(password, salt) })); } catch (e) { /* storage blocked */ }
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true; $("#loginErr").textContent = "";
    const name = $("#who").value.trim();
    const password = $("#pw").value;
    try {
      await POS.api("/login", { name, password });
      $("#pw").value = "";
      // only staff can unlock offline; nothing derived from the owner's password is kept on the counter PC
      if (name && name.toLowerCase() !== "owner") await saveLock(name, password);
      else { try { localStorage.removeItem(LOCK_KEY); } catch (x) { /* storage blocked */ } }
      offlineUnlock = null;
      await boot();
    } catch (ex) {
      const lock = localLock();
      if (ex instanceof POS.NetworkError && offlineUnlock && lock && (await slowHash(password, lock.salt)) === lock.hash && lock.name.toLowerCase() === name.toLowerCase()) {
        $("#pw").value = "";
        showApp(offlineUnlock);
      } else $("#loginErr").textContent = ex instanceof POS.NetworkError ? "No internet, and that isn't the password last used on this PC" : ex.message;
    } finally { btn.disabled = false; }
  });
  $("#logoutBtn").addEventListener("click", async () => {
    if (POS.queue().length && !window.confirm("Some offline bills haven't been sent yet. They stay on this PC and send after the next login. Log out?")) return;
    try { await POS.api("/logout", {}); } catch (e) { /* offline */ }
    try { localStorage.removeItem(USER_KEY); localStorage.removeItem(LOCK_KEY); } catch (e) { /* storage blocked */ }
    location.reload();
  });
  POS.on("logout", () => showLogin("Please log in again."));

  // keyboard: F1 cash · F2 UPI · F3 card · F4 hold · F5 split · F6 held bills · F9 repeat last bill · F8 reprint last · / search · Esc clear
  document.addEventListener("keydown", (e) => {
    if ($("#app").hidden) return;
    const open = document.querySelector("dialog[open]");
    const keys = { F1: () => POSPay.start("cash"), F2: () => POSPay.start("upi"), F3: () => POSPay.start("card"), F4: POSUI.hold, F5: () => POSPay.start("split"), F6: POSUI.showHeld, F9: POSUI.repeatLast,
      F8: () => (window.POSLast ? POSPrint.printReceipt(window.POSLast) : POSUI.toast("No receipt to reprint yet")) };
    if (keys[e.key] && !open) { e.preventDefault(); keys[e.key](); return; }
    if (e.key === "/" && !open && document.activeElement.tagName !== "INPUT") { e.preventDefault(); POSUI.focusSearch(); }
    if (e.key === "Escape" && !open && document.activeElement.tagName !== "INPUT" && POSUI.lines().length && window.confirm("Clear this bill?")) POSUI.clear();
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { /* offline helper unavailable */ });
  boot();
  return app;
})();
