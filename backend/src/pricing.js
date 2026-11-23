// Turns a cart into priced bill lines with GST. Pure functions, all money in paise.

const MAX_LINES = 40;
const MAX_QTY = 50;
const MAX_OPTS = 10;

const bp = (rate) => Math.round(rate * 100); // 5% -> 500 basis points

// Splits one line's money into taxable value and GST.
export function taxLine(amount, rate, inclusive) {
  if (!rate) return { taxable: amount, tax: 0, gross: amount };
  if (inclusive) {
    const taxable = Math.round((amount * 10000) / (10000 + bp(rate)));
    return { taxable, tax: amount - taxable, gross: amount };
  }
  const tax = Math.round((amount * bp(rate)) / 10000);
  return { taxable: amount, tax, gross: amount + tax };
}

// Checks the cart shape. Returns { value: [{id, qty}] } or { error }.
export function checkCart(items) {
  if (!Array.isArray(items) || items.length === 0) return { error: "Your box is empty" };
  if (items.length > MAX_LINES) return { error: `Up to ${MAX_LINES} different products per order` };
  const seen = new Map();
  for (const it of items) {
    const id = typeof it?.id === "string" ? it.id : "";
    const qty = Number(it?.qty);
    if (!/^[a-z0-9-]{1,80}$/.test(id)) return { error: "A product in your box isn't recognised" };
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return { error: `Quantities must be between 1 and ${MAX_QTY}` };
    const raw = it.opts === undefined ? [] : it.opts;
    if (!Array.isArray(raw) || raw.length > MAX_OPTS || !raw.every((o) => typeof o === "string" && /^[a-z0-9-]{1,40}$/.test(o))) return { error: "A choice in your box isn't recognised" };
    const opts = [...new Set(raw)].sort();
    const key = `${id}|${opts.join(",")}`; // the same item with different choices is a different line
    const prev = seen.get(key);
    seen.set(key, { id, opts, qty: Math.min((prev ? prev.qty : 0) + qty, MAX_QTY) });
  }
  return { value: [...seen.values()].map(({ id, opts, qty }) => (opts.length ? { id, qty, opts } : { id, qty })) };
}

/**
 * The chosen options of one item (size, flavour, add-ons), checked against the item's own option groups.
 * Groups: { id, name, pick: "one" | "many", required, choices: [{ id, name, price }] } (price in paise, added to the item).
 */
export function pickOptions(item, opts = []) {
  const groups = Array.isArray(item.options) ? item.options : [];
  const chosen = [];
  const left = new Set(opts);
  for (const g of groups) {
    const hits = g.choices.filter((ch) => left.has(`${g.id}-${ch.id}`));
    hits.forEach((ch) => left.delete(`${g.id}-${ch.id}`));
    if (g.pick === "one" && hits.length > 1) return { error: `${item.name}: choose one ${g.name.toLowerCase()}` };
    if (g.required && !hits.length) return { error: `${item.name}: please choose a ${g.name.toLowerCase()}` };
    chosen.push(...hits.map((ch) => ({ group: g.name, name: ch.name, price: ch.price })));
  }
  if (left.size) return { error: `${item.name}: one of the choices is no longer offered` };
  return { value: chosen };
}

/**
 * Prices the cart from the server's own catalog and price list (never from what the browser sent).
 * @param {{id:string, qty:number, opts?:string[]}[]} cart
 * @param {Map<string, object>} catalog  id -> { name, category, options }
 * @param {Map<string, {price:number, unit:string, available:number}>} prices
 * @param {object} settings
 * @param {'pickup'|'delivery'|'dinein'|'counter'} mode
 * @param {{ coupon?: (itemsTotal:number) => number, points?: number, manual?: number, packing?: boolean, service?: boolean, platform?: string }} offers
 *        discounts in paise (what the customer pays); packing/service switch the shop's charges on or off for this bill
 */
