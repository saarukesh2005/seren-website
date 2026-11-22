import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCart, priceOrder, summarise, taxLine } from "../src/pricing.js";
import { checkSlot, slotDays } from "../src/schedule.js";
import { DEFAULT_SETTINGS, checkSettings, publicSettings } from "../src/settings.js";
import { checkUtr, upiLink } from "../src/upi.js";
import { checkCustomer, ORDER_CODE, TOKEN } from "../src/validate.js";
import { canConfirmPayment, canMove } from "../src/status.js";
import { esc, financialYear, randomCode, randomToken, rupees } from "../src/util.js";

const settings = (over = {}) => checkSettings({ ...DEFAULT_SETTINGS, ...over }).value;
const catalog = new Map([
  ["bomb-vanilla", { name: "Vanilla bombolone", category: "bomboloni" }],
  ["ent-hazelnut", { name: "Hazelnut Symphony", category: "entremets" }],
]);
const prices = new Map([
  ["bomb-vanilla", { price: 18000, unit: "per piece", available: 1 }],
  ["ent-hazelnut", { price: 210000, unit: "6-inch", available: 1 }],
]);

test("GST inside the price splits back into taxable value + tax", () => {
  assert.deepEqual(taxLine(10500, 5, true), { taxable: 10000, tax: 500, gross: 10500 });
  assert.deepEqual(taxLine(10000, 5, false), { taxable: 10000, tax: 500, gross: 10500 });
  assert.deepEqual(taxLine(999, 0, true), { taxable: 999, tax: 0, gross: 999 });
});

test("tax summary always splits into CGST + SGST that add up", () => {
  const [row] = summarise([{ rate: 5, taxable: 1000, tax: 51 }]);
  assert.equal(row.cgst + row.sgst, 51);
});

test("cart: merges duplicate products and rejects bad quantities", () => {
  assert.deepEqual(checkCart([{ id: "bomb-vanilla", qty: 2 }, { id: "bomb-vanilla", qty: 1 }]).value, [{ id: "bomb-vanilla", qty: 3 }]);
  assert.ok(checkCart([]).error);
  assert.ok(checkCart([{ id: "bomb-vanilla", qty: 0 }]).error);
  assert.ok(checkCart([{ id: "bomb-vanilla", qty: 1.5 }]).error);
  assert.ok(checkCart([{ id: "<script>", qty: 1 }]).error);
});

test("prices come from the server, not the browser", () => {
  const r = priceOrder([{ id: "bomb-vanilla", qty: 2, price: 1 }], catalog, prices, settings(), "pickup").value;
  assert.equal(r.total, 36000);
  assert.equal(r.lines[0].tax, 0, "no GSTIN means no GST charged");
});

