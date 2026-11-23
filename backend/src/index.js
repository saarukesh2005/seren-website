// SEREN order system: entry point, URL routing and who may use what.
import { can, checkSameOrigin, currentUser, requireSecrets } from "./auth.js";
import { sendBackupToTelegram } from "./backup.js";
import { HttpError, fail, html, preflight, withCors } from "./http.js";
import * as admin from "./routes-admin.js";
import * as counter from "./routes-counter.js";
import * as stockApi from "./routes-admin-inventory.js";
import * as menuApi from "./routes-admin-menu.js";
import * as people from "./routes-admin-people.js";
import * as money from "./routes-admin-money.js";
import * as reports from "./routes-admin-reports.js";
import * as tablesApi from "./routes-admin-tables.js";
import * as pub from "./routes-public.js";
import { ipKey } from "./routes-public.js";
import { expireUnpaid } from "./store.js";

const CODE = "(SRN-[A-Z0-9]{6})";
const TABLE = "([A-Za-z0-9%][A-Za-z0-9% -]{0,29})";
const withHtml = (fn) => (c) => fn(c, html);

// [method, path pattern, handler]
const PUBLIC = [
  ["GET", "/api/menu", pub.menu],
  ["GET", "/api/slots", pub.slots],
  ["POST", "/api/coupons/check", pub.checkCoupon],
  ["POST", "/api/orders", pub.placeOrder],
  ["GET", `/api/orders/${CODE}`, pub.viewOrder],
  ["POST", `/api/orders/${CODE}/payment`, pub.submitPayment],
  ["POST", `/api/orders/${CODE}/feedback`, pub.feedback],
  ["GET", `/api/tables/${TABLE}`, pub.tableView],
  ["POST", `/api/tables/${TABLE}/call`, pub.tableCall],
  ["GET", "/img/([A-Z0-9]{12})", pub.image],
  ["POST", "/api/hooks/orders", counter.hookOrder],
];

// [method, path pattern, permission ("" = any logged-in person, "owner" = owner only), handler]
const ADMIN = [
  ["POST", "/logout", "", admin.logout],
  ["GET", "/me", "", admin.me],
  ["GET", "/orders", "orders", admin.orders],
  ["GET", `/orders/${CODE}`, "orders", admin.order],
  ["POST", `/orders/${CODE}/confirm`, "orders", admin.confirm],
  ["POST", `/orders/${CODE}/status`, "kitchen", admin.move], // finer check inside (kitchen may only start/finish)
  ["POST", `/orders/${CODE}/note`, "orders", admin.note],
  ["POST", `/orders/${CODE}/refund`, "refund", admin.refund],
  ["POST", `/orders/${CODE}/whatsapp`, "orders", admin.whatsappLink],
  ["POST", "/counter", "counter", counter.counterSale],
  ["POST", "/counter/quote", "counter", (c) => counter.counterSale({ ...c, quote: true })],
  ["POST", "/counter/advance", "counter", counter.advanceOrder],
  ["POST", "/counter/app-order", "counter", counter.appOrder],
  ["POST", "/counter/dropped", "counter", counter.droppedBill],
  ["GET", "/kitchen", "kitchen", admin.kitchen],
  ["GET", "/tables", "tables", tablesApi.overview],
  ["POST", "/calls/(\\d{1,9})/done", "tables", tablesApi.callDone],
  ["POST", `/tables/${TABLE}/open`, "tables", tablesApi.seat],
  ["POST", `/tables/${TABLE}/bill`, "tables", tablesApi.billTab],
  ["POST", `/tables/${TABLE}/reopen`, "tables", tablesApi.reopenTab],
  ["POST", `/tables/${TABLE}/close`, "tables", tablesApi.closeEmpty],
  ["POST", `/tables/${TABLE}/move`, "tables", tablesApi.moveTable],
  ["POST", `/tables/${TABLE}/order`, "tables", tablesApi.captainOrder],
  ["GET", "/table-links", "owner", tablesApi.tableLinks],
  ["GET", "/catalog", "", menuApi.catalog],
  ["POST", "/prices/([a-z0-9-]{1,80})", "menu", menuApi.putPrice],
  ["POST", "/products", "menu", menuApi.createProduct],
  ["POST", "/products/([a-z0-9-]{1,80})", "menu", menuApi.updateProduct],
  ["POST", "/images", "menu", menuApi.uploadImage],
  ["GET", "/stock", "stock", stockApi.overview],
  ["POST", "/stock/ingredients", "stock", stockApi.addIngredient],
  ["POST", "/stock/ingredients/(\\d{1,9})", "stock", stockApi.editIngredient],
  ["GET", "/stock/recipes/([a-z0-9-]{1,80})", "stock", stockApi.getRecipe],
  ["POST", "/stock/recipes/([a-z0-9-]{1,80})", "stock", stockApi.putRecipe],
  ["GET", "/stock/purchases", "stock", stockApi.purchases],
  ["POST", "/stock/purchases", "stock", stockApi.addPurchase],
  ["POST", "/stock/wastage", "stock", stockApi.wastage],
  ["POST", "/stock/count", "stock", stockApi.count],
  ["GET", "/stock/moves", "stock", stockApi.moves],
  ["GET", "/stock/food-cost", "stock", stockApi.foodCost],
  ["GET", "/stock/vendors", "stock", stockApi.vendors],
  ["POST", "/stock/vendors", "stock", stockApi.saveVendor],
  ["GET", "/customers", "customers", people.customers],
  ["POST", "/customers/(\\d{10})", "customers", people.changeCustomer],
  ["GET", "/customers/(\\d{10})/points", "counter", people.points],
  ["POST", "/broadcast", "offers", people.broadcast],
  ["GET", "/coupons", "offers", people.coupons],
  ["POST", "/coupons", "offers", people.createCoupon],
  ["POST", "/coupons/([A-Z0-9]{3,20})", "offers", people.changeCoupon],
  ["GET", "/feedback", "customers", people.feedbackList],
  ["GET", "/reports", "reports", reports.report],
  ["GET", "/export.csv", "reports", reports.exportCsv],
  ["GET", "/shift", "cash", money.getShift],
  ["POST", "/shift/open", "cash", money.open],
  ["POST", "/shift/close", "cash", money.close],
  ["POST", "/shift/cash", "cash", money.cash],
  ["GET", "/shifts", "reports", money.history],
  ["GET", "/expenses", "reports", money.expenses],
  ["POST", "/expenses", "reports", money.addExpense],
  ["POST", "/expenses/(\\d{1,9})/delete", "reports", money.deleteExpense],
  ["GET", "/gst", "reports", money.gst],
  ["GET", "/gst\\.csv", "reports", money.gstCsvDownload],
  ["GET", "/settings", "orders", reports.getSettings],
  ["POST", "/settings", "owner", reports.putSettings],
  ["GET", "/backup.json", "owner", reports.backup],
  ["GET", "/staff", "owner", people.staff],
  ["POST", "/staff", "owner", people.createStaff],
  ["POST", "/staff/(\\d{1,9})", "owner", people.changeStaff],
  ["POST", "/logout-everyone", "owner", people.logoutAll],
  ["POST", "/approval-pin", "owner", people.ownerPin],
  ["GET", "/activity", "owner", people.activity],
];

