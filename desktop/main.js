// SEREN Counter for Windows: opens the shop's counter (from the SEREN order system) in its own window,
// prints receipts silently to the chosen printer, and puts the customer screen on a second monitor.
const { app, BrowserWindow, dialog, ipcMain, Menu, net, screen, session, shell } = require("electron");
const fs = require("fs");
const path = require("path");

// Test hooks (environment variables, plain-http localhost) exist only when running from source.
// An installed (packaged) build ignores them all.
const DEV = !app.isPackaged;
const NO_AUXCLICK = "Auxclick"; // no middle-click "open in new window" behaviour in any window

if (DEV && process.env.SEREN_USER_DATA) app.setPath("userData", process.env.SEREN_USER_DATA); // testing: a clean settings folder
const CONFIG = path.join(app.getPath("userData"), "config.json");
const PDF_TEST_DIR = DEV ? process.env.SEREN_PRINT_TO_PDF || "" : ""; // testing only: save receipts as PDF instead of printing

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

// The shop server address (the order system). Installed builds accept only https:// with a proper
// web name (not a raw IP number). Plain http to this computer is allowed only when running from source.
function cleanServer(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return null; }
  if (DEV && u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)) return u.origin;
  if (u.protocol !== "https:") return null;
  if (app.isPackaged && (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.includes(":"))) return null; // IPv4 / [IPv6]
  return u.origin;
}

let win = null;
let display = null;
const server = () => cleanServer((DEV && process.env.SEREN_SERVER) || readConfig().server);
const isFromServer = (url) => { try { return server() !== null && new URL(url).origin === server(); } catch { return false; } };

// Keeps a window on the shop's own pages. Anything else is simply refused (never handed to the OS).
// Frames may also be about:blank / about:srcdoc. `allowMain` lets the main frame move between our own
// pages (and, from the app's own local pages, between the setup/offline pages).
function guardNavigation(wc, { allowMain }) {
  const allowed = (url, isMainFrame) => {
    if (isFromServer(url)) return true;
    if (!isMainFrame) return url === "about:blank" || url === "about:srcdoc";
    return allowMain && url.startsWith("file://") && wc.getURL().startsWith("file://");
  };
  wc.on("will-navigate", (e) => { if (!(allowMain && allowed(e.url, true))) e.preventDefault(); });
  wc.on("will-redirect", (e) => { if (!allowed(e.url, e.isMainFrame)) e.preventDefault(); });
  wc.on("will-frame-navigate", (e) => { if (!e.isMainFrame && !allowed(e.url, false)) e.preventDefault(); });
  wc.setWindowOpenHandler(({ url }) => {
    if (allowMain && isFromServer(url) && ["/pos/display", "/pos/display.html"].includes(new URL(url).pathname)) openDisplay(url);
    // the one outside address the counter may open: a WhatsApp message to a customer (opens in WhatsApp / the browser)
    else if (allowMain && isFromServer(wc.getURL()) && isWhatsAppLink(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

// Only https://wa.me/<digits>?text=… (nothing else gets to the operating system).
function isWhatsAppLink(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "wa.me" && /^\/\d{10,15}$/.test(u.pathname) && !u.username && !u.password && !u.port
      && [...u.searchParams.keys()].every((k) => k === "text");
  } catch { return false; }
}

function loadApp() {
  const s = server();
  if (!s) return win.loadFile(path.join(__dirname, "setup.html"));
  return win.loadURL(`${s}/pos/`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 820, minWidth: 1000, minHeight: 640,
    title: "SEREN Counter", backgroundColor: "#662937", icon: path.join(__dirname, "build", "icon.png"), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false, disableBlinkFeatures: NO_AUXCLICK },
  });
  win.maximize();

  // Stay on the shop's own pages; everything else is blocked. The customer screen is the only new window.
  guardNavigation(win.webContents, { allowMain: true });
  // Server unreachable and nothing saved yet: show a friendly page with a "try again" button.
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && isFromServer(url)) win.loadFile(path.join(__dirname, "offline.html"));
  });
  loadApp();
}

// The customer screen goes full-screen on the second monitor, if there is one.
function openDisplay(url) {
  if (!isFromServer(url)) return;
  if (display && !display.isDestroyed()) { display.focus(); return; }
  const others = screen.getAllDisplays().filter((d) => d.id !== screen.getPrimaryDisplay().id);
  const target = others[0] || screen.getPrimaryDisplay();
  display = new BrowserWindow({
    x: target.bounds.x + 40, y: target.bounds.y + 40, width: 1024, height: 768, title: "SEREN · Customer screen",
    backgroundColor: "#662937", icon: path.join(__dirname, "build", "icon.png"), autoHideMenuBar: true, fullscreen: others.length > 0,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, disableBlinkFeatures: NO_AUXCLICK },
  });
  guardNavigation(display.webContents, { allowMain: false });
  display.loadURL(url);
}

