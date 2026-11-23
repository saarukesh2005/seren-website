// Dashboard logins. The owner uses ADMIN_PASSWORD (a Cloudflare secret); staff have their own name + password.
// Sessions are signed, HttpOnly cookies that can be cancelled ("log out everyone", or removing a staff member).
import { HttpError } from "./http.js";
import { base64url, randomToken, safeEqual } from "./util.js";

const COOKIE = "seren_admin";
const SESSION_SECONDS = 12 * 60 * 60;

// What each role may do. The owner may do everything.
export const PERMS = Object.freeze({
  manager: ["orders", "counter", "tables", "kitchen", "menu", "refund", "customers", "offers", "reports", "stock", "cash"],
  cashier: ["orders", "counter", "tables", "kitchen", "cash"],
  kitchen: ["kitchen"],
});
export const ROLE_NAMES = Object.freeze({ owner: "Owner", manager: "Manager", cashier: "Cashier", kitchen: "Kitchen" });

export const can = (user, perm) => Boolean(user) && (user.role === "owner" || (PERMS[user.role] || []).includes(perm));

export function need(user, perm) {
  if (!can(user, perm)) throw new HttpError(403, "Your login can't do that. Ask the owner.");
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return base64url(new Uint8Array(sig));
}

export function requireSecrets(env) {
  if (!env.ADMIN_PASSWORD || String(env.ADMIN_PASSWORD).length < 10) throw new HttpError(503, "ADMIN_PASSWORD is not set up (10+ characters)");
  if (!env.SESSION_SECRET || String(env.SESSION_SECRET).length < 32) throw new HttpError(503, "SESSION_SECRET is not set up");
}

// Staff passwords: salted and keyed with the server secret, so a copy of the database alone can't be cracked.
export const hashPassword = (env, password, salt) => hmac(env.SESSION_SECRET, `pw|${salt}|${password}`);

