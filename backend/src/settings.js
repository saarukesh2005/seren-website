// Store settings: defaults, and checking what the owner saves from the dashboard.
import { CATEGORIES } from "./catalog.js";

const categoryTax = () => Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, { hsn: "", rate: 0 }]));

export const DEFAULT_SETTINGS = Object.freeze({
  storeName: "SEREN Entremets",
  legalName: "",            // business name as registered for GST
  gstin: "",                // empty = simple bill without GST
  address: "",
  stateName: "",
  phone: "",
  email: "",
  upiId: "",                // e.g. seren@okhdfcbank (a business UPI ID works best)
  upiName: "SEREN",
  acceptingOrders: false,   // switched on by the owner once prices are set
  pickup: true,
  delivery: true,
  dineIn: true,
  dineInTables: "",         // comma-separated table names; empty = any table number
  siteUrl: "https://saarukesh2005.github.io/seren-website/", // used for the table QR codes
  deliveryFee: 0,           // paise
  freeDeliveryAbove: 0,     // paise, 0 = never free
  minOrder: 0,              // paise
  deliveryPincodes: "",     // comma-separated; empty = deliver anywhere
  openTime: "11:00",
  closeTime: "22:00",
  closedDays: [],           // 0 = Sunday … 6 = Saturday
  slotMinutes: 30,
  prepMinutes: 60,          // earliest slot is at least this far away
  maxDaysAhead: 14,
  preorderCategories: ["entremets"],
  preorderNoticeDays: 2,
  pricesIncludeGst: true,
  tax: categoryTax(),
  deliveryTax: { hsn: "", rate: 0 },
  paymentMinutes: 30,       // unpaid online orders expire after this
  invoicePrefix: "SRN",
  invoiceNote: "Thank you for choosing SEREN.",
  dineInPayLater: false,    // table guests can order rounds and pay once at the end
  tableKeyVersion: 1,       // bump to make old printed table QR codes stop working
  whatsappNumber: "",       // the shop's WhatsApp, with country code, e.g. 919876543210
  waTemplates: {
    paid: "Hi {name}! We've received your payment of {total} for SEREN order {code}. Your bill: {link}",
    preparing: "Hi {name}! Your SEREN order {code} is being made now.",
    ready: "Hi {name}! Your SEREN order {code} is ready. See you soon!",
    out_for_delivery: "Hi {name}! Your SEREN order {code} is on its way.",
    feedback: "Hi {name}! Hope you loved your SEREN treats. Tell us how it was: {link}",
  },
  waApi: { enabled: false, phoneNumberId: "", version: "v23.0", lang: "en", paidTemplate: "", readyTemplate: "" },
  loyalty: { enabled: false, earnEvery: 10000, pointValue: 100 }, // 1 point per ₹100 spent, 1 point = ₹1 off
  googleReviewUrl: "",
});

const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const UPI_ID = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
const HSN = /^(\d{4}|\d{6}|\d{8})?$/;
export const TABLE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,9}$/;

