/* Shared helpers for the dashboard: API calls, money, escaping, toast. */
window.SA = (function () {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
  const toPaise = (rupees) => {
    const s = String(rupees ?? "").trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  };
  const toRupees = (paise) => (paise === null || paise === undefined ? "" : String(paise / 100));

  async function api(path, body, method) {
    const res = await fetch(`/api/admin${path}`, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: body === undefined ? { "X-Seren": "1" } : { "X-Seren": "1", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (res.status === 401 && path !== "/login") { document.dispatchEvent(new CustomEvent("sa:logout")); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg, bad) {
    const t = document.getElementById("toast");
    t.textContent = msg; t.classList.toggle("bad", Boolean(bad)); t.classList.add("on");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), bad ? 4500 : 2200);
  }

  const ago = (iso) => {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    if (m < 1440) return `${Math.round(m / 60)} h ago`;
    return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  };
  const day = (ymd) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : "");
  const time12 = (hhmm) => {
    if (!hhmm) return "";
    const [h, m] = hhmm.split(":").map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
  };
  const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

  return { esc, money, toPaise, toRupees, api, toast, ago, day, time12, todayIST, state: { catalog: null, settings: null } };
})();