async function authRow(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'auth'").first();
  return row ? JSON.parse(row.value) : {};
}
async function saveAuthRow(db, value) {
  await db.prepare("INSERT INTO settings (key, value) VALUES ('auth', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(value)).run();
}
const ownerEpoch = async (db) => Number((await authRow(db)).ownerEpoch) || 1;

export async function bumpOwnerEpoch(db) {
  const row = await authRow(db);
  await saveAuthRow(db, { ...row, ownerEpoch: (Number(row.ownerEpoch) || 1) + 1 });
}

// The owner's approval PIN (for voids, discounts, refunds at the counter).
export async function setOwnerPin(env, db, pin) {
  checkPin(pin);
  const salt = randomToken(12);
  await saveAuthRow(db, { ...(await authRow(db)), ownerPinSalt: salt, ownerPinHash: await hashPin(env, pin, salt) });
}

export function checkPin(pin) {
  if (typeof pin !== "string" || !/^\d{6,8}$/.test(pin)) throw new HttpError(400, "An approval PIN is 6 to 8 digits");
  if (/^(\d)\1+$/.test(pin) || "01234567890".includes(pin) || "09876543210".includes(pin) || /^(\d\d)\1+$/.test(pin)) throw new HttpError(400, "That PIN is too easy to guess");
}
export const hashPin = (env, pin, salt) => hmac(env.SESSION_SECRET, `pin|${salt}|${pin}`);

// Returns { id, name, role, version } or null.
export async function checkLogin(env, db, name, password) {
  requireSecrets(env);
  const who = String(name ?? "").trim();
  const pw = String(password ?? "");
  if (!who || who.toLowerCase() === "owner") {
    return (await safeEqual(pw, env.ADMIN_PASSWORD)) ? { id: 0, name: "Owner", role: "owner", version: await ownerEpoch(db) } : null;
  }
  const row = await db.prepare("SELECT id, name, role, pass_hash, salt, active, session_version FROM staff WHERE name = ?1").bind(who).first();
  // compare against a dummy hash when the name doesn't exist, so timing doesn't reveal staff names
  const expected = row ? row.pass_hash : await hashPassword(env, "x", "no-such-user");
  const ok = await safeEqual(await hashPassword(env, pw, row ? row.salt : "no-such-user"), expected);
  if (!row || !row.active || !ok) return null;
  return { id: row.id, name: row.name, role: row.role, version: row.session_version };
}

// Owner sessions are tied to the current ADMIN_PASSWORD: changing the password logs the owner out everywhere.
const ownerMark = async (env, id) => (id === "0" ? `.${(await hmac(env.SESSION_SECRET, `ownerpw|${env.ADMIN_PASSWORD}`)).slice(0, 16)}` : "");
const signature = async (env, body, id) => hmac(env.SESSION_SECRET, `admin.${body}${await ownerMark(env, id)}`);

// A new login: a random session id saved in the database, so logging out really ends it.
export async function sessionCookie(env, db, user) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const sid = randomToken(18);
  await db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(sid, user.id, exp, new Date().toISOString()).run();
  const body = `${exp}.${user.id}.${user.version}.${sid}`;
  return `${COOKIE}=${body}.${await signature(env, body, String(user.id))}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

function cookieParts(request) {
  const raw = (request.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const parts = raw.slice(COOKIE.length + 1).split(".");
  if (parts.length !== 5 || !parts.slice(0, 3).every((p) => /^\d{1,12}$/.test(p)) || !/^[A-Za-z0-9_-]{16,40}$/.test(parts[3])) return null;
  return parts;
}

export async function endSession(request, db) {
  const parts = cookieParts(request);
  if (parts) await db.prepare("DELETE FROM sessions WHERE id = ?1").bind(parts[3]).run();
}

// The logged-in person, or null. Checks the signature, the expiry and that the session still exists.
export async function currentUser(request, env, db) {
  if (!env.SESSION_SECRET) return null;
  const parts = cookieParts(request);
  if (!parts) return null;
  const [exp, id, version, sid, sig] = parts;
  if (Number(exp) < Date.now() / 1000) return null;
  if (!(await safeEqual(sig, await signature(env, `${exp}.${id}.${version}.${sid}`, id)))) return null;
  const live = await db.prepare("SELECT 1 FROM sessions WHERE id = ?1 AND user_id = ?2 AND expires_at > ?3").bind(sid, Number(id), Math.floor(Date.now() / 1000)).first();
  if (!live) return null;
  if (id === "0") return Number(version) === (await ownerEpoch(db)) ? { id: 0, name: "Owner", role: "owner" } : null;
  const row = await db.prepare("SELECT id, name, role, active, session_version FROM staff WHERE id = ?1").bind(Number(id)).first();
  if (!row || !row.active || row.session_version !== Number(version)) return null;
  return { id: row.id, name: row.name, role: row.role };
}

/* ---------- manager approval ---------- */
export const canApprove = (user) => user.role === "owner" || user.role === "manager";

// Checks a manager's (or the owner's) name + approval PIN. Passwords are never accepted here.
async function approverOk(env, db, name, pin) {
  if (name.toLowerCase() === "owner") {
    const a = await authRow(db);
    return a.ownerPinHash && (await safeEqual(await hashPin(env, pin, a.ownerPinSalt), a.ownerPinHash)) ? "Owner" : null;
  }
  const row = await db.prepare("SELECT name, role, active, pin_hash, pin_salt FROM staff WHERE name = ?1").bind(name).first();
  if (!row || !row.active || row.role !== "manager" || !row.pin_hash) return null;
  return (await safeEqual(await hashPin(env, pin, row.pin_salt), row.pin_hash)) ? row.name : null;
}

const APPROVAL_TRIES = { perStaff: 5, perApprover: 10 }; // per 15 minutes / per hour

/**
 * Some actions need a manager: cancelling food already sent to the kitchen, big discounts, spending many points,
 * confirming an online order as cash. Managers and the owner pass straight through; anyone else sends
 * body.approval = { name, pin } typed by the manager standing next to them. Returns the approver's name.
 * Every try is counted before the PIN is checked (per staff member and per approver), so PINs can't be guessed.
 */
export async function approval(env, db, user, body, what, { attemptOver, clearAttempts }) {
  if (canApprove(user)) return user.name;
  const a = body && typeof body.approval === "object" && body.approval ? body.approval : {};
  const name = String(a.name || "").trim().slice(0, 30);
  const pin = String(a.pin || "").slice(0, 20);
  if (!name || !pin) throw new HttpError(403, `${what} needs a manager's OK`, { needApproval: true, what });
  const mine = `approve:${user.id}`;
  const theirs = `approve:to:${name.toLowerCase()}`;
  if ((await attemptOver(db, mine, APPROVAL_TRIES.perStaff, 900)) | (await attemptOver(db, theirs, APPROVAL_TRIES.perApprover, 3600))) {
    throw new HttpError(429, "Too many PIN tries. Wait 15 minutes.");
  }
  const ok = /^\d{6,8}$/.test(pin) ? await approverOk(env, db, name, pin) : null;
  if (!ok) throw new HttpError(403, "Wrong manager name or PIN", { needApproval: true, what });
  await clearAttempts(db, mine);
  return ok;
}

// Dashboard requests must come from the dashboard itself (blocks cross-site form posts).
export function checkSameOrigin(request) {
  const origin = request.headers.get("Origin");
  const self = new URL(request.url).origin;
  if (request.method !== "GET" && (origin !== self || request.headers.get("X-Seren") !== "1")) {
    throw new HttpError(403, "Request blocked");
  }
}
