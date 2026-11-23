// The live product list: the website's products (src/catalog.js) plus edits and new products from the dashboard.
import { CATALOG, CATEGORIES } from "./catalog.js";
import { HttpError } from "./http.js";
import { randomCode } from "./util.js";

const now = () => new Date().toISOString();
const text = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const MAX_IMAGE_BYTES = 400 * 1024;
const MAX_IMAGES = 500;
const MIME = { "image/webp": [0x52, 0x49, 0x46, 0x46], "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47] };

/** Every product with dashboard edits applied: { id, name, category, img, photo, veg, description, hidden, custom } */
export async function loadCatalog(db) {
  const { results } = await db.prepare("SELECT id, category, name, description, img, veg, hidden, custom, name_ta, description_ta, options, tax FROM products").all();
  const edits = new Map(results.map((r) => [r.id, r]));
  const base = CATALOG.map((c) => {
    const e = edits.get(c.id);
    return e
      ? { ...c, name: e.name, description: e.description, photo: e.img, veg: e.veg === null ? c.veg : Boolean(e.veg), hidden: Boolean(e.hidden), custom: false, edited: true, nameTa: e.name_ta, descriptionTa: e.description_ta, options: readOptions(e.options), tax: readTax(e.tax) }
      : { ...c, description: "", photo: null, hidden: false, custom: false, edited: false, nameTa: "", descriptionTa: "", options: [], tax: null };
  });
  const extra = results.filter((r) => r.custom).map((r) => ({
    id: r.id, name: r.name, category: r.category, img: null, photo: r.img, veg: r.veg === null ? null : Boolean(r.veg),
    description: r.description, hidden: Boolean(r.hidden), custom: true, edited: true, nameTa: r.name_ta, descriptionTa: r.description_ta, options: readOptions(r.options), tax: readTax(r.tax),
  }));
  return [...base, ...extra];
}

// An item's own GST, or null to use its section's.
function readTax(raw) {
  try { const v = JSON.parse(raw || "null"); return v && typeof v === "object" && Number.isFinite(Number(v.rate)) ? { hsn: String(v.hsn || ""), rate: Number(v.rate) } : null; } catch { return null; }
}
const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];

function readOptions(raw) {
  try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 18);

/**
 * Item options as the owner types them: [{ name: "Size", pick: "one", required: true, choices: [{ name: "1 kg", price: 60000 }] }].
 * Ids come from the names, so a saved bag still matches after small edits elsewhere.
 */
export function checkOptions(raw) {
  if (!Array.isArray(raw) || raw.length > 5) throw new HttpError(400, "Up to 5 option groups per item");
  const groups = [];
  for (const g of raw) {
    const name = text(g?.name, 30);
    const id = slug(name);
    if (!id || groups.some((x) => x.id === id)) throw new HttpError(400, "Each option group needs its own name (like Size or Add-ons)");
    if (!Array.isArray(g.choices) || !g.choices.length || g.choices.length > 12) throw new HttpError(400, `${name}: 1 to 12 choices`);
    const choices = [];
    for (const ch of g.choices) {
      const cname = text(ch?.name, 30);
      const cid = slug(cname);
      const price = Number(ch?.price ?? 0);
      if (!cid || choices.some((x) => x.id === cid)) throw new HttpError(400, `${name}: each choice needs its own name`);
      if (!Number.isInteger(price) || price < 0 || price > 10000000) throw new HttpError(400, `${name} · ${cname}: extra price must be 0 or more`);
      choices.push({ id: cid, name: cname, price });
    }
    groups.push({ id, name, pick: g.pick === "many" ? "many" : "one", required: g.pick !== "many" && Boolean(g.required), choices });
  }
  return groups;
}

// Only products customers can order (not hidden).
export const orderable = (catalog) => new Map(catalog.filter((c) => !c.hidden).map((c) => [c.id, c]));

