// Checks raw-material stock against a running local backend (npm run dev).
// Before running: npx wrangler d1 execute seren-orders --local --command "DELETE FROM rate_hits"
// Usage: node test/inventory.mjs
import { readFileSync } from "node:fs";

const BASE = process.env.API || "http://127.0.0.1:8790";
const pw = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/ADMIN_PASSWORD="([^"]+)"/)[1];
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${String(detail).slice(0, 300)})`}`);

function session() {
  let cookie = "";
  return async (method, path, body) => {
    const headers = { Origin: BASE, "X-Seren": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
        const set = res.headers.get("set-cookie");
        if (set && set.startsWith("seren_admin=")) cookie = set.split(";")[0];
        const type = res.headers.get("content-type") || "";
        return { status: res.status, data: type.includes("json") ? await res.json() : await res.text() };
      } catch (e) {
        if (attempt >= 5) throw e; // the dev server restarts when files are saved: wait and retry
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  };
}

const owner = session();
const cashier = session();
const manager = session();
const sfx = Date.now().toString(36).slice(-5);
const PRODUCT = "bomb-tiramisu";
const J = (x) => JSON.stringify(x);

async function stockOf() {
  const r = await owner("GET", "/api/admin/stock");
  return new Map(r.data.ingredients.map((i) => [i.id, i]));
}

(async () => {
  let r = await owner("POST", "/api/admin/login", { password: pw });
  check("owner logs in", r.status === 200, J(r.data));
  await owner("POST", `/api/admin/prices/${PRODUCT}`, { price: 18000, unit: "per piece", available: true });

  /* ingredients */
  const mk = async (body) => (await owner("POST", "/api/admin/stock/ingredients", body));
  r = await mk({ name: `Flour ${sfx}`, unit: "g", onHand: 5000, lowAt: 500, cost: 4000 });
  check("adds an ingredient", r.status === 201 && r.data.ingredient.id > 0, J(r.data));
  const flour = r.data.ingredient.id;
  const cream = (await mk({ name: `Cream ${sfx}`, unit: "ml", onHand: 2000, lowAt: 200, cost: 25000 })).data.ingredient.id;
  const box = (await mk({ name: `Box ${sfx}`, unit: "pcs", onHand: 1, lowAt: 0, cost: 8000000 })).data.ingredient.id;
  check("duplicate name refused (any capitals)", (await mk({ name: `FLOUR ${sfx}`, unit: "g" })).status === 409);
  check("bad unit refused", (await mk({ name: `Odd ${sfx}`, unit: "kg" })).status === 400);
  check("one-letter name refused", (await mk({ name: "x", unit: "g" })).status === 400);
  check("negative warning level refused", (await mk({ name: `Neg ${sfx}`, unit: "g", lowAt: -1 })).status === 400);
  let s = await stockOf();
  check("opening stock is saved", s.get(flour).onHand === 5000 && s.get(flour).cost === 4000 && s.get(flour).lowAt === 500);
  r = await owner("POST", `/api/admin/stock/ingredients/${cream}`, { name: `Cream ${sfx}`, lowAt: 250, active: true });
  check("edits an ingredient", r.status === 200 && (await stockOf()).get(cream).lowAt === 250, J(r.data));
  r = await owner("POST", `/api/admin/stock/ingredients/${flour}`, { unit: "ml" });
  check("unit can't change on an ingredient that has stock history", r.status === 409, J(r.data));

  /* recipes */
  r = await owner("POST", `/api/admin/stock/recipes/${PRODUCT}`, { lines: [{ ingredientId: flour, qty: 100 }, { ingredientId: cream, qty: 50.5 }, { ingredientId: box, qty: 1 }] });
  check("saves a recipe", r.status === 200 && r.data.lines.length === 3, J(r.data));
  r = await owner("GET", `/api/admin/stock/recipes/${PRODUCT}`);
  check("reads the recipe back", r.status === 200 && r.data.lines.length === 3 && r.data.lines.some((l) => l.ingredientId === cream && l.qty === 50.5), J(r.data));
  check("zero amount refused", (await owner("POST", `/api/admin/stock/recipes/${PRODUCT}`, { lines: [{ ingredientId: flour, qty: 0 }] })).status === 400);
  check("same ingredient twice refused", (await owner("POST", `/api/admin/stock/recipes/${PRODUCT}`, { lines: [{ ingredientId: flour, qty: 1 }, { ingredientId: flour, qty: 2 }] })).status === 400);
  check("unknown ingredient refused", (await owner("POST", `/api/admin/stock/recipes/${PRODUCT}`, { lines: [{ ingredientId: 99999999, qty: 1 }] })).status === 404);
  check("more than 30 lines refused", (await owner("POST", `/api/admin/stock/recipes/${PRODUCT}`, { lines: Array.from({ length: 31 }, () => ({ ingredientId: flour, qty: 1 })) })).status === 400);
  check("unknown product refused", (await owner("POST", "/api/admin/stock/recipes/no-such-product", { lines: [] })).status === 404);
  check("failed saves left the recipe alone", (await owner("GET", `/api/admin/stock/recipes/${PRODUCT}`)).data.lines.length === 3);

  /* a sale takes stock, once */
  const before = await stockOf();
  const clientRef = `inv-${sfx}-${Date.now()}`;
  const bill = { items: [{ id: PRODUCT, qty: 2 }], method: "cash", clientRef };
  r = await owner("POST", "/api/admin/counter", bill);
  check("counter bill is made", r.status === 201, J(r.data));
  const code = r.data.order && r.data.order.code;
  let after = await stockOf();
  check("flour dropped by recipe x 2 (200 g)", after.get(flour).onHand === before.get(flour).onHand - 200, `${before.get(flour).onHand} -> ${after.get(flour).onHand}`);
  check("cream dropped by recipe x 2 (101 ml)", after.get(cream).onHand === before.get(cream).onHand - 101, `${before.get(cream).onHand} -> ${after.get(cream).onHand}`);
  check("boxes dropped by 2 and went below zero without blocking the sale", after.get(box).onHand === -1);
  check("below-zero stock is flagged low", after.get(box).low === true);
  r = await owner("POST", "/api/admin/counter", bill);
  check("same bill sent again is recognised", r.status === 200 && r.data.duplicate === true, J(r.data));
  const again = await stockOf();
  check("stock is not taken twice for the same bill", again.get(flour).onHand === after.get(flour).onHand && again.get(box).onHand === after.get(box).onHand);
  r = await owner("GET", `/api/admin/stock/moves?ingredient=${flour}`);
  const sales = r.data.moves.filter((m) => m.reason === "sale" && m.ref === code);
  check("one 'sale' move per bill, with the bill number", sales.length === 1 && sales[0].delta === -200, J(sales));

  /* purchase */
  const oldFlour = (await stockOf()).get(flour);
  r = await owner("POST", "/api/admin/stock/purchases", { vendorName: `Mill ${sfx}`, billNo: `B-${sfx}`, lines: [{ ingredientId: flour, qty: 1000, amount: 6000 }] });
  check("purchase is saved", r.status === 201 && r.data.purchase.total === 6000, J(r.data));
  const bought = (await stockOf()).get(flour);
  const expectCost = Math.round((Math.max(oldFlour.onHand, 0) * oldFlour.cost + 6000 * 1000) / (Math.max(oldFlour.onHand, 0) + 1000));
  check("purchase adds to stock", bought.onHand === oldFlour.onHand + 1000, `${oldFlour.onHand} -> ${bought.onHand}`);
  check("cost becomes the weighted average", bought.cost === expectCost, `${bought.cost} vs ${expectCost}`);
  const empty = (await mk({ name: `Sugar ${sfx}`, unit: "g", cost: 1 })).data.ingredient.id;
  await owner("POST", "/api/admin/stock/purchases", { vendorName: `Mill ${sfx}`, lines: [{ ingredientId: empty, qty: 2000, amount: 10000 }] });
  check("buying into empty stock sets cost to the price paid (paise per kg)", (await stockOf()).get(empty).cost === 5000);
  r = await owner("GET", "/api/admin/stock/purchases");
  check("purchases are listed with vendor and bill number", r.data.purchases.some((p) => p.vendor === `Mill ${sfx}` && p.billNo === `B-${sfx}` && p.lines[0].qty === 1000), J(r.data.purchases[0]));
  r = await owner("GET", "/api/admin/stock/vendors");
  check("the vendor was created once", r.data.vendors.filter((v) => v.name === `Mill ${sfx}`).length === 1);
  r = await owner("POST", "/api/admin/stock/vendors", { name: `Dairy ${sfx}`, phone: "9876543210", gstin: "33ABCDE1234F1Z5" });
  check("adds a vendor with phone and GSTIN", r.status === 201, J(r.data));
  check("bad GSTIN refused", (await owner("POST", "/api/admin/stock/vendors", { name: `Bad ${sfx}`, gstin: "123" })).status === 400);
  check("purchase with zero quantity refused", (await owner("POST", "/api/admin/stock/purchases", { lines: [{ ingredientId: flour, qty: 0, amount: 100 }] })).status === 400);
  check("purchase with no items refused", (await owner("POST", "/api/admin/stock/purchases", { lines: [] })).status === 400);
  check("purchase dated in the future refused", (await owner("POST", "/api/admin/stock/purchases", { day: "2999-01-01", lines: [{ ingredientId: flour, qty: 1, amount: 1 }] })).status === 400);

  /* wastage and count */
  const w0 = (await stockOf()).get(cream).onHand;
  r = await owner("POST", "/api/admin/stock/wastage", { ingredientId: cream, qty: 150, reason: "spilled" });
  check("wastage subtracts", r.status === 200 && (await stockOf()).get(cream).onHand === w0 - 150, J(r.data));
  check("wastage of zero refused", (await owner("POST", "/api/admin/stock/wastage", { ingredientId: cream, qty: 0 })).status === 400);
  r = await owner("GET", `/api/admin/stock/moves?ingredient=${cream}`);
  check("wastage is in the history with its reason", r.data.moves.some((m) => m.reason === "wastage" && m.delta === -150 && m.ref === "spilled"));
  r = await owner("POST", "/api/admin/stock/count", { ingredientId: cream, counted: 1500 });
  check("stock count corrects the stock", r.status === 200 && r.data.counted === 1500 && (await stockOf()).get(cream).onHand === 1500, J(r.data));
  r = await owner("GET", `/api/admin/stock/moves?ingredient=${cream}`);
  check("count correction is in the history", r.data.moves.some((m) => m.reason === "count" && m.delta === 1500 - (w0 - 150)), J(r.data.moves.slice(0, 2)));
  check("negative count refused", (await owner("POST", "/api/admin/stock/count", { ingredientId: cream, counted: -5 })).status === 400);

  /* low stock */
  await owner("POST", "/api/admin/stock/count", { ingredientId: flour, counted: 450 });
  r = await owner("GET", "/api/admin/stock");
  check("ingredient at or under its warning level is low", r.data.ingredients.find((i) => i.id === flour).low === true && r.data.lowCount >= 1);
  await owner("POST", "/api/admin/stock/count", { ingredientId: flour, counted: 4000 });
  check("and not low again after restocking", (await stockOf()).get(flour).low === false);
  const hidden = (await mk({ name: `Old ${sfx}`, unit: "g", onHand: 0, lowAt: 10 })).data.ingredient.id;
  await owner("POST", `/api/admin/stock/ingredients/${hidden}`, { active: false });
  check("hidden ingredients are never flagged low", (await stockOf()).get(hidden).low === false);

  /* food cost */
  r = await owner("GET", "/api/admin/stock/food-cost");
  const item = r.data.items.find((i) => i.id === PRODUCT);
  const now = await stockOf();
  const expected = Math.round((100 * now.get(flour).cost + 50.5 * now.get(cream).cost + 1 * now.get(box).cost) / 1000);
  check("food cost adds up recipe x cost", item && item.cost === expected, J({ item, expected }));
  check("food cost % is against the selling price", item && item.price === 18000 && Math.abs(item.costPercent - (expected / 18000) * 100) < 0.06, J(item));

  /* who may use it */
  const staffPw = "tea-and-cake-1";
  await owner("POST", "/api/admin/staff", { name: `Cash${sfx}`, role: "cashier", password: staffPw });
  await owner("POST", "/api/admin/staff", { name: `Mgr${sfx}`, role: "manager", password: staffPw });
  await cashier("POST", "/api/admin/login", { name: `Cash${sfx}`, password: staffPw });
  await manager("POST", "/api/admin/login", { name: `Mgr${sfx}`, password: staffPw });
  check("cashier can't see stock", (await cashier("GET", "/api/admin/stock")).status === 403);
  check("cashier can't add ingredients", (await cashier("POST", "/api/admin/stock/ingredients", { name: `Sneaky ${sfx}`, unit: "g" })).status === 403);
  check("cashier can't record wastage", (await cashier("POST", "/api/admin/stock/wastage", { ingredientId: flour, qty: 1 })).status === 403);
  check("cashier can't see food cost", (await cashier("GET", "/api/admin/stock/food-cost")).status === 403);
  check("manager can see stock", (await manager("GET", "/api/admin/stock")).status === 200);
  check("manager can record wastage", (await manager("POST", "/api/admin/stock/wastage", { ingredientId: flour, qty: 1, reason: "test" })).status === 200);

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
