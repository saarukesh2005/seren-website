import { TABLE } from "./settings.js";

// Checks what a customer types at checkout. Returns { value } or { error } with a friendly message.

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function checkCustomer(input, settings) {
  const body = input && typeof input === "object" ? input : {};
  const name = clean(body.name, 60);
  const phone = String(body.phone ?? "").replace(/[\s-]/g, "").replace(/^(\+?91|0)(?=\d{10}$)/, "");
  const mode = body.mode;
  const notes = clean(body.notes, 300);

  if (name.length < 2) return { error: "Please tell us your name" };
  if (!["pickup", "delivery", "dinein"].includes(mode)) return { error: "Choose dine-in, pickup or delivery" };
  // phone is optional at a table (the guest is right there), required otherwise
  if (!(mode === "dinein" && phone === "") && !/^[6-9]\d{9}$/.test(phone)) return { error: "Please enter a 10-digit mobile number" };
  if (mode === "pickup" && !settings.pickup) return { error: "Pickup isn't available right now" };
  if (mode === "delivery" && !settings.delivery) return { error: "Delivery isn't available right now" };
  if (mode === "dinein" && !settings.dineIn) return { error: "Dine-in ordering isn't available right now" };

  let table = "";
  if (mode === "dinein") {
    table = clean(body.table, 10);
    if (!TABLE.test(table)) return { error: "Please enter your table number" };
    const allowed = settings.dineInTables.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(table.toLowerCase())) return { error: "We couldn't find that table. Please check the number on your table." };
  }

  let address = "";
  let pincode = "";
  if (mode === "delivery") {
    address = clean(body.address, 300);
    pincode = String(body.pincode ?? "").trim();
    if (address.length < 10) return { error: "Please enter your full delivery address" };
    if (!/^\d{6}$/.test(pincode)) return { error: "Please enter a 6-digit pincode" };
    const allowed = settings.deliveryPincodes.split(",").map((p) => p.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(pincode)) return { error: "Sorry, we don't deliver to that pincode yet. Pickup is available." };
  }
  return { value: { name, phone, mode, table, address, pincode, notes } };
}

export const ORDER_CODE = /^SRN-[23456789A-HJKMNP-Z]{6}$/;
export const TOKEN = /^[A-Za-z0-9_-]{32}$/;
