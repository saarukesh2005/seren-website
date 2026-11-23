// Dashboard API: staff, activity log, customers, coupons, feedback and WhatsApp broadcast lists.
import { setOwnerPin } from "./auth.js";
import { HttpError, json, readJson } from "./http.js";
import { checkCouponInput, favourites, listCoupons, listCustomers, saveCoupon, upcomingBirthdays, updateCustomer } from "./offers.js";
import { addStaff, audit, listAudit, listStaff, logoutEveryone, updateStaff } from "./staff.js";
import { waMeLink } from "./whatsapp.js";

/* ---------- staff (owner only) ---------- */
export const staff = async ({ env }) => json({ staff: await listStaff(env.DB) });

export async function createStaff({ env, request, user }) {
  const name = await addStaff(env, env.DB, await readJson(request));
  await audit(env.DB, user, "staff added", name);
  return json({ ok: true }, 201);
}

export async function changeStaff({ env, params, request, user }) {
  const body = await readJson(request);
  const name = await updateStaff(env, env.DB, Number(params[0]), body);
  const what = [body.role && `role ${body.role}`, body.active !== undefined && (body.active ? "switched on" : "switched off"), body.password && "new password", body.pin !== undefined && (body.pin ? "new approval PIN" : "PIN removed")].filter(Boolean).join(", ");
  await audit(env.DB, user, "staff changed", `${name}: ${what}`, env);
  return json({ ok: true });
}

// The owner's own approval PIN.
export async function ownerPin({ env, request, user }) {
  const body = await readJson(request);
  await setOwnerPin(env, env.DB, String(body.pin || ""));
  await audit(env.DB, user, "approval PIN changed", "Owner");
  return json({ ok: true });
}

export async function logoutAll({ env, user }) {
  await logoutEveryone(env.DB);
  await audit(env.DB, user, "logged everyone out");
  return json({ ok: true });
}

export async function activity({ env, url }) {
  return json({ log: await listAudit(env.DB, { before: Number(url.searchParams.get("before")) || undefined }) });
}

/* ---------- customers ---------- */
export async function customers({ env, url }) {
  const list = await listCustomers(env.DB, { q: (url.searchParams.get("q") || "").slice(0, 40), optIn: url.searchParams.get("optIn") === "1" });
  const fav = await favourites(env.DB, list.slice(0, 100).map((c) => c.phone));
  return json({ customers: list.map((c) => ({ ...c, favourite: fav.get(c.phone) || "" })) });
}

// For the counter: a customer's name and points balance, looked up by mobile number.
export async function points({ env, params }) {
  const c = await env.DB.prepare("SELECT name, points FROM customers WHERE phone = ?1").bind(params[0]).first();
  return json({ customer: c || null });
}

export async function birthdays({ env }) {
  return json({ birthdays: await upcomingBirthdays(env.DB, 7) });
}

export async function changeCustomer({ env, params, request, user }) {
  const body = await readJson(request);
  await updateCustomer(env.DB, params[0], body);
  if (body.opt_in !== undefined) await audit(env.DB, user, body.opt_in ? "customer opted in" : "customer opted out", params[0]);
  return json({ ok: true });
}

// WhatsApp links for every customer who agreed to offers. The owner sends them one by one (free).
export async function broadcast({ env, request, user }) {
  const body = await readJson(request);
  const text = String(body.text || "").trim().slice(0, 1000);
  if (text.length < 5) throw new HttpError(400, "Write the message first");
  const list = await listCustomers(env.DB, { optIn: true, limit: 1000 });
  await audit(env.DB, user, "offer message prepared", `${list.length} customers`);
  return json({
    links: list.map((c) => ({ phone: c.phone, name: c.name, url: waMeLink(c.phone, text.replace(/\{name\}/g, (c.name || "").split(" ")[0] || "there") + "\n\nReply STOP to stop offers.") })),
  });
}

/* ---------- coupons ---------- */
export const coupons = async ({ env }) => json({ coupons: await listCoupons(env.DB) });

export async function createCoupon({ env, request, user }) {
  const c = checkCouponInput(await readJson(request), null);
  await saveCoupon(env.DB, c, true);
  await audit(env.DB, user, "coupon added", `${c.code} ${c.kind === "percent" ? `${c.value}%` : `₹${c.value / 100}`}`, env);
  return json({ ok: true }, 201);
}

export async function changeCoupon({ env, params, request, user }) {
  const existing = await env.DB.prepare("SELECT * FROM coupons WHERE code = ?1").bind(params[0]).first();
  if (!existing) throw new HttpError(404, "Coupon not found");
  const c = checkCouponInput(await readJson(request), existing);
  await saveCoupon(env.DB, c, false);
  await audit(env.DB, user, "coupon changed", c.code, env);
  return json({ ok: true });
}

/* ---------- feedback ---------- */
export async function feedbackList({ env }) {
  const { results } = await env.DB.prepare(`SELECT f.stars, f.comment, f.at, o.code, o.customer_name, o.customer_phone FROM feedback f
    JOIN orders o ON o.id = f.order_id ORDER BY f.at DESC LIMIT 200`).all();
  const avg = await env.DB.prepare("SELECT COUNT(*) AS n, AVG(stars) AS avg FROM feedback").first();
  return json({ feedback: results, count: avg.n, average: avg.avg ? Number(avg.avg.toFixed(1)) : null });
}
