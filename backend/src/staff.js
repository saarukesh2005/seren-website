// Staff accounts and the activity log (who did what, when).
import { bumpOwnerEpoch, hashPassword } from "./auth.js";
import { HttpError } from "./http.js";
import { randomToken } from "./util.js";

const now = () => new Date().toISOString();
const NAME = /^[\p{L}\p{N} .'-]{2,30}$/u;
const ROLES = ["manager", "cashier", "kitchen"];

export async function audit(db, user, action, detail = "") {
  await db.prepare("INSERT INTO audit (at, actor, action, detail) VALUES (?1, ?2, ?3, ?4)")
    .bind(now(), user ? user.name : "system", action, String(detail).slice(0, 300)).run();
}

export async function listAudit(db, { before, limit = 100 } = {}) {
  const { results } = before
    ? await db.prepare("SELECT id, at, actor, action, detail FROM audit WHERE id < ?1 ORDER BY id DESC LIMIT ?2").bind(before, limit).all()
    : await db.prepare("SELECT id, at, actor, action, detail FROM audit ORDER BY id DESC LIMIT ?1").bind(limit).all();
  return results;
}

export async function listStaff(db) {
  const { results } = await db.prepare("SELECT id, name, role, active, created_at FROM staff ORDER BY active DESC, name").all();
  return results;
}

function checkPassword(pw) {
  if (typeof pw !== "string" || pw.length < 8 || pw.length > 100) throw new HttpError(400, "Passwords need at least 8 characters");
}

export async function addStaff(env, db, body) {
  const name = String(body.name || "").trim();
  if (!NAME.test(name) || name.toLowerCase() === "owner") throw new HttpError(400, "Name: 2–30 letters (not \"owner\")");
  if (!ROLES.includes(body.role)) throw new HttpError(400, "Role must be manager, cashier or kitchen");
  checkPassword(body.password);
  const salt = randomToken(12);
  try {
    await db.prepare("INSERT INTO staff (name, role, pass_hash, salt, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(name, body.role, await hashPassword(env, body.password, salt), salt, now()).run();
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new HttpError(409, "Someone already has that name");
    throw e;
  }
  return name;
}

// Change role, switch on/off, or set a new password. Any change logs that person out everywhere.
export async function updateStaff(env, db, id, body) {
  const row = await db.prepare("SELECT id, name FROM staff WHERE id = ?1").bind(id).first();
  if (!row) throw new HttpError(404, "Staff member not found");
  const sets = ["session_version = session_version + 1"];
  const args = [];
  const add = (sql, v) => { args.push(v); sets.push(`${sql} = ?${args.length}`); };
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) throw new HttpError(400, "Role must be manager, cashier or kitchen");
    add("role", body.role);
  }
  if (body.active !== undefined) add("active", body.active ? 1 : 0);
  if (body.password !== undefined) {
    checkPassword(body.password);
    const salt = randomToken(12);
    add("salt", salt);
    add("pass_hash", await hashPassword(env, body.password, salt));
  }
  args.push(id);
  await db.prepare(`UPDATE staff SET ${sets.join(", ")} WHERE id = ?${args.length}`).bind(...args).run();
  return row.name;
}

export async function logoutEveryone(db) {
  await bumpOwnerEpoch(db);
  await db.prepare("UPDATE staff SET session_version = session_version + 1").run();
}