const text = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const int = (v, min, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

// Returns { value } with a complete settings object, or { error } naming the first problem.
export function checkSettings(input, current = DEFAULT_SETTINGS) {
  if (!input || typeof input !== "object") return { error: "Settings must be an object" };
  const s = { ...current, ...input };
  const out = {
    storeName: text(s.storeName, 80) || DEFAULT_SETTINGS.storeName,
    legalName: text(s.legalName, 120),
    gstin: text(s.gstin, 15).toUpperCase(),
    address: text(s.address, 300),
    stateName: text(s.stateName, 40),
    phone: text(s.phone, 20),
    email: text(s.email, 120),
    upiId: text(s.upiId, 120),
    upiName: text(s.upiName, 50) || "SEREN",
    acceptingOrders: Boolean(s.acceptingOrders),
    pickup: Boolean(s.pickup),
    delivery: Boolean(s.delivery),
    dineIn: Boolean(s.dineIn),
    dineInTables: text(s.dineInTables, 1000),
    siteUrl: text(s.siteUrl, 200),
    deliveryFee: int(s.deliveryFee, 0, 10000000),
    freeDeliveryAbove: int(s.freeDeliveryAbove, 0, 100000000),
    minOrder: int(s.minOrder, 0, 100000000),
    deliveryPincodes: text(s.deliveryPincodes, 2000),
    openTime: text(s.openTime, 5),
    closeTime: text(s.closeTime, 5),
    closedDays: Array.isArray(s.closedDays) ? [...new Set(s.closedDays.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [],
    slotMinutes: int(s.slotMinutes, 10, 240),
    prepMinutes: int(s.prepMinutes, 0, 1440),
    maxDaysAhead: int(s.maxDaysAhead, 0, 90),
    preorderCategories: Array.isArray(s.preorderCategories) ? s.preorderCategories.filter((c) => Object.hasOwn(CATEGORIES, String(c))) : [],
    preorderNoticeDays: int(s.preorderNoticeDays, 0, 30),
    pricesIncludeGst: Boolean(s.pricesIncludeGst),
    tax: {},
    deliveryTax: null,
    paymentMinutes: int(s.paymentMinutes, 5, 1440),
    invoicePrefix: text(s.invoicePrefix, 4).toUpperCase(),
    invoiceNote: text(s.invoiceNote, 300),
    dineInPayLater: Boolean(s.dineInPayLater),
    tableKeyVersion: int(s.tableKeyVersion, 1, 100000),
    whatsappNumber: String(s.whatsappNumber ?? "").replace(/[\s+-]/g, ""),
    waTemplates: {},
    waApi: null,
    loyalty: null,
    googleReviewUrl: text(s.googleReviewUrl, 300),
  };
  if (out.tableKeyVersion === null) return { error: "tableKeyVersion is not valid" };
  if (out.whatsappNumber && !/^91[6-9]\d{9}$/.test(out.whatsappNumber)) return { error: "WhatsApp number: 91 followed by the 10-digit mobile, e.g. 919876543210" };
  if (out.googleReviewUrl && !/^https:\/\/[^\s"'<>]+$/.test(out.googleReviewUrl)) return { error: "Google review link must start with https://" };
  const tpl = s.waTemplates && typeof s.waTemplates === "object" ? s.waTemplates : {};
  for (const k of Object.keys(DEFAULT_SETTINGS.waTemplates)) out.waTemplates[k] = text(tpl[k] ?? DEFAULT_SETTINGS.waTemplates[k], 500) || DEFAULT_SETTINGS.waTemplates[k];
  const api = { ...DEFAULT_SETTINGS.waApi, ...(s.waApi && typeof s.waApi === "object" ? s.waApi : {}) };
  out.waApi = {
    enabled: Boolean(api.enabled),
    phoneNumberId: text(api.phoneNumberId, 30),
    version: text(api.version, 8),
    lang: text(api.lang, 10),
    paidTemplate: text(api.paidTemplate, 60),
    readyTemplate: text(api.readyTemplate, 60),
  };
  if (out.waApi.phoneNumberId && !/^\d{5,30}$/.test(out.waApi.phoneNumberId)) return { error: "WhatsApp API phone number ID is digits only" };
  if (!/^v\d{1,3}\.\d$/.test(out.waApi.version)) return { error: "WhatsApp API version looks like v23.0" };
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(out.waApi.lang)) return { error: "WhatsApp template language looks like en or en_US" };
  if ([out.waApi.paidTemplate, out.waApi.readyTemplate].some((t) => t && !/^[a-z0-9_]{1,60}$/.test(t))) return { error: "WhatsApp template names use lowercase letters, numbers and _" };
  if (out.waApi.enabled && (!out.waApi.phoneNumberId || !out.waApi.paidTemplate)) return { error: "Automatic WhatsApp needs the phone number ID and at least the payment template" };
  const loy = { ...DEFAULT_SETTINGS.loyalty, ...(s.loyalty && typeof s.loyalty === "object" ? s.loyalty : {}) };
  out.loyalty = { enabled: Boolean(loy.enabled), earnEvery: int(loy.earnEvery, 100, 10000000), pointValue: int(loy.pointValue, 1, 100000) };
  if (out.loyalty.earnEvery === null || out.loyalty.pointValue === null) return { error: "Loyalty: amounts must be whole numbers" };

  for (const k of ["deliveryFee", "freeDeliveryAbove", "minOrder", "slotMinutes", "prepMinutes", "maxDaysAhead", "preorderNoticeDays", "paymentMinutes"]) {
    if (out[k] === null) return { error: `${k} is not a valid whole number in range` };
  }
  if (!HHMM.test(out.openTime) || !HHMM.test(out.closeTime)) return { error: "Opening hours must look like 11:00" };
  if (out.openTime >= out.closeTime) return { error: "Closing time must be after opening time" };
  if (out.gstin && !GSTIN.test(out.gstin)) return { error: "That GSTIN doesn't look right (15 characters, like 33ABCDE1234F1Z5)" };
  if (out.gstin && !out.legalName) return { error: "Add the legal business name to print GST invoices" };
  if (out.upiId && !UPI_ID.test(out.upiId)) return { error: "That UPI ID doesn't look right (like seren@okhdfcbank)" };
  if (!/^[A-Z0-9]{1,4}$/.test(out.invoicePrefix)) return { error: "Invoice prefix: 1 to 4 letters or digits" };
  const pins = out.deliveryPincodes.split(",").map((p) => p.trim()).filter(Boolean);
  if (pins.some((p) => !/^\d{6}$/.test(p))) return { error: "Delivery pincodes must be 6 digits, separated by commas" };
  out.deliveryPincodes = pins.join(", ");
  const tables = out.dineInTables.split(",").map((t) => t.trim()).filter(Boolean);
  if (tables.some((t) => !TABLE.test(t))) return { error: "Table names: up to 10 letters, numbers or spaces each, separated by commas" };
  out.dineInTables = tables.join(", ");
  if (out.siteUrl && !/^https:\/\/[^\s"'<>]+$/.test(out.siteUrl)) return { error: "Website address must start with https://" };

  const tax = s.tax && typeof s.tax === "object" ? s.tax : {};
  for (const cat of Object.keys(CATEGORIES)) {
    const t = checkTax(tax[cat] ?? current.tax?.[cat] ?? { hsn: "", rate: 0 }, CATEGORIES[cat]);
    if (t.error) return t;
    out.tax[cat] = t.value;
  }
  const dt = checkTax(s.deliveryTax ?? { hsn: "", rate: 0 }, "Delivery");
  if (dt.error) return dt;
  out.deliveryTax = dt.value;
  return { value: out };
}

function checkTax(t, label) {
  const hsn = text(t?.hsn, 8);
  const rate = Number(t?.rate);
  if (!HSN.test(hsn)) return { error: `${label}: HSN/SAC code must be 4, 6 or 8 digits` };
  if (!GST_RATES.includes(rate)) return { error: `${label}: GST rate must be one of ${GST_RATES.join(", ")}%` };
  return { value: { hsn, rate } };
}

// What the public website is allowed to see.
export function publicSettings(s) {
  return {
    storeName: s.storeName,
    acceptingOrders: s.acceptingOrders && Boolean(s.upiId),
    pickup: s.pickup,
    delivery: s.delivery,
    dineIn: s.dineIn,
    deliveryFee: s.deliveryFee,
    freeDeliveryAbove: s.freeDeliveryAbove,
    minOrder: s.minOrder,
    restrictPincodes: Boolean(s.deliveryPincodes),
    openTime: s.openTime,
    closeTime: s.closeTime,
    closedDays: s.closedDays,
    slotMinutes: s.slotMinutes,
    prepMinutes: s.prepMinutes,
    maxDaysAhead: s.maxDaysAhead,
    preorderCategories: s.preorderCategories,
    preorderNoticeDays: s.preorderNoticeDays,
    paymentMinutes: s.paymentMinutes,
    dineInPayLater: s.dineIn && s.dineInPayLater,
    whatsapp: s.whatsappNumber,
    googleReviewUrl: s.googleReviewUrl,
    loyalty: s.loyalty.enabled ? { earnEvery: s.loyalty.earnEvery, pointValue: s.loyalty.pointValue } : null,
  };
}
