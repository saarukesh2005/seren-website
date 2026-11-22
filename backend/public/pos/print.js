/* Printing receipts. In the SEREN Counter Windows app it prints silently to the chosen printer
   (no print window). In a normal browser it opens the browser's print window. */
window.POSPrint = (function () {
  "use strict";
  const native = window.serenNative || null; // provided by the Windows app (desktop/preload.js)

  async function printers() {
    return native ? native.printers() : [];
  }

  async function printHtml(html, { printer = "", paper = 80 } = {}) {
    if (native) return native.printHtml(html, { printer, paper });
    // browser: print from a hidden frame so the counter screen stays as it is
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    frame.srcdoc = html;
    document.body.appendChild(frame);
    await new Promise((r) => { frame.onload = r; });
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
    return { ok: true, dialog: true };
  }

  const api = { native: Boolean(native), printers, printHtml, printReceipt };

  async function printReceipt(model) {
    const prefs = POS.prefs();
    return api.printHtml(SerenReceipt.receiptHtml(model, { width: prefs.paper }), { printer: prefs.printer, paper: prefs.paper });
  }

  return api;
})();
