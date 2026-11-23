// GST pack for the accountant, laid out like the GSTR-1 tables: B2B, B2CS, HSN, credit notes, ECO (9(5)) and documents issued.
// All amounts are paise; the CSV prints rupees. Dates are India dates (YYYY-MM-DD).
import { HttpError } from "./http.js";
import { addDays, financialYear, rupees } from "./util.js";

export const MAX_RANGE_DAYS = 366;
export const PARTS = ["b2b", "b2cs", "hsn", "cdnr", "eco", "adv", "docs"];
const FOUR_CRORE = 4_000_000_000; // ₹4 crore in paise
const FIVE_CRORE = 5_000_000_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const validDay = (v) => YMD.test(v || "") && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Reads ?from=&to= (India dates). Missing values default to the last `defaultDays` days; more than 366 days is refused. */
export function dateRange(url, today, defaultDays = 30) {
  const to = validDay(url.searchParams.get("to")) ? url.searchParams.get("to") : today;
  const from = validDay(url.searchParams.get("from")) ? url.searchParams.get("from") : addDays(to, -(defaultDays - 1));
  if (to < from) throw new HttpError(400, "The end date is before the start date");
  const days = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) throw new HttpError(400, `Please pick ${MAX_RANGE_DAYS} days or fewer at a time (you picked ${days}).`);
  return { from, to };
}

/* ---------- CSV ---------- */
// Text that a spreadsheet could run as a formula gets a leading ' (only = + @ and tab/return, plus "-" when it is not a plain number).
// Real numbers (including negative ones such as -450.00) are never touched.
export function csvCell(v) {
  if (typeof v === "number") return String(v);
  const s = String(v ?? "");
  const risky = /^[=+@\t\r]/.test(s) || (s.startsWith("-") && !/^-\d+(\.\d+)?$/.test(s));
  const safe = risky ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export const csvText = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
const rs = (paise) => (paise / 100).toFixed(2);

/* ---------- building the report ---------- */
const isApp = (o) => Boolean(o.tax_snapshot && o.tax_snapshot.platform);
const rateRows = (o) => (o.tax_snapshot.taxSummary && o.tax_snapshot.taxSummary.length ? o.tax_snapshot.taxSummary : [{ rate: 0, taxable: o.total, tax: 0, cgst: 0, sgst: 0 }]);
const split = (tax) => ({ cgst: Math.floor(tax / 2), sgst: tax - Math.floor(tax / 2) });
const rateOut = (r) => ({ rate: r.rate, taxable: r.taxable, cgst: r.cgst ?? split(r.tax).cgst, sgst: r.sgst ?? split(r.tax).sgst });
const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] || 0), 0);

function stateLabel(settings) {
  const code = /^\d{2}/.test(settings.gstin || "") ? settings.gstin.slice(0, 2) : "";
  return [code, settings.stateName].filter(Boolean).join("-");
}

// Totals for a group of rate rows.
function totalsOf(rows) {
  const taxable = sum(rows, "taxable");
  const cgst = sum(rows, "cgst");
  const sgst = sum(rows, "sgst");
  return { taxable, cgst, sgst, tax: cgst + sgst };
}

function invoiceRow(o) {
  return { code: o.code, invoiceNo: o.invoice_no, date: o.invoice_date, gstin: o.customer_gstin || "", customer: o.customer_name || "", value: o.total, rates: rateRows(o).map(rateOut) };
}
function noteRow(o) {
  return { noteNo: o.credit_note_no, date: o.credit_note_date, invoiceNo: o.invoice_no, invoiceDate: o.invoice_date, gstin: o.customer_gstin || "", customer: o.customer_name || "", value: o.total, rates: rateRows(o).map(rateOut) };
}

// Rate-wise roll-up of many documents (B2CS, CDNUR).
function byRate(docs, place) {
  const map = new Map();
  for (const d of docs) {
    for (const r of d.rates) {
      const row = map.get(r.rate) || { rate: r.rate, placeOfSupply: place, taxable: 0, cgst: 0, sgst: 0 };
      map.set(r.rate, { ...row, taxable: row.taxable + r.taxable, cgst: row.cgst + r.cgst, sgst: row.sgst + r.sgst });
    }
  }
  return [...map.values()].sort((a, b) => a.rate - b.rate).map((r) => ({ ...r, tax: r.cgst + r.sgst }));
}

