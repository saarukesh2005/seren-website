// Turns a cart into priced bill lines with GST. Pure functions, all money in paise.

const MAX_LINES = 40;
const MAX_QTY = 50;

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
    seen.set(id, Math.min((seen.get(id) || 0) + qty, MAX_QTY));
  }
  return { value: [...seen].map(([id, qty]) => ({ id, qty })) };
}

/**
 * Prices the cart from the server's own catalog and price list (never from what the browser sent).
 * @param {{id:string, qty:number}[]} cart
 * @param {Map<string, object>} catalog  id -> { name, category }
 * @param {Map<string, {price:number, unit:string, available:number}>} prices
 * @param {object} settings
 * @param {'pickup'|'delivery'|'dinein'|'counter'} mode
 * @param {{ coupon?: (itemsTotal:number) => number, points?: number }} offers  discounts in paise
 */
export function priceOrder(cart, catalog, prices, settings, mode, offers = {}) {
  const gst = Boolean(settings.gstin);
  const inclusive = settings.pricesIncludeGst;
  const base = [];
  for (const { id, qty } of cart) {
    const item = catalog.get(id);
    const p = prices.get(id);
    if (!item) return { error: "A product in your box is no longer on the menu" };
    if (!p || !p.available) return { error: `${item.name} isn't available right now` };
    const t = gst ? settings.tax[item.category] || { hsn: "", rate: 0 } : { hsn: "", rate: 0 };
    base.push({ id, name: item.name, category: item.category, unit: p.unit, qty, price: p.price, hsn: t.hsn, rate: t.rate, list: p.price * qty });
  }
  const itemsTotal = base.reduce((n, l) => n + taxLine(l.list, l.rate, inclusive).gross, 0);

  // discounts are shared across the lines (bigger lines take a bigger share), then GST is worked out on what's left
  const listTotal = base.reduce((n, l) => n + l.list, 0);
  const couponOff = offers.coupon ? Math.max(0, Math.round(offers.coupon(itemsTotal))) : 0;
  const pointsOff = Math.max(0, offers.points || 0);
  // discounts are in "what the customer pays"; when GST is added on top, take the matching amount off before GST
  const toNet = (gross) => (inclusive || !itemsTotal ? gross : Math.round((gross * listTotal) / itemsTotal));
  const wanted = Math.min(listTotal, toNet(couponOff) + toNet(pointsOff));
  const shares = splitByWeight(wanted, base.map((l) => l.list));
  const lines = base.map((l, i) => {
    const { list, ...rest } = l;
    const money = taxLine(list - shares[i], l.rate, inclusive);
    return { ...rest, listAmount: taxLine(list, l.rate, inclusive).gross, discount: shares[i], ...money };
  });
  const discount = itemsTotal - lines.reduce((n, l) => n + l.gross, 0);

  let delivery = null;
  if (mode === "delivery") {
    if (settings.minOrder && itemsTotal < settings.minOrder) return { error: "minOrder", minOrder: settings.minOrder };
    const free = settings.freeDeliveryAbove && itemsTotal >= settings.freeDeliveryAbove;
    const fee = free ? 0 : settings.deliveryFee;
    if (fee) {
      const t = gst ? settings.deliveryTax : { hsn: "", rate: 0 };
      delivery = { name: "Delivery", hsn: t.hsn, rate: t.rate, ...taxLine(fee, t.rate, inclusive) };
    }
  }

  const all = delivery ? [...lines, delivery] : lines;
  const total = all.reduce((n, l) => n + l.gross, 0);
  return {
    value: {
      lines,
      delivery,
      subtotal: itemsTotal,
      discount,
      couponDiscount: Math.min(couponOff, discount),
      pointsDiscount: Math.max(discount - Math.min(couponOff, discount), 0),
      deliveryFee: delivery ? delivery.gross : 0,
      total,
      taxSummary: summarise(all),
    },
  };
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
