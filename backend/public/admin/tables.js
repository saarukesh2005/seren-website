/* Printable table cards. Each QR opens the SEREN website set to that table, with a signature
   that proves it came from the real card (needed for pay-at-the-end and calling a waiter). */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function draw(links) {
    $("#grid").innerHTML = links.map(({ table, url }) => {
      const qr = window.qrcode(0, "M");
      qr.addData(url);
      qr.make();
      return `<article class="card"><div class="brand">SEREN</div><div class="qr">${qr.createSvgTag({ cellSize: 6, margin: 1, scalable: true })}</div>
        <div class="t">Table ${esc(table)}</div><div class="hand">Scan to order &amp; pay</div><div class="small">Order from your phone, call a waiter, pay by UPI.</div></article>`;
    }).join("");
  }

  async function start() {
    try {
      const res = await fetch("/api/admin/table-links", { headers: { "X-Seren": "1" }, credentials: "same-origin" });
      if (res.status === 401) { $("#msg").textContent = "Please log in to the dashboard first."; return; }
      if (res.status === 403) { $("#msg").textContent = "Only the owner can print table cards."; return; }
      const { links, custom } = await res.json();
      $("#msg").textContent = custom ? "No tables in Settings yet, so these are tables 1–6. Add your real table names in Settings → Dine-in." : "";
      draw(links);
    } catch (e) {
      $("#msg").textContent = "Couldn't load the table cards. Check your internet and reload.";
    }
  }
  $("#print").addEventListener("click", () => window.print());
  $("#close").addEventListener("click", () => { window.close(); setTimeout(() => { location.href = "./"; }, 150); });
  start();
})();
