// Dashboard API: products, prices, daily stock limits and photos.
import { CATEGORIES } from "./catalog.js";
import { HttpError, json, readJson } from "./http.js";
import { addProduct, editProduct, loadCatalog, saveImage } from "./products.js";
import { audit } from "./staff.js";
import { leftOn } from "./stock.js";
import * as store from "./store.js";
import { istParts, rupees } from "./util.js";

export async function catalog({ env }) {
  const [prices, items] = await Promise.all([store.getPrices(env.DB), loadCatalog(env.DB)]);
  const left = await leftOn(env.DB, istParts().date, prices);
  return json({
    categories: CATEGORIES,
    items: items.map((c) => {
      const p = prices.get(c.id) || { price: null, unit: "", available: 0, daily_limit: null };
      return { ...c, price: p.price, unit: p.unit, available: p.available, dailyLimit: p.daily_limit, leftToday: left.has(c.id) ? left.get(c.id) : null };
    }),
  });
}

export async function putPrice({ env, params, request, user }) {
  const id = params[0];
  const items = await loadCatalog(env.DB);
  const item = items.find((c) => c.id === id);
  if (!item) throw new HttpError(404, "Unknown product");
  const body = await readJson(request);
  if (body.price === null || body.price === "") {
    await store.clearPrice(env.DB, id);
    await audit(env.DB, user, "price removed", item.name);
    return json({ ok: true });
  }
  const price = Number(body.price);
  if (!Number.isInteger(price) || price < 100 || price > 10000000) throw new HttpError(400, "Price must be between ₹1 and ₹1,00,000");
  let dailyLimit = null;
  if (body.dailyLimit !== null && body.dailyLimit !== undefined && body.dailyLimit !== "") {
    dailyLimit = Number(body.dailyLimit);
    if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 10000) throw new HttpError(400, "Daily limit: a whole number, or empty for no limit");
  }
  const unit = String(body.unit || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 30);
  const before = (await store.getPrices(env.DB)).get(id);
  await store.setPrice(env.DB, id, { price, unit, available: Boolean(body.available), dailyLimit });
  if (!before || before.price !== price) await audit(env.DB, user, "price changed", `${item.name}: ${before ? rupees(before.price) : "none"} → ${rupees(price)}`);
  return json({ ok: true });
}

export async function updateProduct({ env, params, request, user }) {
  const body = await readJson(request);
  const name = await editProduct(env.DB, await loadCatalog(env.DB), params[0], body);
  await audit(env.DB, user, "product edited", name);
  return json({ ok: true });
}

export async function createProduct({ env, request, user }) {
  const p = await addProduct(env.DB, await readJson(request));
  await audit(env.DB, user, "product added", p.name);
  return json({ product: p }, 201);
}

export async function uploadImage({ env, request }) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.includes("application/json")) throw new HttpError(415, "Send JSON");
  const text = await request.text();
  if (text.length > 600 * 1024) throw new HttpError(413, "Photo too large");
  let body;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, "Bad upload"); }
  return json({ key: await saveImage(env.DB, body && body.dataUrl) }, 201);
}
