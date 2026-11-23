// Store settings: defaults, and checking what the owner saves from the dashboard.
import { CATEGORIES } from "./catalog.js";

const categoryTax = () => Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, { hsn: "", rate: 0 }]));

export const DEFAULT_SETTINGS = Object.freeze({
  storeName: "SEREN Entremets",
  legalName: "",            // business name as registered for GST
  gstin: "",                // empty = simple bill without GST
  gstScheme: "regular",     // "regular" (tax invoice, collects GST) or "composition" (bill of supply, no GST collected)
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
  fssaiNo: "",              // 14-digit FSSAI licence / registration number: printed on every bill (FSSAI order, 2021)
  // bill extras
  charges: { packing: 0, servicePercent: 0, roundOff: true, hsn: "996331" }, // packing in paise per takeaway order
  // what staff may do without a manager's PIN
  approvals: { discountPercent: 10, points: 100, counterUpiNeedsRef: false },
  // kitchen stations: each category goes to one screen / printer
  stations: { list: ["Kitchen", "Bakery", "Drinks"], byCategory: {} },
  // sections made fresh when ordered: counter bills with these go to the kitchen screen;
  // counter bills with only ready-made items (from the display) are handed over at once
  madeToOrder: ["bomboloni", "gelato", "focaccia"],
  // delivery apps (Swiggy, Zomato, ONDC…): their commission, to show what you really receive
  platforms: [
    { id: "swiggy", name: "Swiggy", commission: 25 },
    { id: "zomato", name: "Zomato", commission: 25 },
    { id: "ondc", name: "ONDC", commission: 8 },
    { id: "magicpin", name: "Magicpin", commission: 15 },
  ],
  lowStockAlerts: true,
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
    gstScheme: s.gstScheme === "composition" ? "composition" : "regular",
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
    fssaiNo: String(s.fssaiNo ?? "").replace(/\s+/g, ""),
    charges: null,
    approvals: null,
    stations: null,
    platforms: null,
    madeToOrder: null,
    lowStockAlerts: s.lowStockAlerts === undefined ? true : Boolean(s.lowStockAlerts),
  };
  const extras = checkExtras(s);
  if (extras.error) return extras;
  Object.assign(out, extras.value);
  if (out.tableKeyVersion === null) return { error: "tableKeyVersion is not valid" };
  if (out.whatsappNumber && !/^91[6-9]\d{9}$/.test(out.whatsappNumber)) return { error: "WhatsApp number: 91 followed by the 10-digit mobile, e.g. 919876543210" };
  if (out.googleReviewUrl && !/^https:\/\/[^\s"'<>]+$/.test(out.googleReviewUrl)) return { error: "Google review link must start with https://" };
  if (out.fssaiNo && !/^\d{14}$/.test(out.fssaiNo)) return { error: "FSSAI licence number is 14 digits" };
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
  if (out.gstin && out.stateName === "" ) out.stateName = STATE_BY_CODE[out.gstin.slice(0, 2)] || "";
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

// Charges, approval limits, kitchen stations and delivery apps.
function checkExtras(s) {
  const d = DEFAULT_SETTINGS;
  const obj = (v, def) => ({ ...def, ...(v && typeof v === "object" && !Array.isArray(v) ? v : {}) });
  const ch = obj(s.charges, d.charges);
  const charges = { packing: int(ch.packing, 0, 100000), servicePercent: Number(ch.servicePercent), roundOff: Boolean(ch.roundOff), hsn: text(ch.hsn, 8) };
  if (charges.packing === null) return { error: "Packing charge must be a whole number of paise" };
  if (!(charges.servicePercent >= 0 && charges.servicePercent <= 20)) return { error: "Service charge: 0 to 20%" };
  if (!HSN.test(charges.hsn)) return { error: "Charges: SAC code must be 4, 6 or 8 digits" };
  const ap = obj(s.approvals, d.approvals);
  const approvals = { discountPercent: int(ap.discountPercent, 0, 100), points: int(ap.points, 0, 1000000), counterUpiNeedsRef: Boolean(ap.counterUpiNeedsRef) };
  if (approvals.discountPercent === null || approvals.points === null) return { error: "Approval limits must be whole numbers" };
  const st = obj(s.stations, d.stations);
  const list = (Array.isArray(st.list) ? st.list : []).map((x) => text(x, 20)).filter(Boolean).slice(0, 8);
  if (!list.length || list.some((x) => !/^[\p{L}\p{N} &-]{1,20}$/u.test(x))) return { error: "Kitchen stations: 1 to 8 names" };
  const byCategory = {};
  for (const [cat, name] of Object.entries(st.byCategory && typeof st.byCategory === "object" ? st.byCategory : {})) {
    if (Object.hasOwn(CATEGORIES, cat) && list.includes(name)) byCategory[cat] = name;
  }
  const raw = Array.isArray(s.platforms) ? s.platforms : d.platforms;
  const platforms = [];
  for (const p of raw.slice(0, 8)) {
    const id = text(p?.id, 20).toLowerCase();
    const name = text(p?.name, 20);
    const commission = Number(p?.commission);
    if (!/^[a-z0-9-]{2,20}$/.test(id) || !name || !(commission >= 0 && commission <= 60)) return { error: "Delivery apps: a short id, a name and a commission between 0 and 60%" };
    if (!platforms.some((x) => x.id === id)) platforms.push({ id, name, commission });
  }
  const made = Array.isArray(s.madeToOrder) ? s.madeToOrder : d.madeToOrder;
  const madeToOrder = [...new Set(made.filter((c) => typeof c === "string" && Object.hasOwn(CATEGORIES, c)))];
  return { value: { charges, approvals, stations: { list, byCategory }, platforms, madeToOrder } };
}

// How this shop bills tax:
//  "regular"      tax invoice, GST charged (CGST + SGST)
//  "composition"  bill of supply, no GST charged ("composition taxable person, not eligible to collect tax on supplies")
//  "unregistered" a plain bill, no GSTIN, no GST
export function taxMode(s) {
  if (!s || !s.gstin) return "unregistered";
  return s.gstScheme === "composition" ? "composition" : "regular";
}

// GST state codes (the first two digits of a GSTIN), for "place of supply: 33-Tamil Nadu".
export const STATE_BY_CODE = Object.freeze({
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
  "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh",
  "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands", "36": "Telangana",
  "37": "Andhra Pradesh", "38": "Ladakh",
});

// The GST of one product: its own setting if the owner gave it one, otherwise its section's.
export function itemTax(settings, item) {
  const own = item && item.tax && typeof item.tax === "object" && Number.isFinite(Number(item.tax.rate)) ? item.tax : null;
  return own || settings.tax[item.category] || { hsn: "", rate: 0 };
}

// Setup problems a real GST bill would have (shown in Settings and on the dashboard).
export function gstWarnings(s, categories) {
  const mode = taxMode(s);
  const out = [];
  if (mode === "regular") {
    const zero = Object.keys(categories).filter((k) => !(s.tax[k] && s.tax[k].rate > 0));
    if (zero.length) out.push(`GST is on, but these sections charge 0%: ${zero.map((k) => categories[k]).join(", ")}. A café's food is normally restaurant service at 5% (SAC 996331) — ask your CA, then set it in Settings → Bills & GST.`);
    const noCode = Object.keys(categories).filter((k) => !(s.tax[k] && s.tax[k].hsn));
    if (noCode.length) out.push(`Add the HSN / SAC code for: ${noCode.map((k) => categories[k]).join(", ")} (needed on GST bills and in GSTR-1).`);
    if (!s.address) out.push("Add the shop address: it must be printed on every GST bill.");
  }
  if (mode === "composition" && !s.address) out.push("Add the shop address: it must be printed on every bill of supply.");
  if (!s.fssaiNo) out.push("Add your 14-digit FSSAI licence number: it must be printed on every bill.");
  return out;
}

// Which kitchen station makes this category.
export const stationFor = (settings, category) => settings.stations.byCategory[category] || settings.stations.list[0];

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
    charges: { packing: s.charges.packing, servicePercent: s.charges.servicePercent, roundOff: s.charges.roundOff },
    taxesAdded: taxMode(s) === "regular" && !s.pricesIncludeGst,
    fssaiNo: s.fssaiNo, // the website says whether GST is on top of its prices
    loyalty: s.loyalty.enabled ? { earnEvery: s.loyalty.earnEvery, pointValue: s.loyalty.pointValue } : null,
  };
}
