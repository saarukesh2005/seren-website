// SEREN Counter for Windows: opens the shop's counter (from the SEREN order system) in its own window,
// prints receipts silently to the chosen printer, and puts the customer screen on a second monitor.
const { app, BrowserWindow, ipcMain, Menu, net, screen, shell, session } = require("electron");
const fs = require("fs");
const path = require("path");

if (process.env.SEREN_USER_DATA) app.setPath("userData", process.env.SEREN_USER_DATA); // testing: a clean settings folder
const CONFIG = path.join(app.getPath("userData"), "config.json");
const PDF_TEST_DIR = process.env.SEREN_PRINT_TO_PDF || ""; // testing only: save receipts as PDF instead of printing

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

// The shop server address (the order system). http is only allowed for this computer, for testing.
function cleanServer(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return null; }
  const local = ["127.0.0.1", "localhost"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
  return u.origin;
}

let win = null;
let display = null;
const server = () => cleanServer(process.env.SEREN_SERVER || readConfig().server);
const isFromServer = (url) => { try { return server() !== null && new URL(url).origin === server(); } catch { return false; } };

function loadApp() {
  const s = server();
  if (!s) return win.loadFile(path.join(__dirname, "setup.html"));
  return win.loadURL(`${s}/pos/`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 820, minWidth: 1000, minHeight: 640,
    title: "SEREN Counter", backgroundColor: "#662937", icon: path.join(__dirname, "build", "icon.png"), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
  });
  win.maximize();

  // Stay on the shop's own pages; anything else opens in the normal web browser.
  win.webContents.on("will-navigate", (e, url) => {
    if (isFromServer(url)) return;
    // the app's own setup pages: only reachable from each other, never from a web page
    if (url.startsWith("file://") && win.webContents.getURL().startsWith("file://")) return;
    e.preventDefault();
    if (url.startsWith("https://")) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isFromServer(url) && ["/pos/display", "/pos/display.html"].includes(new URL(url).pathname)) { openDisplay(url); return { action: "deny" }; }
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  // Server unreachable and nothing saved yet: show a friendly page with a "try again" button.
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && isFromServer(url)) win.loadFile(path.join(__dirname, "offline.html"));
  });
  loadApp();
}

// The customer screen goes full-screen on the second monitor, if there is one.
function openDisplay(url) {
  if (display && !display.isDestroyed()) { display.focus(); return; }
  const others = screen.getAllDisplays().filter((d) => d.id !== screen.getPrimaryDisplay().id);
  const target = others[0] || screen.getPrimaryDisplay();
  display = new BrowserWindow({
    x: target.bounds.x + 40, y: target.bounds.y + 40, width: 1024, height: 768, title: "SEREN · Customer screen",
    backgroundColor: "#662937", icon: path.join(__dirname, "build", "icon.png"), autoHideMenuBar: true, fullscreen: others.length > 0,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  display.webContents.on("will-navigate", (e) => e.preventDefault());
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

ipcMain.handle("print-html", async (event, html, opts = {}) => {
  if (!fromOurPage(event) || typeof html !== "string" || html.length > 300000) throw new Error("Can't print that");
  const paper = [58, 80].includes(Number(opts.paper)) ? Number(opts.paper) : 80;
  const job = new BrowserWindow({ show: false, width: Math.round((paper / 25.4) * 96), height: 600, webPreferences: { sandbox: true, contextIsolation: true, javascript: true } });
  try {
    // receipts are plain pages: this rule stops any script inside one from running
    const locked = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">${html}`;
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
  if (!s) throw new Error("The address must start with https://");
  try {
    const res = await net.fetch(`${s}/api/health`);
    if (!res.ok || (await res.text()) !== "ok") throw new Error();
  } catch {
    throw new Error("Couldn't reach a SEREN order system at that address");
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