test("unpriced or sold-out products cannot be ordered", () => {
  const sold = new Map([...prices, ["bomb-vanilla", { price: 18000, unit: "", available: 0 }]]);
  assert.match(priceOrder([{ id: "bomb-vanilla", qty: 1 }], catalog, sold, settings(), "pickup").error, /isn't available/);
  assert.ok(priceOrder([{ id: "nope", qty: 1 }], catalog, prices, settings(), "pickup").error);
});

test("delivery fee, free-delivery threshold and minimum order", () => {
  const s = settings({ deliveryFee: 5000, freeDeliveryAbove: 100000, minOrder: 20000 });
  assert.equal(priceOrder([{ id: "bomb-vanilla", qty: 1 }], catalog, prices, s, "delivery").error, "minOrder");
  assert.equal(priceOrder([{ id: "bomb-vanilla", qty: 2 }], catalog, prices, s, "delivery").value.total, 41000);
  assert.equal(priceOrder([{ id: "ent-hazelnut", qty: 1 }], catalog, prices, s, "delivery").value.deliveryFee, 0);
  assert.equal(priceOrder([{ id: "bomb-vanilla", qty: 1 }], catalog, prices, s, "pickup").value.total, 18000);
});

test("with a GSTIN, each category's rate is applied", () => {
  const s = settings({ gstin: "33ABCDE1234F1Z5", legalName: "Seren Foods", tax: { ...DEFAULT_SETTINGS.tax, bomboloni: { hsn: "1905", rate: 5 } } });
  const r = priceOrder([{ id: "bomb-vanilla", qty: 1 }], catalog, prices, s, "pickup").value;
  assert.equal(r.total, 18000);
  assert.equal(r.lines[0].taxable + r.lines[0].tax, 18000);
  assert.equal(r.taxSummary[0].rate, 5);
});

test("settings: rejects a bad GSTIN, UPI ID, hours and tax rate", () => {
  assert.ok(checkSettings({ ...DEFAULT_SETTINGS, gstin: "12345" }).error);
  assert.ok(checkSettings({ ...DEFAULT_SETTINGS, upiId: "not a upi" }).error);
  assert.ok(checkSettings({ ...DEFAULT_SETTINGS, openTime: "23:00", closeTime: "10:00" }).error);
  assert.ok(checkSettings({ ...DEFAULT_SETTINGS, tax: { bomboloni: { hsn: "1905", rate: 7 } } }).error);
  assert.ok(checkSettings({ ...DEFAULT_SETTINGS, deliveryPincodes: "600001, 12" }).error);
  assert.equal(checkSettings({ ...DEFAULT_SETTINGS, upiId: "seren@okhdfcbank" }).value.upiId, "seren@okhdfcbank");
});

test("public settings never expose the UPI ID, GSTIN or pincode list", () => {
  const p = publicSettings(settings({ upiId: "seren@okhdfcbank", acceptingOrders: true, deliveryPincodes: "600001" }));
  assert.equal(p.acceptingOrders, true);
  assert.equal("upiId" in p || "gstin" in p || "deliveryPincodes" in p, false);
  assert.equal(publicSettings(settings({ acceptingOrders: true })).acceptingOrders, false, "no UPI ID = not open");
});

test("slots: respect prep time, closed days and cake notice (India time)", () => {
  const now = new Date("2026-11-20T06:30:00Z"); // 12:00 in India, a Friday
  const s = settings({ openTime: "11:00", closeTime: "13:00", slotMinutes: 30, prepMinutes: 60, closedDays: [0], maxDaysAhead: 3 });
  const days = slotDays(s, false, now);
  assert.deepEqual(days.map((d) => d.date), ["2026-11-21", "2026-11-23"], "today is full, Sunday is closed");
  assert.equal(slotDays(s, true, now)[0].date, "2026-11-23", "cakes need 2 days' notice");
  assert.ok(checkSlot("2026-11-21", "11:30", s, false, now).value);
  assert.ok(checkSlot("2026-11-21", "11:15", s, false, now).error);
  assert.ok(checkSlot("2026-11-21", "11:00", s, true, now).error);
});

test("UPI link carries the amount and order number", () => {
  const link = upiLink({ upiId: "seren@okhdfcbank", upiName: "SEREN" }, 41050, "SRN-ABC234");
  assert.equal(link, "upi://pay?pa=seren%40okhdfcbank&pn=SEREN&am=410.50&cu=INR&tn=SEREN%20order%20SRN-ABC234");
  assert.equal(checkUtr(" 4123 5678 9012 ").value, "412356789012");
  assert.ok(checkUtr("12345").error);
});

test("checkout details: phone, address and pincode rules", () => {
  const s = settings({ deliveryPincodes: "600001, 600002" });
  assert.equal(checkCustomer({ name: "Asha", phone: "+91 98765 43210", mode: "pickup" }, s).value.phone, "9876543210");
  assert.ok(checkCustomer({ name: "Asha", phone: "12345", mode: "pickup" }, s).error);
  assert.ok(checkCustomer({ name: "Asha", phone: "9876543210", mode: "delivery", address: "12 Long Street, Chennai", pincode: "600099" }, s).error);
  assert.ok(checkCustomer({ name: "Asha", phone: "9876543210", mode: "delivery", address: "12 Long Street, Chennai", pincode: "600001" }, s).value);
  assert.ok(checkCustomer({ name: "Asha", phone: "9876543210", mode: "teleport" }, s).error);
});

test("dine-in: table needed, phone optional, table list respected", () => {
  const s = settings({ dineInTables: "1, 2, Patio 1" });
  assert.equal(checkCustomer({ name: "Ravi", mode: "dinein", table: "patio 1" }, s).value.table, "patio 1");
  assert.equal(checkCustomer({ name: "Ravi", mode: "dinein", table: "2", phone: "" }, s).value.phone, "");
  assert.ok(checkCustomer({ name: "Ravi", mode: "dinein", table: "" }, s).error);
  assert.ok(checkCustomer({ name: "Ravi", mode: "dinein", table: "9" }, s).error, "table not in the list");
  assert.ok(checkCustomer({ name: "Ravi", mode: "dinein", table: "<b>" }, settings()).error);
  assert.ok(checkCustomer({ name: "Ravi", mode: "dinein", table: "2" }, settings({ dineIn: false })).error);
  assert.ok(checkCustomer({ name: "Ravi", mode: "dinein", table: "2", phone: "123" }, s).error, "a phone, if given, must be valid");
  assert.ok(checkSettings({ ...DEFAULT_SETTINGS, dineInTables: "1, <script>" }).error);
  assert.ok(checkSettings({ ...DEFAULT_SETTINGS, siteUrl: "javascript:alert(1)" }).error);
});

test("status moves", () => {
  assert.ok(canMove("paid", "preparing"));
  assert.ok(!canMove("awaiting_payment", "paid"), "paid only via confirm payment");
  assert.ok(!canMove("completed", "cancelled"));
  assert.ok(canConfirmPayment("payment_submitted"));
  assert.ok(!canConfirmPayment("paid"));
});

test("helpers: ids, escaping, financial year, rupees", () => {
  assert.match(`SRN-${randomCode()}`, ORDER_CODE);
  assert.match(randomToken(), TOKEN);
  assert.equal(esc(`<img onerror="x">`), "&lt;img onerror=&quot;x&quot;&gt;");
  assert.equal(financialYear("2026-11-20"), "2627");
  assert.equal(financialYear("2027-03-31"), "2627");
  assert.equal(financialYear("2027-04-01"), "2728");
  assert.equal(rupees(41050), "₹410.50");
  assert.equal(rupees(18000), "₹180");
});
