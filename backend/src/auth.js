// Dashboard logins. The owner uses ADMIN_PASSWORD (a Cloudflare secret); staff have their own name + password.
// Sessions are signed, HttpOnly cookies that can be cancelled ("log out everyone", or removing a staff member).
import { HttpError } from "./http.js";
import { base64url, safeEqual } from "./util.js";

const COOKIE = "seren_admin";
const SESSION_SECONDS = 12 * 60 * 60;

// What each role may do. The owner may do everything.
export const PERMS = Object.freeze({
  manager: ["orders", "counter", "tables", "kitchen", "menu", "refund", "customers", "offers", "reports"],
  cashier: ["orders", "counter", "tables", "kitchen"],
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

async function ownerEpoch(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'auth'").first();
  return row ? Number(JSON.parse(row.value).ownerEpoch) || 1 : 1;
}

export async function bumpOwnerEpoch(db) {
  const next = (await ownerEpoch(db)) + 1;
  await db.prepare("INSERT INTO settings (key, value) VALUES ('auth', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify({ ownerEpoch: next })).run();
}

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

export async function sessionCookie(env, user) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const body = `${exp}.${user.id}.${user.version}`;
  return `${COOKIE}=${body}.${await hmac(env.SESSION_SECRET, `admin.${body}`)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// The logged-in person, or null. Checks the signature, the expiry and that the session wasn't cancelled.
export async function currentUser(request, env, db) {
  if (!env.SESSION_SECRET) return null;
  const raw = (request.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const parts = raw.slice(COOKIE.length + 1).split(".");
  if (parts.length !== 4 || !parts.slice(0, 3).every((p) => /^\d+$/.test(p))) return null;
  const [exp, id, version, sig] = parts;
  if (Number(exp) < Date.now() / 1000) return null;
  if (!(await safeEqual(sig, await hmac(env.SESSION_SECRET, `admin.${exp}.${id}.${version}`)))) return null;
  if (id === "0") return Number(version) === (await ownerEpoch(db)) ? { id: 0, name: "Owner", role: "owner" } : null;
  const row = await db.prepare("SELECT id, name, role, active, session_version FROM staff WHERE id = ?1").bind(Number(id)).first();
  if (!row || !row.active || row.session_version !== Number(version)) return null;
  return { id: row.id, name: row.name, role: row.role };
}

// Dashboard requests must come from the dashboard itself (blocks cross-site form posts).
export function checkSameOrigin(request) {
  const origin = request.headers.get("Origin");
  const self = new URL(request.url).origin;
  if (request.method !== "GET" && (origin !== self || request.headers.get("X-Seren") !== "1")) {
    throw new HttpError(403, "Request blocked");
  }
}