// HSN lines for one order: its items, its delivery, and whatever packing/service charge is left over in the tax summary.
function hsnLines(o, chargesHsn) {
  const out = (o.lines || []).map((l) => ({ hsn: l.hsn || "", rate: l.rate, qty: l.qty || 0, taxable: l.taxable || 0, tax: l.tax || 0 }));
  const d = o.tax_snapshot.delivery;
  if (d) out.push({ hsn: d.hsn || "", rate: d.rate, qty: 0, taxable: d.taxable || 0, tax: d.tax || 0 });
  for (const r of rateRows(o)) {
    const have = out.filter((l) => l.rate === r.rate);
    const taxable = r.taxable - sum(have, "taxable");
    const tax = r.tax - sum(have, "tax");
    if (taxable > 0 || tax > 0) out.push({ hsn: o.tax_snapshot.seller?.gstin ? chargesHsn : "", rate: r.rate, qty: 0, taxable: Math.max(taxable, 0), tax: Math.max(tax, 0) });
  }
  return out;
}

function hsnSummary(invoices, credits, chargesHsn) {
  const map = new Map();
  const add = (o, sign) => {
    for (const l of hsnLines(o, chargesHsn)) {
      const key = `${l.hsn}|${l.rate}`;
      const row = map.get(key) || { hsn: l.hsn, rate: l.rate, qty: 0, taxable: 0, tax: 0 };
      map.set(key, { ...row, qty: row.qty + sign * l.qty, taxable: row.taxable + sign * l.taxable, tax: row.tax + sign * l.tax });
    }
  };
  invoices.forEach((o) => add(o, 1));
  credits.forEach((o) => add(o, -1));
  return [...map.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
    .map((r) => ({ ...r, ...split(r.tax), value: r.taxable + r.tax }));
}

// Advances on restaurant service are taxable when received (receipt voucher), and that tax is set off when the bill is made:
// GSTR-1 Table 11A (advances received in the period, not yet billed) and 11B (advances adjusted against bills in the period).
// The tax inside an advance is the same share of it as the bill's tax is of the bill, split by rate.
function advanceShare(o, amount) {
  const summary = (o.tax_snapshot && o.tax_snapshot.taxSummary) || [];
  const total = o.total || 0;
  return summary.filter((r) => r.rate > 0).map((r) => {
    const gross = total ? Math.round((amount * (r.taxable + r.tax)) / total) : 0;
    const tax = Math.round((gross * r.rate) / (100 + r.rate));
    return { rate: r.rate, taxable: gross - tax, tax };
  });
}
function advanceTables(advances, invoices) {
  const byRate = (list) => {
    const m = new Map();
    for (const x of list) for (const r of x) { const g = m.get(r.rate) || { rate: r.rate, taxable: 0, tax: 0 }; m.set(r.rate, { rate: r.rate, taxable: g.taxable + r.taxable, tax: g.tax + r.tax }); }
    return [...m.values()].sort((a, b) => a.rate - b.rate).map((r) => ({ ...r, ...split(r.tax) }));
  };
  const received = advances.filter((a) => !a.invoice_no).map((a) => advanceShare(a, a.amount));
  const adjusted = invoices.filter((o) => o.advance > 0 && o.receipt_no && !isApp(o)).map((o) => advanceShare(o, o.advance));
  return { received: byRate(received), adjusted: byRate(adjusted),
    note: "Received: advances taken in this period for bills not made yet (Table 11A). Adjusted: advances set off against bills made in this period (Table 11B)." };
}

// Orders from delivery apps: the app collects and pays the GST (section 9(5)), so only the taxable value is shown.
function ecoSummary(invoices, credits) {
  const map = new Map();
  const get = (o) => {
    const p = o.tax_snapshot.platform;
    return map.get(p.id) || { platform: p.id, name: p.name, invoices: 0, value: 0, taxable: 0, notes: 0, noteTaxable: 0 };
  };
  for (const o of invoices) { const r = get(o); map.set(r.platform, { ...r, invoices: r.invoices + 1, value: r.value + o.total, taxable: r.taxable + sum(rateRows(o), "taxable") }); }
  for (const o of credits) { const r = get(o); map.set(r.platform, { ...r, notes: r.notes + 1, noteTaxable: r.noteTaxable + sum(rateRows(o), "taxable") }); }
  return [...map.values()].map((r) => ({ ...r, netTaxable: r.taxable - r.noteTaxable })).sort((a, b) => a.name.localeCompare(b.name));
}

// "SRN/2627/00012" -> series "SRN/2627", number 12.
const seriesOf = (no) => String(no).replace(/\/\d+$/, "");
function docRange(nature, numbers) {
  const groups = new Map();
  for (const no of numbers) {
    const s = seriesOf(no);
    const g = groups.get(s) || [];
    g.push(no);
    groups.set(s, g);
  }
  return [...groups.entries()].map(([series, list]) => {
    const sorted = list.slice().sort();
    return { nature, series, from: sorted[0], to: sorted[sorted.length - 1], total: list.length, cancelled: 0 };
  });
}

/**
 * @param {{ invoices: object[], credits: object[], receipts: string[], settings: object }} data
 */
export function buildGstReport(from, to, { invoices, credits, receipts = [], advances = [], settings }, turnover) {
  const place = stateLabel(settings);
  const own = invoices.filter((o) => !isApp(o));
  const b2bInv = own.filter((o) => o.customer_gstin);
  const b2csInv = own.filter((o) => !o.customer_gstin);
  const ownCredits = credits.filter((o) => !isApp(o));
  const cdnr = ownCredits.filter((o) => o.customer_gstin).map(noteRow);
  const cdnurDocs = ownCredits.filter((o) => !o.customer_gstin).map(noteRow);

  const b2b = b2bInv.map(invoiceRow);
  const b2csRows = byRate(b2csInv.map(invoiceRow), place);
  const cdnurRows = byRate(cdnurDocs, place);
  const eco = ecoSummary(invoices.filter(isApp), credits.filter(isApp));
  const flat = (docs) => totalsOf(docs.flatMap((d) => d.rates));

  const invoiceValue = sum(invoices, "total");
  const creditValue = sum(credits, "total");
  const taxOf = (os) => totalsOf(os.flatMap(rateRows).map(rateOut));
  const b2csTotals = { ...totalsOf(b2csRows), value: sum(b2csInv, "total"), bills: b2csInv.length };
  const b2bTotals = { ...flat(b2b), value: sum(b2bInv, "total"), invoices: b2b.length };
  const ecoTaxable = sum(eco, "netTaxable");
  const gstOnOwn = taxOf(own).tax - taxOf(ownCredits).tax;

  const net = turnover.invoiced - turnover.credited;
  const warnings = [];
  if (!settings.gstin) warnings.push("Your GSTIN isn't set up yet, so bills are simple bills without GST. Add it in Settings before sending anything to your accountant.");
  if (net >= FIVE_CRORE) warnings.push(`Your sales this financial year (${rupees(net)}) are above ₹5 crore. E-invoicing may already apply to you: ask your CA.`);
  else if (net >= FOUR_CRORE) warnings.push(`Your sales this financial year (${rupees(net)}) have passed ₹4 crore. E-invoicing starts at ₹5 crore: ask your CA.`);

  return {
    from, to,
    seller: { gstin: settings.gstin || "", legalName: settings.legalName || "", stateName: settings.stateName || "", placeOfSupply: place },
    totals: {
      invoices: { n: invoices.length, value: invoiceValue },
      creditNotes: { n: credits.length, value: creditValue },
      net: invoiceValue - creditValue,
      gstPayableByYou: gstOnOwn,
      b2bValue: b2bTotals.value, b2csValue: b2csTotals.value, ecoValue: sum(invoices.filter(isApp), "total"),
    },
    b2b: { rows: b2b, totals: b2bTotals },
    b2cs: { rows: b2csRows, totals: b2csTotals },
    hsn: { rows: hsnSummary(own, ownCredits, settings.charges?.hsn || "996331"),
      b2b: hsnSummary(b2bInv, ownCredits.filter((o) => o.customer_gstin), settings.charges?.hsn || "996331"),
      b2c: hsnSummary(b2csInv, ownCredits.filter((o) => !o.customer_gstin), settings.charges?.hsn || "996331"),
      note: "GSTR-1 Table 12 wants B2B and B2C separately (the CSV has both). Orders from delivery apps are not included here (see the app section)." },
    advances: advanceTables(advances, invoices),
    cdnr: { rows: cdnr, totals: { ...flat(cdnr), value: sum(cdnr, "value"), n: cdnr.length } },
    cdnur: { rows: cdnurRows, notes: cdnurDocs, totals: { ...totalsOf(cdnurRows), value: sum(cdnurDocs, "value"), n: cdnurDocs.length } },
    eco: { rows: eco, taxableTotal: ecoTaxable, note: "GST on these sales is collected and paid by the delivery app (section 9(5)). Only the taxable value is shown." },
    docs: { rows: [
      ...docRange("Invoices for outward supply", invoices.map((o) => o.invoice_no)),
      ...docRange("Credit notes", credits.map((o) => o.credit_note_no)),
      ...docRange("Receipt vouchers (advances)", receipts),
    ] },
    turnover: { ...turnover, net, warnings },
    warnings,
  };
}

/* ---------- reading the database ---------- */
export function financialYearBounds(ymd) {
  const [y, m] = ymd.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return { start: `${start}-04-01`, end: `${start + 1}-03-31`, label: financialYear(ymd) };
}

export async function loadGstData(db, store, from, to) {
  const fy = financialYearBounds(to);
  const [invoices, credits, turn, receipts] = await Promise.all([
    store.listInvoices(db, from, to),
    store.listCreditNotes(db, from, to),
    db.batch([
      db.prepare("SELECT COALESCE(SUM(total), 0) AS v FROM orders WHERE invoice_no IS NOT NULL AND invoice_date BETWEEN ?1 AND ?2").bind(fy.start, fy.end),
      db.prepare("SELECT COALESCE(SUM(total), 0) AS v FROM orders WHERE credit_note_no IS NOT NULL AND credit_note_date BETWEEN ?1 AND ?2").bind(fy.start, fy.end),
    ]),
    db.prepare(`SELECT o.receipt_no AS no, p.amount, o.total, o.tax_snapshot, o.invoice_no, o.invoice_date FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.kind = 'advance' AND o.receipt_no IS NOT NULL AND date(p.at, '+330 minutes') BETWEEN ?1 AND ?2`).bind(from, to).all(),
  ]);
  // an advance counts as "not billed yet" if its bill was made after the end of this period (or not at all)
  const advances = receipts.results.map((r) => ({ ...r, tax_snapshot: JSON.parse(r.tax_snapshot || "{}"), invoice_no: r.invoice_no && r.invoice_date <= to ? r.invoice_no : null }));
  return {
    invoices, credits, receipts: receipts.results.map((r) => r.no), advances,
    turnover: { fyStart: fy.start, fyEnd: fy.end, invoiced: turn[0].results[0].v, credited: turn[1].results[0].v },
  };
}

/* ---------- CSV parts ---------- */
export function gstCsv(report, part) {
  const rateCols = (r) => [r.rate, rs(r.taxable), rs(r.cgst), rs(r.sgst)];
  if (part === "b2b") {
    const rows = [["GSTIN of customer", "Customer", "Invoice number", "Invoice date", "Invoice value", "Place of supply", "GST rate %", "Taxable value", "CGST", "SGST"]];
    for (const d of report.b2b.rows) d.rates.forEach((r, i) => rows.push([d.gstin, d.customer, d.invoiceNo, d.date, i === 0 ? rs(d.value) : "", report.seller.placeOfSupply, ...rateCols(r)]));
    return rows;
  }
  if (part === "b2cs") {
    return [["Type", "Place of supply", "GST rate %", "Taxable value", "CGST", "SGST"],
      ...report.b2cs.rows.map((r) => ["OE", r.placeOfSupply, ...rateCols(r)])];
  }
  if (part === "hsn") {
    return [["Type", "HSN / SAC", "Unit", "Quantity", "GST rate %", "Taxable value", "CGST", "SGST", "Total value"],
      ...report.hsn.b2b.map((r) => ["B2B", r.hsn, "NOS", r.qty, r.rate, rs(r.taxable), rs(r.cgst), rs(r.sgst), rs(r.value)]),
      ...report.hsn.b2c.map((r) => ["B2C", r.hsn, "NOS", r.qty, r.rate, rs(r.taxable), rs(r.cgst), rs(r.sgst), rs(r.value)])];
  }
  if (part === "adv") {
    return [["Table", "Place of supply", "GST rate %", "Taxable value", "CGST", "SGST"],
      ...report.advances.received.map((r) => ["11A advance received", report.seller.placeOfSupply, ...rateCols(r)]),
      ...report.advances.adjusted.map((r) => ["11B advance adjusted", report.seller.placeOfSupply, ...rateCols(r)])];
  }
  if (part === "cdnr") {
    const rows = [["Receiver", "GSTIN of customer", "Note type", "Credit note number", "Credit note date", "Against invoice", "Invoice date", "Note value", "GST rate %", "Taxable value", "CGST", "SGST"]];
    for (const d of report.cdnr.rows) d.rates.forEach((r, i) => rows.push(["Registered", d.gstin, "Credit note", d.noteNo, d.date, d.invoiceNo, d.invoiceDate, i === 0 ? rs(d.value) : "", ...rateCols(r)]));
    for (const d of report.cdnur.notes) d.rates.forEach((r, i) => rows.push(["Unregistered", "", "Credit note", d.noteNo, d.date, d.invoiceNo, d.invoiceDate, i === 0 ? rs(d.value) : "", ...rateCols(r)]));
    return rows;
  }
  if (part === "eco") {
    return [["Delivery app", "Bills", "Bill value", "Taxable value", "Credit notes", "Taxable value returned", "Net taxable value", "Note"],
      ...report.eco.rows.map((r) => [r.name, r.invoices, rs(r.value), rs(r.taxable), r.notes, rs(r.noteTaxable), rs(r.netTaxable), "GST paid by the app, section 9(5)"])];
  }
  return [["Document", "Series", "From number", "To number", "Total issued", "Cancelled"],
    ...report.docs.rows.map((r) => [r.nature, r.series, r.from, r.to, r.total, r.cancelled])];
}
