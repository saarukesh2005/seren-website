// Daily stock limits ("12 Hazelnut Symphony per day"). A product's limit lives on its price row (daily_limit).
// Each order reserves its quantity for its day; unpaid, expired or cancelled orders give it back.

// Statements that reserve stock as part of the order's transaction. The stock table's CHECK makes
// the whole order fail if any product would go over its limit.
export function reserveStmts(db, orderCode, lines, day, prices) {
  const stmts = [];
  for (const l of lines) {
    const cap = prices.get(l.id)?.daily_limit;
    if (cap === null || cap === undefined) continue;
    stmts.push(
      db.prepare(`INSERT INTO stock (item_id, day, cap, sold) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT (item_id, day) DO UPDATE SET sold = sold + excluded.sold, cap = excluded.cap`).bind(l.id, day, cap, l.qty),
      db.prepare("INSERT INTO order_stock (order_id, item_id, day, qty) VALUES ((SELECT id FROM orders WHERE code = ?1), ?2, ?3, ?4)")
        .bind(orderCode, l.id, day, l.qty),
    );
  }
  return stmts;
}

// Gives the stock back, only if the order is cancelled/expired right now (and only once: its rows are then deleted).
export function releaseStmts(db, orderId) {
  const gone = "EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status IN ('expired', 'cancelled'))";
  return [
    db.prepare(`UPDATE stock SET sold = MAX(sold - (SELECT qty FROM order_stock os WHERE os.order_id = ?1 AND os.item_id = stock.item_id AND os.day = stock.day), 0)
      WHERE ${gone} AND EXISTS (SELECT 1 FROM order_stock os WHERE os.order_id = ?1 AND os.item_id = stock.item_id AND os.day = stock.day)`).bind(orderId),
    db.prepare(`DELETE FROM order_stock WHERE order_id = ?1 AND ${gone}`).bind(orderId),
  ];
}

// A late payment on an expired order: hold its stock again. Never fails (the money is already in),
// but never goes over the limit either.
export function reholdStmts(db, order, prices) {
  const stmts = [];
  for (const l of order.lines) {
    const cap = prices.get(l.id)?.daily_limit;
    if (cap === null || cap === undefined) continue;
    stmts.push(
      db.prepare(`INSERT INTO stock (item_id, day, cap, sold) VALUES (?1, ?2, ?3, MIN(?4, ?3))
        ON CONFLICT (item_id, day) DO UPDATE SET sold = MIN(sold + excluded.sold, cap)`).bind(l.id, order.slot_date, cap, l.qty),
      db.prepare("INSERT OR IGNORE INTO order_stock (order_id, item_id, day, qty) VALUES (?1, ?2, ?3, ?4)").bind(order.id, l.id, order.slot_date, l.qty),
    );
  }
  return stmts;
}

// How many are left of each limited product on a day: Map(id -> left)
export async function leftOn(db, day, prices) {
  const { results } = await db.prepare("SELECT item_id, sold FROM stock WHERE day = ?1").bind(day).all();
  const sold = new Map(results.map((r) => [r.item_id, r.sold]));
  const out = new Map();
  for (const [id, p] of prices) if (p.daily_limit !== null && p.daily_limit !== undefined) out.set(id, Math.max(p.daily_limit - (sold.get(id) || 0), 0));
  return out;
}

// After an order failed on stock, say which product ran short.
export async function shortage(db, lines, day, prices) {
  const left = await leftOn(db, day, prices);
  const short = lines.find((l) => left.has(l.id) && left.get(l.id) < l.qty);
  if (!short) return null;
  const n = left.get(short.id);
  return n ? `Only ${n} ${short.name} left for that day` : `${short.name} is sold out for that day`;
}