export function priceOrder(cart, catalog, prices, settings, mode, offers = {}) {
  const gst = Boolean(settings.gstin);
  const inclusive = settings.pricesIncludeGst;
  const base = [];
  for (const { id, qty, opts } of cart) {
    const item = catalog.get(id);
    const p = prices.get(id);
    if (!item) return { error: "A product in your box is no longer on the menu" };
    if (!p || !p.available) return { error: `${item.name} isn't available right now` };
    const picked = pickOptions(item, opts);
    if (picked.error) return { error: picked.error };
    const t = gst ? settings.tax[item.category] || { hsn: "", rate: 0 } : { hsn: "", rate: 0 };
    const extra = picked.value.reduce((n, o) => n + o.price, 0);
    const name = picked.value.length ? `${item.name} (${picked.value.map((o) => o.name).join(", ")})` : item.name;
    base.push({ id, name, category: item.category, unit: p.unit, qty, price: p.price + extra, hsn: t.hsn, rate: t.rate, list: (p.price + extra) * qty,
      ...(picked.value.length ? { opts: opts.slice(), choices: picked.value.map((o) => o.name) } : {}) });
  }
  const itemsTotal = base.reduce((n, l) => n + taxLine(l.list, l.rate, inclusive).gross, 0);

  // discounts are shared across the lines (bigger lines take a bigger share), then GST is worked out on what's left
  const listTotal = base.reduce((n, l) => n + l.list, 0);
  const couponOff = offers.coupon ? Math.max(0, Math.round(offers.coupon(itemsTotal))) : 0;
  const pointsOff = Math.max(0, offers.points || 0);
  const manualOff = Math.max(0, Math.round(offers.manual || 0));
  // discounts are in "what the customer pays"; when GST is added on top, take the matching amount off before GST
  const toNet = (gross) => (inclusive || !itemsTotal ? gross : Math.round((gross * listTotal) / itemsTotal));
  const wanted = Math.min(listTotal, toNet(couponOff) + toNet(pointsOff) + toNet(manualOff));
  const shares = splitByWeight(wanted, base.map((l) => l.list));
  const lines = base.map((l, i) => {
    const { list, ...rest } = l;
    const money = taxLine(list - shares[i], l.rate, inclusive);
    return { ...rest, listAmount: taxLine(list, l.rate, inclusive).gross, discount: shares[i], ...money };
  });
  const discount = itemsTotal - lines.reduce((n, l) => n + l.gross, 0);
  const afterDiscount = itemsTotal - discount;

  let delivery = null;
  if (mode === "delivery" && !offers.platform) {
    if (settings.minOrder && itemsTotal < settings.minOrder) return { error: "minOrder", minOrder: settings.minOrder };
    const free = settings.freeDeliveryAbove && itemsTotal >= settings.freeDeliveryAbove;
    const fee = free ? 0 : settings.deliveryFee;
    if (fee) {
      const t = gst ? settings.deliveryTax : { hsn: "", rate: 0 };
      delivery = { name: "Delivery", hsn: t.hsn, rate: t.rate, ...taxLine(fee, t.rate, inclusive) };
    }
  }

  const { charges, roundOff, total } = billExtras(settings, lines, mode, { packing: offers.packing, service: offers.service, before: delivery ? [delivery] : [], afterDiscount });
  return {
    value: {
      lines,
      delivery,
      charges,
      roundOff,
      subtotal: itemsTotal,
      discount,
      couponDiscount: Math.min(couponOff, discount),
      pointsDiscount: Math.min(pointsOff, Math.max(discount - Math.min(couponOff, discount), 0)),
      manualDiscount: Math.max(discount - Math.min(couponOff, discount) - Math.min(pointsOff, Math.max(discount - Math.min(couponOff, discount), 0)), 0),
      deliveryFee: delivery ? delivery.gross : 0,
      total,
      taxSummary: summarise([...lines, ...(delivery ? [delivery] : []), ...charges]),
    },
  };
}

/**
 * Packing and service charges (they follow the food's GST rate: the highest rate on the bill) and the round-off.
 * Service charge is never forced: the owner switches it on, and staff remove it if the guest asks.
 */
export function billExtras(settings, lines, mode, { packing, service, before = [], afterDiscount } = {}) {
  const gst = Boolean(settings.gstin);
  const inclusive = settings.pricesIncludeGst;
  const ch = settings.charges || {};
  const charges = [];
  const rate = gst ? Math.max(0, ...lines.map((l) => l.rate)) : 0;
  const hsn = gst ? ch.hsn || "996331" : "";
  const food = afterDiscount ?? lines.reduce((n, l) => n + l.gross, 0);
  const packingFee = packing === false ? 0 : packing === true || ["pickup", "delivery"].includes(mode) ? ch.packing || 0 : 0;
  if (packingFee) charges.push({ name: "Packing", hsn, rate, ...taxLine(packingFee, rate, inclusive) });
  if (mode === "dinein" && ch.servicePercent && service !== false) {
    const amount = Math.round((food * ch.servicePercent) / 100);
    if (amount) charges.push({ name: `Service charge ${ch.servicePercent}%`, hsn, rate, ...taxLine(amount, rate, inclusive) });
  }
  const exact = [...lines, ...before, ...charges].reduce((n, l) => n + l.gross, 0);
  const roundOff = ch.roundOff ? Math.round(exact / 100) * 100 - exact : 0;
  return { charges, roundOff, total: exact + roundOff };
}

// Splits `amount` into whole paise in proportion to `weights` (largest remainders get the leftover paise).
export function splitByWeight(amount, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!amount || !sum) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / sum);
  const out = raw.map(Math.floor);
  let left = amount - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]] += 1;
  return out;
}

// GST grouped by rate, split into CGST and SGST (sale within the state).
export function summarise(lines) {
  const byRate = new Map();
  for (const l of lines) {
    const row = byRate.get(l.rate) || { rate: l.rate, taxable: 0, tax: 0 };
    byRate.set(l.rate, { ...row, taxable: row.taxable + l.taxable, tax: row.tax + l.tax });
  }
  return [...byRate.values()]
    .sort((a, b) => a.rate - b.rate)
    .map((r) => ({ ...r, cgst: Math.floor(r.tax / 2), sgst: r.tax - Math.floor(r.tax / 2) }));
}
