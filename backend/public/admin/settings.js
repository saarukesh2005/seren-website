/* Settings tab: shop & UPI, pickup/delivery, hours, GST bills, and the accounts export. */
SA.settings = (function () {
  "use strict";
  const { esc, api, toast, toPaise, toRupees } = SA;
  const $ = (s) => document.querySelector(s);
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];
  const MONEY = ["deliveryFee", "freeDeliveryAbove", "minOrder"];
  let categories = {};

  const WA_LABELS = { paid: "Payment received", preparing: "Being made", ready: "Ready", out_for_delivery: "On the way", feedback: "Ask for feedback" };
  const HAS = { wa: false, telegram: false };
  let GSTWARN = [];
  const checkObj = (name, label, on) => `<label class="check"><input type="checkbox" name="${name}" ${on ? "checked" : ""}> ${esc(label)}</label>`;
  const rupeeObj = (name, label, paise) => `<label>${esc(label)}<span class="money"><input name="${name}" inputmode="decimal" value="${esc(toRupees(paise))}"></span></label>`;

  async function load() {
    const data = await api("/settings");
    HAS.wa = data.hasWhatsappToken; HAS.telegram = data.hasTelegram;
    GSTWARN = data.gstWarnings || [];
    SA.state.settings = data.settings;
    categories = data.categories;
    return data.settings;
  }

  const text = (name, label, s, help = "", attrs = "") =>
    `<label>${esc(label)}${help ? ` <span class="help">${esc(help)}</span>` : ""}<input name="${name}" value="${esc(s[name])}" ${attrs}></label>`;
  const num = (name, label, s, help = "") => text(name, label, s, help, 'inputmode="numeric"');
  const rupee = (name, label, s, help = "") =>
    `<label>${esc(label)}${help ? ` <span class="help">${esc(help)}</span>` : ""}<span class="money"><input name="${name}" inputmode="decimal" value="${esc(toRupees(s[name]))}"></span></label>`;
  const check = (name, label, s) => `<label class="check"><input type="checkbox" name="${name}" ${s[name] ? "checked" : ""}> ${esc(label)}</label>`;
  const rateSelect = (name, value) => `<select name="${name}">${RATES.map((r) => `<option value="${r}" ${Number(value) === r ? "selected" : ""}>${r}%</option>`).join("")}</select>`;

  function render() {
    const s = SA.state.settings;
    const ready = s.upiId && s.acceptingOrders;
    $("#settingsForm").innerHTML = `
      <fieldset><legend>Shop &amp; UPI</legend>
        <div class="full">${check("acceptingOrders", "Taking online orders", s)}
          <span class="help">${ready ? "Customers can order and pay on the website." : "Switch this on once your UPI ID and prices are set."}</span></div>
        ${text("upiId", "UPI ID that receives payments", s, "a business UPI ID works best", 'placeholder="seren@okhdfcbank" autocomplete="off"')}
        ${text("upiName", "Name shown in the UPI app", s)}
        ${text("storeName", "Shop name", s)}
        ${text("phone", "Shop phone", s, "shown to customers on their order page")}
        <label class="full">Shop address<textarea name="address" rows="2">${esc(s.address)}</textarea></label>
        ${num("paymentMinutes", "Minutes to pay before an order expires", s)}
      </fieldset>
      <fieldset><legend>Dine-in, pickup &amp; delivery</legend>
        <div class="full">${check("dineIn", "Dine-in ordering from the table", s)} ${check("pickup", "Offer pickup", s)} ${check("delivery", "Offer delivery", s)}</div>
        ${rupee("deliveryFee", "Delivery fee", s)}
        ${rupee("freeDeliveryAbove", "Free delivery above", s, "0 = never free")}
        ${rupee("minOrder", "Minimum order for delivery", s, "0 = no minimum")}
        <label class="full">Your tables <span class="help">comma-separated, e.g. 1, 2, 3, Patio 1; empty = guests type any table number</span><input name="dineInTables" value="${esc(s.dineInTables)}" placeholder="1, 2, 3, 4, 5, 6"></label>
        <label class="full">Website address <span class="help">the table QR codes open this</span><input name="siteUrl" value="${esc(s.siteUrl)}" inputmode="url"></label>
        <div class="full">${check("dineInPayLater", "Table guests can pay at the end (one bill per table)", s)}
          <span class="help">Only works from the printed table cards. Orders go straight to the kitchen; you make the bill in the Tables tab.</span></div>
        <div class="full"><a class="btn plum" href="tables.html" target="_blank" rel="noopener">Print table QR codes</a>
          <button class="btn ghost small" type="button" id="rotateTables">Make old QR cards stop working</button>
          <span class="help">Save settings first if you changed the tables. Use "stop working" if a card was photographed or lost, then print new ones.</span></div>
        <label class="full">Delivery pincodes <span class="help">comma-separated; empty = deliver anywhere</span><input name="deliveryPincodes" value="${esc(s.deliveryPincodes)}" placeholder="600004, 600018"></label>
      </fieldset>
      <fieldset><legend>Hours &amp; time slots</legend>
        <label>Opens<input type="time" name="openTime" value="${esc(s.openTime)}"></label>
        <label>Closes<input type="time" name="closeTime" value="${esc(s.closeTime)}"></label>
        ${num("slotMinutes", "Slot length (minutes)", s)}
        ${num("prepMinutes", "Earliest order (minutes from now)", s)}
        ${num("maxDaysAhead", "Take orders up to (days ahead)", s)}
        <div class="full"><span class="help">Closed on</span><div class="days">${DAYS.map((d, i) => `<label class="check"><input type="checkbox" name="closedDays" value="${i}" ${s.closedDays.includes(i) ? "checked" : ""}> ${d}</label>`).join("")}</div></div>
        <div class="full"><span class="help">Made to order (need notice)</span><div class="days">${Object.entries(categories).map(([k, l]) => `<label class="check"><input type="checkbox" name="preorderCategories" value="${esc(k)}" ${s.preorderCategories.includes(k) ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div></div>
        ${num("preorderNoticeDays", "Notice needed (days)", s)}
      </fieldset>
      <fieldset><legend>Bills &amp; GST</legend>
        ${GSTWARN.length ? `<div class="full gst-warn" role="status"><b>Check before you bill:</b><ul>${GSTWARN.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
        <div class="full"><span class="help">How you are registered for GST — this decides what your bills say</span>
          <fieldset class="seg"><legend class="sr-only">GST type</legend>
            <label><input type="radio" name="gstType" value="none" ${!s.gstin ? "checked" : ""}><span>Not registered</span></label>
            <label><input type="radio" name="gstType" value="regular" ${s.gstin && s.gstScheme !== "composition" ? "checked" : ""}><span>Regular GST</span></label>
            <label><input type="radio" name="gstType" value="composition" ${s.gstin && s.gstScheme === "composition" ? "checked" : ""}><span>Composition</span></label>
          </fieldset>
          <span class="help">Not registered: a plain bill, no GST. Regular: a <b>Tax Invoice</b> with CGST + SGST. Composition: a <b>Bill of Supply</b> — you pay a flat 5% yourself and must not charge GST to customers.</span></div>
        <div class="full"><button class="btn ghost small" type="button" id="cafePreset">Café setup: restaurant service 5% (SAC 996331) for every section</button>
          <span class="help">The usual GST for food a café serves — dine-in, takeaway and delivery (CBIC circular 164/2021). Ask your CA if some items are sold as packed goods instead; you can set those per item in Menu.</span></div>
        <p class="full help">Leave GSTIN empty for a simple bill without GST. Ask your accountant for the right HSN codes and GST rates.</p>
        ${text("legalName", "Legal business name", s)}
        ${text("gstin", "GSTIN", s, "15 characters", 'maxlength="15" autocomplete="off"')}
        ${text("stateName", "State (place of supply)", s, "", 'placeholder="Tamil Nadu"')}
        ${text("invoicePrefix", "Bill number prefix", s, "e.g. SRN → SRN/2627/00001", 'maxlength="4"')}
        ${text("fssaiNo", "FSSAI licence number", s, "14 digits; must be printed on every bill and shown online", 'inputmode="numeric" maxlength="14" autocomplete="off"')}
        <div class="full">${check("pricesIncludeGst", "My prices already include GST", s)}</div>
        <div class="full taxgrid"><b>Category</b><b>HSN / SAC</b><b>GST</b>
          ${Object.entries(categories).map(([k, l]) => `<span>${esc(l)}</span><input name="hsn:${esc(k)}" value="${esc(s.tax[k]?.hsn || "")}" inputmode="numeric" maxlength="8" aria-label="${esc(l)} HSN">${rateSelect(`rate:${k}`, s.tax[k]?.rate || 0)}`).join("")}
          <span>Delivery charge</span><input name="hsn:__delivery" value="${esc(s.deliveryTax.hsn)}" inputmode="numeric" maxlength="8" aria-label="Delivery SAC">${rateSelect("rate:__delivery", s.deliveryTax.rate)}
        </div>
        <label class="full">Note printed on every bill<input name="invoiceNote" value="${esc(s.invoiceNote)}" maxlength="300"></label>
      </fieldset>
      <fieldset><legend>WhatsApp</legend>
        <label>Shop WhatsApp number <span class="help">91 + mobile, e.g. 919876543210. Customers can order and message you here.</span><input name="whatsappNumber" value="${esc(s.whatsappNumber)}" inputmode="numeric" maxlength="12"></label>
        <p class="full help">Ready-made messages for the order screen. {name}, {code}, {total} and {link} are filled in for you.</p>
        ${Object.entries(WA_LABELS).map(([k, l]) => `<label class="full">${esc(l)}<textarea name="tpl:${k}" rows="2" maxlength="500">${esc(s.waTemplates[k] || "")}</textarea></label>`).join("")}
        <details class="full"><summary><b>Automatic messages (paid, optional)</b></summary>
          <p class="help">Sends "payment received" and "order ready" by itself through Meta's WhatsApp Business Platform (about ₹0.12–0.15 per message).
          Needs a Meta business account, a separate phone number, approved templates, and the WHATSAPP_TOKEN secret (${HAS.wa ? "set ✓" : "not set yet"}).</p>
          <div class="formgrid">
            ${checkObj("waApi.enabled", "Send automatically", s.waApi.enabled)}
            <label>Phone number ID<input name="waApi.phoneNumberId" value="${esc(s.waApi.phoneNumberId)}" inputmode="numeric"></label>
            <label>"Payment received" template<input name="waApi.paidTemplate" value="${esc(s.waApi.paidTemplate)}" placeholder="order_paid"></label>
            <label>"Order ready" template<input name="waApi.readyTemplate" value="${esc(s.waApi.readyTemplate)}" placeholder="order_ready"></label>
            <label>Template language<input name="waApi.lang" value="${esc(s.waApi.lang)}"></label>
            <label>API version<input name="waApi.version" value="${esc(s.waApi.version)}"></label>
          </div>
        </details>
      </fieldset>
      <fieldset><legend>Loyalty &amp; reviews</legend>
        <div class="full">${checkObj("loyalty.enabled", "Loyalty points", s.loyalty.enabled)}
          <span class="help">Customers earn points on paid orders (by mobile number). Staff spend them on the counter bill.</span></div>
        ${rupeeObj("loyalty.earnEvery", "1 point for every", s.loyalty.earnEvery)}
        ${rupeeObj("loyalty.pointValue", "Each point is worth", s.loyalty.pointValue)}
        <label class="full">Google review link <span class="help">happy customers (4–5 stars) are invited to post a review</span><input name="googleReviewUrl" value="${esc(s.googleReviewUrl)}" placeholder="https://g.page/r/..."></label>
      </fieldset>
      <fieldset><legend>Bill extras &amp; staff limits</legend>
        ${rupeeObj("charges.packing", "Packing charge per takeaway / delivery order", s.charges.packing)}
        <label>Service charge for dine-in (%) <span class="help">0 = off. It is always optional for the guest: staff can remove it.</span><input name="charges.servicePercent" inputmode="decimal" value="${esc(String(s.charges.servicePercent))}"></label>
        <div class="full">${checkObj("charges.roundOff", "Round bills to the nearest rupee", s.charges.roundOff)}</div>
        <label>SAC code for charges<input name="charges.hsn" value="${esc(s.charges.hsn)}" inputmode="numeric" maxlength="8"></label>
        <label>Staff may give up to (% discount) <span class="help">more needs a manager's PIN</span><input name="approvals.discountPercent" inputmode="numeric" value="${esc(String(s.approvals.discountPercent))}"></label>
        <label>Staff may spend up to (points) <span class="help">more needs a manager's PIN</span><input name="approvals.points" inputmode="numeric" value="${esc(String(s.approvals.points))}"></label>
        <div class="full">${checkObj("approvals.counterUpiNeedsRef", "Counter UPI bills need the UPI reference (stops \"UPI\" bills that were really cash)", s.approvals.counterUpiNeedsRef)}</div>
        <div class="full">${checkObj("lowStockAlerts", "Tell me on Telegram when a raw material runs low", { v: s.lowStockAlerts }.v)}</div>
      </fieldset>
      <fieldset><legend>Kitchen stations</legend>
        <div class="full"><span class="help">Made fresh when ordered — counter bills with these go to the kitchen screen. Bills with only ready-made items (from the display) are marked handed over at once.</span>
          <div class="days">${Object.entries(categories).map(([k, l]) => `<label class="check"><input type="checkbox" name="madeToOrder" value="${esc(k)}" ${(s.madeToOrder || []).includes(k) ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div></div>
        <label class="full">Stations <span class="help">comma-separated, e.g. Kitchen, Bakery, Drinks. Each gets its own kitchen screen and tickets.</span><input name="stations.list" value="${esc(s.stations.list.join(", "))}"></label>
        <div class="full taxgrid"><b>Category</b><b>Made at</b><b></b>
          ${Object.entries(categories).map(([k, l]) => `<span>${esc(l)}</span><select name="station:${esc(k)}">${s.stations.list.map((st) => `<option ${(s.stations.byCategory[k] || s.stations.list[0]) === st ? "selected" : ""}>${esc(st)}</option>`).join("")}</select><span></span>`).join("")}
        </div>
      </fieldset>
      <fieldset><legend>Swiggy, Zomato &amp; other apps</legend>
        <p class="full help">Orders from these apps are entered at the counter (button "Swiggy · Zomato · ONDC") or sent in automatically by a connector. Commission is only used to show what the app will pay you.</p>
        <div class="full taxgrid"><b>App</b><b>Commission %</b><b></b>
          ${s.platforms.map((p, i) => `<input name="plat.name:${i}" value="${esc(p.name)}" aria-label="App name"><input name="plat.comm:${i}" value="${esc(String(p.commission))}" inputmode="decimal" aria-label="${esc(p.name)} commission"><input type="hidden" name="plat.id:${i}" value="${esc(p.id)}"><span></span>`).join("")}
          <input name="plat.name:new" placeholder="Add another app" aria-label="New app name"><input name="plat.comm:new" inputmode="decimal" placeholder="%" aria-label="New app commission"><span></span>
        </div>
      </fieldset>
      <fieldset><legend>Your approval PIN</legend>
        <p class="full help">Managers and you approve big discounts, voids and refunds at the counter with a short PIN (4–8 digits). Set managers' PINs in Staff below.</p>
        <label>New PIN<input id="ownerPin" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password"></label>
        <div><button class="btn ghost small" type="button" id="savePin">Save my PIN</button></div>
      </fieldset>
      <div class="save-bar"><span class="err" id="setErr" role="alert"></span><button class="btn primary" type="submit">Save settings</button></div>`;
    const f = $("#settingsForm");
    f.querySelector("#rotateTables").addEventListener("click", async () => {
      if (!window.confirm("Printed table QR codes will stop working. You'll need to print new ones. Continue?")) return;
      try {
        const { settings } = await api("/settings", { tableKeyVersion: SA.state.settings.tableKeyVersion + 1 });
        SA.state.settings = settings;
        toast("Old table cards no longer work. Print the new ones.");
      } catch (ex) { toast(ex.message, true); }
    });
    f.querySelector("#cafePreset").addEventListener("click", () => {
      Object.keys(categories).forEach((k) => { f.elements.namedItem(`hsn:${k}`).value = "996331"; f.elements.namedItem(`rate:${k}`).value = "5"; });
      f.elements.namedItem("charges.hsn").value = "996331";
      toast("Every section set to 5% restaurant service. Press Save settings.");
    });
    f.querySelector("#savePin").addEventListener("click", async () => {
      const pin = f.querySelector("#ownerPin").value.trim();
      try { await api("/approval-pin", { pin }); f.querySelector("#ownerPin").value = ""; toast("Your approval PIN is saved"); }
      catch (ex) { toast(ex.message, true); }
    });
    SA.staff.render();
  }

  function collect(f) {
    const el = (n) => f.elements.namedItem(n);
    const out = {};
    ["upiId", "upiName", "storeName", "phone", "address", "deliveryPincodes", "dineInTables", "siteUrl", "openTime", "closeTime", "legalName", "gstin", "stateName", "invoicePrefix", "invoiceNote", "fssaiNo"].forEach((k) => { out[k] = el(k).value.trim(); });
    ["paymentMinutes", "slotMinutes", "prepMinutes", "maxDaysAhead", "preorderNoticeDays"].forEach((k) => { out[k] = Number(el(k).value); });
    ["acceptingOrders", "dineIn", "pickup", "delivery", "pricesIncludeGst"].forEach((k) => { out[k] = el(k).checked; });
    for (const k of MONEY) {
      const p = toPaise(el(k).value);
      if (Number.isNaN(p)) throw new Error("Money fields take numbers only");
      out[k] = p || 0;
    }
    out.closedDays = [...f.querySelectorAll('[name="closedDays"]:checked')].map((c) => Number(c.value));
    out.preorderCategories = [...f.querySelectorAll('[name="preorderCategories"]:checked')].map((c) => c.value);
    out.tax = Object.fromEntries(Object.keys(categories).map((k) => [k, { hsn: el(`hsn:${k}`).value.trim(), rate: Number(el(`rate:${k}`).value) }]));
    out.deliveryTax = { hsn: el("hsn:__delivery").value.trim(), rate: Number(el("rate:__delivery").value) };
    out.dineInPayLater = el("dineInPayLater").checked;
    out.whatsappNumber = el("whatsappNumber").value.trim();
    out.googleReviewUrl = el("googleReviewUrl").value.trim();
    out.waTemplates = Object.fromEntries(Object.keys(WA_LABELS).map((k) => [k, el(`tpl:${k}`).value]));
    out.waApi = {
      enabled: el("waApi.enabled").checked, phoneNumberId: el("waApi.phoneNumberId").value.trim(), paidTemplate: el("waApi.paidTemplate").value.trim(),
      readyTemplate: el("waApi.readyTemplate").value.trim(), lang: el("waApi.lang").value.trim(), version: el("waApi.version").value.trim(),
    };
    const earn = toPaise(el("loyalty.earnEvery").value);
    const worth = toPaise(el("loyalty.pointValue").value);
    if (Number.isNaN(earn) || Number.isNaN(worth)) throw new Error("Loyalty amounts take numbers only");
    out.loyalty = { enabled: el("loyalty.enabled").checked, earnEvery: earn || 10000, pointValue: worth || 100 };
    const packing = toPaise(el("charges.packing").value);
    if (Number.isNaN(packing)) throw new Error("Packing charge takes numbers only");
    out.charges = { packing: packing || 0, servicePercent: Number(el("charges.servicePercent").value) || 0, roundOff: el("charges.roundOff").checked, hsn: el("charges.hsn").value.trim() };
    out.approvals = { discountPercent: Number(el("approvals.discountPercent").value) || 0, points: Number(el("approvals.points").value) || 0, counterUpiNeedsRef: el("approvals.counterUpiNeedsRef").checked };
    out.lowStockAlerts = el("lowStockAlerts").checked;
    const gstType = (f.querySelector('[name="gstType"]:checked') || {}).value || "regular";
    if (gstType === "none") out.gstin = "";
    else if (!out.gstin) throw new Error("Type your GSTIN, or choose \"Not registered\"");
    out.gstScheme = gstType === "composition" ? "composition" : "regular";
    out.madeToOrder = [...f.querySelectorAll('[name="madeToOrder"]:checked')].map((c) => c.value);
    const list = el("stations.list").value.split(",").map((x) => x.trim()).filter(Boolean);
    out.stations = { list, byCategory: Object.fromEntries(Object.keys(categories).map((k) => [k, el(`station:${k}`) ? el(`station:${k}`).value : list[0]]).filter(([, v]) => list.includes(v))) };
    const apps = [];
    const current = SA.state.settings.platforms;
    current.forEach((p, i) => { const name = el(`plat.name:${i}`).value.trim(); if (name) apps.push({ id: p.id, name, commission: Number(el(`plat.comm:${i}`).value) || 0 }); });
    const newName = el("plat.name:new").value.trim();
    if (newName) apps.push({ id: newName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "app", name: newName, commission: Number(el("plat.comm:new").value) || 0 });
    out.platforms = apps;
    return out;
  }

  async function save(e) {
    e.preventDefault();
    const err = $("#setErr");
    err.textContent = "";
    try {
      const { settings, gstWarnings } = await api("/settings", collect(e.target));
      SA.state.settings = settings;
      GSTWARN = gstWarnings || [];
      toast(GSTWARN.length ? "Saved. A few GST details still need you (see the list)." : "Settings saved");
      render();
      document.dispatchEvent(new CustomEvent("sa:settings"));
    } catch (ex) {
      err.textContent = ex.message;
      toast(ex.message, true);
    }
  }

  function start() { $("#settingsForm").addEventListener("submit", save); }
  return { start, load, render };
})();