function checkProduct(body, { requireAll }) {
  const out = {};
  if (requireAll || body.name !== undefined) {
    out.name = text(body.name, 80);
    if (out.name.length < 2) throw new HttpError(400, "Product name: at least 2 characters");
  }
  if (requireAll || body.category !== undefined) {
    if (!Object.hasOwn(CATEGORIES, String(body.category))) throw new HttpError(400, "Pick a category");
    out.category = body.category;
  }
  if (body.description !== undefined) out.description = text(body.description, 240);
  if (body.nameTa !== undefined) out.nameTa = text(body.nameTa, 80);
  if (body.descriptionTa !== undefined) out.descriptionTa = text(body.descriptionTa, 240);
  if (body.veg !== undefined) out.veg = body.veg === null ? null : body.veg ? 1 : 0;
  if (body.hidden !== undefined) out.hidden = body.hidden ? 1 : 0;
  if (body.options !== undefined) out.options = JSON.stringify(checkOptions(body.options));
  if (body.tax !== undefined) {
    if (body.tax === null) out.tax = "";
    else {
      const hsn = text(body.tax && body.tax.hsn, 8);
      const rate = Number(body.tax && body.tax.rate);
      if (!/^(\d{4}|\d{6}|\d{8})$/.test(hsn)) throw new HttpError(400, "Item GST: the HSN / SAC code is 4, 6 or 8 digits");
      if (!GST_RATES.includes(rate)) throw new HttpError(400, `Item GST: the rate must be one of ${GST_RATES.join(", ")}%`);
      out.tax = JSON.stringify({ hsn, rate });
    }
  }
  if (body.img !== undefined) {
    if (body.img !== null && !/^[A-Z0-9]{12}$/.test(String(body.img))) throw new HttpError(400, "Unknown photo");
    out.img = body.img;
  }
  return out;
}

// Save changes to an existing product (from the website or added in the dashboard).
export async function editProduct(db, catalog, id, body) {
  const current = catalog.find((c) => c.id === id);
  if (!current) throw new HttpError(404, "Unknown product");
  const p = { name: current.name, category: current.category, description: current.description, img: current.photo, veg: current.veg === null ? null : current.veg ? 1 : 0, hidden: current.hidden ? 1 : 0,
    nameTa: current.nameTa || "", descriptionTa: current.descriptionTa || "", options: JSON.stringify(current.options || []), tax: current.tax ? JSON.stringify(current.tax) : "", ...checkProduct(body, { requireAll: false }) };
  if (!current.custom) p.category = current.category; // website products stay in their section
  await db.prepare(`INSERT INTO products (id, category, name, description, img, veg, hidden, custom, updated_at, name_ta, description_ta, options, tax) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    ON CONFLICT (id) DO UPDATE SET category = excluded.category, name = excluded.name, description = excluded.description, img = excluded.img,
    veg = excluded.veg, hidden = excluded.hidden, updated_at = excluded.updated_at, name_ta = excluded.name_ta, description_ta = excluded.description_ta, options = excluded.options, tax = excluded.tax`)
    .bind(id, p.category, p.name, p.description, p.img ?? null, p.veg, p.hidden, current.custom ? 1 : 0, now(), p.nameTa, p.descriptionTa, p.options, p.tax).run();
  return p.name;
}

export async function addProduct(db, body) {
  const p = { description: "", img: null, veg: null, hidden: 0, nameTa: "", descriptionTa: "", options: "[]", tax: "", ...checkProduct(body, { requireAll: true }) };
  const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
  const id = `x-${slug}-${randomCode(4).toLowerCase()}`;
  await db.prepare("INSERT INTO products (id, category, name, description, img, veg, hidden, custom, updated_at, name_ta, description_ta, options, tax) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?11, ?12)")
    .bind(id, p.category, p.name, p.description, p.img, p.veg, p.hidden, now(), p.nameTa, p.descriptionTa, p.options, p.tax).run();
  return { id, name: p.name };
}

// Photo upload: the dashboard shrinks the picture first; here we check it really is an image.
export async function saveImage(db, dataUrl) {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw new HttpError(400, "Upload a JPG, PNG or WebP photo");
  let bytes;
  try { bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); } catch { throw new HttpError(400, "That photo didn't upload properly. Try again."); }
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "Photo too large even after shrinking (max 400 KB)");
  if (!MIME[m[1]].every((b, i) => bytes[i] === b)) throw new HttpError(400, "That file isn't a real image");
  // photos no product uses any more are cleared out first, and the total stays capped (the free database is 5 GB)
  await db.prepare("DELETE FROM images WHERE created_at < ?1 AND key NOT IN (SELECT img FROM products WHERE img IS NOT NULL)")
    .bind(new Date(Date.now() - 86400000).toISOString()).run();
  const count = await db.prepare("SELECT COUNT(*) AS n FROM images").first();
  if (count.n >= MAX_IMAGES) throw new HttpError(409, `Photo limit reached (${MAX_IMAGES}). Remove unused photos first.`);
  const key = randomCode(12);
  await db.prepare("INSERT INTO images (key, mime, data, created_at) VALUES (?1, ?2, ?3, ?4)").bind(key, m[1], bytes, now()).run();
  return key;
}

export async function imageResponse(db, key) {
  if (!/^[A-Z0-9]{12}$/.test(key)) return new Response("Not found", { status: 404 });
  const row = await db.prepare("SELECT mime, data FROM images WHERE key = ?1").bind(key).first();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(row.data), {
    headers: {
      "Content-Type": row.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