// Printable pages for logged-in staff.
const PAGES = [
  [`/invoice/${CODE}`, "orders", withHtml(admin.invoice)],
  [`/credit-note/${CODE}`, "orders", withHtml(admin.creditNote)],
  [`/kot/${CODE}`, "kitchen", withHtml(admin.kot)],
  [`/receipt/${CODE}`, "orders", withHtml(admin.advanceReceipt)],
  ["/day-close", "reports", withHtml(reports.closing)],
];

const find = (list, method, path, hasMethod = true) => {
  for (const r of list) {
    const [m, pattern] = hasMethod ? r : [method, r[0]];
    if (m !== method) continue;
    const hit = path.match(new RegExp(`^${pattern}$`));
    if (hit) return { route: r, params: hit.slice(1) };
  }
  return null;
};

function allowed(user, perm) {
  if (perm === "") return true;
  if (perm === "owner") return user.role === "owner";
  return can(user, perm);
}

// Cloudflare's own rate limiter (free, no database writes): a first wall against floods from one address.
// Not used for this computer itself (local testing); on Cloudflare the address is never a loopback one.
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
async function firstWall(request, env, path) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || LOOPBACK.has(ip)) return;
  const key = ipKey(ip);
  const limiter = path === "/api/admin/login" ? env.RL_LOGIN : path.startsWith("/api/admin/") ? env.RL_STAFF : env.RL_PUBLIC;
  if (limiter && !(await limiter.limit({ key })).success) throw new HttpError(429, "Too many requests. Please wait a minute.");
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const c = { request, env, ctx, url, params: [] };
  if (path.startsWith("/api/") || path.startsWith("/img/")) await firstWall(request, env, path);

  const p = find(PUBLIC, request.method, path);
  if (p) return p.route[2]({ ...c, params: p.params });

  // a customer's own bill (with their link token) or a printout for staff
  if (request.method === "GET") {
    const page = find(PAGES, "GET", path, false);
    if (page) {
      if (path.startsWith("/invoice/") && url.searchParams.get("t")) return pub.customerInvoice({ ...c, params: page.params }, html);
      const user = await currentUser(request, env, env.DB);
      if (!user) return Response.redirect(`${url.origin}/admin/`, 302);
      if (!allowed(user, page.route[1])) throw new HttpError(403, "Your login can't open that");
      return page.route[2]({ ...c, params: page.params, user });
    }
  }
  if (request.method === "GET" && path === "/api/health") return new Response("ok");

  if (path.startsWith("/api/admin/")) {
    requireSecrets(env);
    checkSameOrigin(request);
    const sub = path.slice("/api/admin".length);
    if (request.method === "POST" && sub === "/login") return admin.login(c);
    const user = await currentUser(request, env, env.DB);
    if (!user) throw new HttpError(401, "Please log in");
    const a = find(ADMIN, request.method, sub);
    if (!a) throw new HttpError(404, "Not found");
    if (!allowed(user, a.route[2])) throw new HttpError(403, "Your login can't do that. Ask the owner.");
    return a.route[3]({ ...c, params: a.params, user });
  }
  if (path === "/" || path === "/admin") return Response.redirect(`${url.origin}/admin/`, 302);
  throw new HttpError(404, "Not found");
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return preflight(request, env);
    let response;
    try {
      response = await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) response = fail(e.status, e.message, e.extra);
      else {
        console.error("unhandled", request.method, new URL(request.url).pathname, e.stack || e.message);
        response = fail(500, "Something went wrong on our side. Please try again.");
      }
    }
    return withCors(response, request, env);
  },

  // Every 10 minutes: unpaid online orders expire. Every night (02:00 India time): backup to Telegram.
  async scheduled(event, env) {
    if (event.cron === "30 20 * * *") await sendBackupToTelegram(env, env.DB);
    else await expireUnpaid(env.DB);
  },
};
