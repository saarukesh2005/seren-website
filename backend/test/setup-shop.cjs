// Shared test setup: owner login, every product priced, the shop open for orders. Returns an authed `post`.
const fs = require("fs");
const path = require("path");
const BASE = "http://127.0.0.1:8790";

module.exports = async function setupShop() {
  const pw = fs.readFileSync(path.join(__dirname, "../.dev.vars"), "utf8").match(/ADMIN_PASSWORD="([^"]+)"/)[1];
  const h = { Origin: BASE, "X-Seren": "1", "Content-Type": "application/json" };
  const login = await fetch(`${BASE}/api/admin/login`, { method: "POST", headers: h, body: JSON.stringify({ password: pw }) });
  const H = { ...h, Cookie: (login.headers.get("set-cookie") || "").split(";")[0] };
  const post = (p, b) => fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(b) }).then((r) => r.json());
  const get = (p) => fetch(BASE + p, { headers: H }).then((r) => r.json());
  await post("/api/admin/settings", { upiId: "seren@okhdfcbank", acceptingOrders: true, openTime: "00:00", closeTime: "23:59", prepMinutes: 0 });
  const { items } = await get("/api/admin/catalog");
  for (const it of items) if (it.price === null && !it.hidden) await post(`/api/admin/prices/${it.id}`, { price: it.category === "entremets" ? 210000 : 18000, unit: "per piece", available: true });
  return { post, get };
};