/* ---------- silent receipt printing ---------- */
function fromOurPage(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return Boolean(url && isFromServer(url));
}

ipcMain.handle("printers", async (event) => {
  if (!fromOurPage(event)) return [];
  const list = await win.webContents.getPrintersAsync();
  return list.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault }));
});

const RECEIPT_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;
function withCsp(html) {
  if (/<head(\s[^>]*)?>/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (m) => m + RECEIPT_CSP);
  if (/<html(\s[^>]*)?>/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${RECEIPT_CSP}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${RECEIPT_CSP}</head><body>${html}</body></html>`;
}

ipcMain.handle("print-html", async (event, html, opts = {}) => {
  if (!fromOurPage(event) || typeof html !== "string" || html.length > 300000) throw new Error("Can't print that");
  const paper = [58, 80].includes(Number(opts.paper)) ? Number(opts.paper) : 80;
  const job = new BrowserWindow({ show: false, width: Math.round((paper / 25.4) * 96), height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, javascript: true, disableBlinkFeatures: NO_AUXCLICK } });
  // the receipt window never goes anywhere or opens anything
  job.webContents.on("will-navigate", (e) => e.preventDefault());
  job.webContents.on("will-redirect", (e) => e.preventDefault());
  job.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  try {
    // receipts are plain pages: this rule (placed inside the page's <head>) stops any script inside one from running.
    // JavaScript stays on only so the main process can measure the height below.
    const locked = withCsp(html);
    await job.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(locked)}`);
    // the receipt's own height (not the window's), so the printer doesn't feed blank paper
    const heightPx = await job.webContents.executeJavaScript("Math.ceil(document.body.getBoundingClientRect().height)");
    const microns = (px) => Math.round((px / 96) * 25400);
    const pageSize = { width: paper * 1000, height: Math.max(microns(heightPx) + 6000, 40000) };
    if (PDF_TEST_DIR) {
      const pdf = await job.webContents.printToPDF({ pageSize: { width: pageSize.width / 25400, height: pageSize.height / 25400 }, printBackground: true, margins: { marginType: "none" } });
      const file = path.join(PDF_TEST_DIR, `receipt-${Date.now()}.pdf`);
      fs.writeFileSync(file, pdf);
      return { ok: true, file };
    }
    await new Promise((resolve, reject) => {
      job.webContents.print({ silent: true, printBackground: true, deviceName: opts.printer || undefined, margins: { marginType: "none" }, pageSize },
        (ok, reason) => (ok ? resolve() : reject(new Error(reason || "Printer not ready"))));
    });
    return { ok: true };
  } finally {
    job.destroy();
  }
});

/* ---------- first-time setup: which shop server to use ---------- */
ipcMain.handle("set-server", async (event, raw) => {
  if (!event.senderFrame || !event.senderFrame.url.startsWith("file://")) throw new Error("Not allowed");
  const s = cleanServer(raw);
  if (!s) throw new Error("The address must start with https:// and use a web name (not an IP number)");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10000);
  try {
    const res = await net.fetch(`${s}/api/health`, { signal: abort.signal, redirect: "error" });
    if (!res.ok || (await res.text()) !== "ok") throw new Error();
  } catch {
    throw new Error("Couldn't reach a SEREN order system at that address");
  } finally {
    clearTimeout(timer);
  }
  // A real address is checked with the owner before it is saved (plain-http localhost is test-only).
  if (s.startsWith("https://")) {
    const { response } = await dialog.showMessageBox(win, {
      type: "question", title: "SEREN Counter", buttons: ["Connect", "Cancel"], defaultId: 1, cancelId: 1, noLink: true,
      message: `Connect this counter to ${new URL(s).hostname}?`,
      detail: "Only continue if this is your shop's own address.",
    });
    if (response !== 0) throw new Error("Not connected. Nothing was changed.");
  }
  writeConfig({ ...readConfig(), server: s });
  loadApp();
  return s;
});
ipcMain.handle("get-server", () => server() || "");
ipcMain.handle("retry", (event) => { if (event.senderFrame && event.senderFrame.url.startsWith("file://")) loadApp(); });

function menu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "SEREN", submenu: [
      { label: "Change shop server…", click: () => win.loadFile(path.join(__dirname, "setup.html")) },
      { role: "reload" }, { type: "separator" }, { role: "quit" },
    ] },
    { label: "View", submenu: [{ role: "togglefullscreen" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" }] },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    // the counter needs no camera, microphone, location or notifications from websites
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    menu();
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}

