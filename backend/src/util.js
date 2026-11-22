// Small shared helpers: escaping, random ids, hashing, India time.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// No 0/O/1/I/L so order numbers are easy to read out over the phone.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function randomCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export function randomToken(bytes = 24) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(raw);
}

export function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Compares two strings in constant time (after hashing, so lengths don't leak).
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256hex(String(a)), sha256hex(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const IST_OFFSET_MIN = 330;

// The date and time in India for a given instant.
export function istParts(date = new Date()) {
  const t = new Date(date.getTime() + IST_OFFSET_MIN * 60000);
  const iso = t.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), weekday: t.getUTCDay(), minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

export function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const fromMinutes = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

// Indian financial year label for a date: 2026-11-20 -> "2627" (April 2026 to March 2027).
export function financialYear(ymd) {
  const [y, m] = ymd.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, "0")}${String((start + 1) % 100).padStart(2, "0")}`;
}

export const rupees = (paise) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
