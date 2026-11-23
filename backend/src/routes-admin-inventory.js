// Dashboard API for raw-material stock (permission "stock": owner and managers).
// Every handler gets c = { request, env, ctx, url, params, user }.
import { HttpError, json, readJson } from "./http.js";
import * as inv from "./inventory.js";
import { loadCatalog } from "./products.js";
import { audit } from "./staff.js";
import { rupees } from "./util.js";

const listLimit = (url, fallback, max) => {
  const n = Number(url.searchParams.get("limit"));
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

const paramId = (v, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${label} isn't valid`);
  return n;
};

/* ---------- ingredients ---------- */
export async function overview({ env }) {
  const ingredients = await inv.listIngredients(env.DB);
  return json({ ingredients, lowCount: ingredients.filter((i) => i.low).length, units: inv.UNITS, recipes: await inv.recipeCounts(env.DB) });
}

export async function addIngredient({ env, request, user }) {
  const made = await inv.addIngredient(env.DB, await readJson(request));
  await audit(env.DB, user, "stock ingredient added", made.name);
  return json({ ingredient: made }, 201);
}

export async function editIngredient({ env, params, request, user }) {
  const name = await inv.editIngredient(env.DB, paramId(params[0], "Ingredient"), await readJson(request));
  await audit(env.DB, user, "stock ingredient changed", name);
  return json({ ok: true });
}

/* ---------- recipes ---------- */
async function knownProduct(env, id) {
  const item = (await loadCatalog(env.DB)).find((c) => c.id === id);
  if (!item) throw new HttpError(404, "Unknown product");
  return item;
}

export async function getRecipe({ env, params }) {
  const item = await knownProduct(env, params[0]);
  return json({ product: { id: item.id, name: item.name }, lines: await inv.getRecipe(env.DB, item.id) });
}

export async function putRecipe({ env, params, request, user }) {
  const item = await knownProduct(env, params[0]);
  const body = await readJson(request);
  const count = await inv.setRecipe(env.DB, item.id, body.lines);
  await audit(env.DB, user, "recipe changed", `${item.name}: ${count} ingredient${count === 1 ? "" : "s"}`);
  return json({ ok: true, lines: await inv.getRecipe(env.DB, item.id) });
}

/* ---------- vendors and purchases ---------- */
export async function vendors({ env }) {
  return json({ vendors: await inv.listVendors(env.DB) });
}

export async function saveVendor({ env, request, user }) {
  const v = await inv.saveVendor(env.DB, await readJson(request));
  await audit(env.DB, user, v.created ? "vendor added" : "vendor changed", v.name);
  return json({ vendor: v }, v.created ? 201 : 200);
}

export async function purchases({ env, url }) {
  return json({ purchases: await inv.listPurchases(env.DB, listLimit(url, 50, 200)) });
}

export async function addPurchase({ env, request, user }) {
  const p = await inv.addPurchase(env.DB, user, await readJson(request));
  await audit(env.DB, user, "stock purchase", `${p.vendor || "no vendor"}${p.billNo ? ` bill ${p.billNo}` : ""}: ${p.count} item${p.count === 1 ? "" : "s"}, ${rupees(p.total)}`);
  return json({ purchase: p }, 201);
}

/* ---------- wastage, counts, history ---------- */
export async function wastage({ env, request, user }) {
  const w = await inv.recordWastage(env.DB, user, await readJson(request));
  await audit(env.DB, user, "stock wastage", `${w.name}: ${w.qty} ${w.unit}${w.reason ? ` (${w.reason})` : ""}`);
  return json({ ok: true });
}

export async function count({ env, request, user }) {
  const r = await inv.recordCount(env.DB, user, await readJson(request));
  await audit(env.DB, user, "stock counted", `${r.name}: ${r.before} → ${r.counted} ${r.unit}`);
  return json({ ok: true, ...r });
}

export async function moves({ env, url }) {
  const raw = url.searchParams.get("ingredient");
  const ingredient = raw ? paramId(raw, "Ingredient") : undefined;
  const before = Number(url.searchParams.get("before")) || undefined;
  return json({ moves: await inv.listMoves(env.DB, { ingredient, before, limit: listLimit(url, 100, 200) }) });
}

export async function foodCost({ env }) {
  return json({ items: await inv.foodCost(env.DB) });
}
