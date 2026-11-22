// The small bridge between the counter page and Windows: list printers and print silently.
// The main process only answers requests from the shop's own server pages.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("serenNative", {
  printers: () => ipcRenderer.invoke("printers"),
  printHtml: (html, opts) => ipcRenderer.invoke("print-html", String(html), { printer: String((opts && opts.printer) || ""), paper: Number((opts && opts.paper) || 80) }),
});

// only the app's own setup / offline pages (local files) can change the server address
if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("serenSetup", {
    getServer: () => ipcRenderer.invoke("get-server"),
    setServer: (url) => ipcRenderer.invoke("set-server", String(url || "")),
    retry: () => ipcRenderer.invoke("retry"),
  });
}
