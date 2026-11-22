/* Customer-facing screen: mirrors the bill, shows the UPI QR with the exact amount, then says thank you. */
(function () {
  "use strict";
  const $ = (s) => document.getElementById(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (p) => `₹${(Number(p || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
  let last = null;
  let thanksTimer;

  function show(id) { ["cart", "upi", "thanks"].forEach((s) => { $(s).hidden = s !== id; }); }

  function cart(msg) {
    last = msg;
    $("lines").innerHTML = msg.lines.length
      ? msg.lines.map((l) => `<li><span>${l.qty} × ${esc(l.name)}</span><b>${esc(money(l.amount))}</b></li>`).join("")
      : `<li class="muted">Welcome to SEREN</li>`;
    $("total").textContent = money(msg.total);
    show("cart");
  }

  const ch = "BroadcastChannel" in window ? new BroadcastChannel("seren-pos") : null;
  if (!ch) { document.body.innerHTML = "<p style='padding:40px'>This browser can't show the customer screen.</p>"; return; }
  ch.onmessage = ({ data: msg }) => {
    if (msg.type === "cart") {
      // right after a bill the counter clears; keep "thank you" up until the next customer's first item
      if (!msg.lines.length && !$("thanks").hidden) { last = msg; return; }
      clearTimeout(thanksTimer);
      cart(msg);
    }
    if (msg.type === "cartback" && last) cart(last);
    if (msg.type === "upi") {
      clearTimeout(thanksTimer);
      $("upiTotal").textContent = money(msg.total);
      if (msg.upi && window.qrcode) { const q = window.qrcode(0, "M"); q.addData(msg.upi); q.make(); $("qr").innerHTML = q.createSvgTag({ cellSize: 8, margin: 2, scalable: true }); }
      show("upi");
    }
    if (msg.type === "thanks") {
      $("changeLine").textContent = msg.change ? `Your change: ${money(msg.change)}` : "";
      show("thanks");
      thanksTimer = setTimeout(() => cart({ lines: [], total: 0 }), 6000);
    }
  };
})();
