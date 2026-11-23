/* Builds every product section from SEREN_MENU and runs the order box. */
(function () {
  "use strict";
  const MENU = window.SEREN_MENU;
  const CFG = window.SEREN_CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const img = (name) => (name ? `img/${name}.webp` : "");
  const STORE_KEY = "seren-box-v1";
  const MAX_QTY = 99;
  const CAT = new Map((window.SEREN_CATALOG || []).map((c) => [c.id, c]));
  const money = (paise) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

  /* ---------- order box state (immutable updates) ---------- */
  // A bag line is one product with one set of choices: the same cake with "Large" and with "Small" are two lines.
  // Its key is the product id, plus the sorted choices (as "group-choice" ids) when there are any.
  const OPT_RE = /^[a-z0-9-]{1,40}$/;
  const MAX_OPTS = 10;
  const lineKey = (id, opts) => (opts && opts.length ? `${id}|${opts.join(",")}` : id);
  const cleanOpts = (raw) => (Array.isArray(raw) && raw.length <= MAX_OPTS && raw.every((o) => typeof o === "string" && OPT_RE.test(o)) ? [...new Set(raw)].sort() : null);
  const cleanLabels = (raw) => (Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(0, MAX_OPTS).map((x) => x.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 40)) : []);
  // Products the owner adds in the dashboard (ids start with "x-") are not in the built-in catalog until the shop's data arrives.
  const CUSTOM_ID = /^x-[a-z0-9-]{1,60}$/;
  const PHOTO_KEY = /^[A-Z0-9]{12}$/;
  let box = loadBox();
  // Only products that really are in the catalog (or dashboard-made, checked again once the shop answers), with a whole
  // quantity from 1 to 99 and well-formed choices, are kept from storage. Names and pictures of built-in products are
  // rebuilt from the catalog, never taken from what was stored.
  function loadBox() {
    let stored;
    try { const raw = localStorage.getItem(STORE_KEY); stored = raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const clean = {};
    for (const [storedKey, entry] of Object.entries(stored)) {
      if (!entry || typeof entry !== "object") continue;
      const id = typeof entry.id === "string" ? entry.id : storedKey;
      const qty = entry.qty;
      const opts = entry.opts === undefined ? [] : cleanOpts(entry.opts);
      if (!opts || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) continue;
      const item = CAT.get(id);
      const base = item
        ? { id: item.id, name: item.name, img: item.img || null, ...(item.photo ? { photo: item.photo } : {}) }
        : CUSTOM_ID.test(id) && typeof entry.name === "string" && entry.name.trim()
          ? { id, name: entry.name.trim().slice(0, 80), img: null, ...(PHOTO_KEY.test(entry.photo || "") ? { photo: entry.photo } : {}) }
          : null;
      if (!base) continue;
      const key = lineKey(id, opts);
      clean[key] = { ...base, key, qty, opts, labels: opts.length ? cleanLabels(entry.labels) : [] };
    }
    return clean;
  }
  function saveBox(next) {
    box = next;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch (e) { /* storage unavailable: box still works for this visit */ }
    renderBox();
  }
  function addItem(item, fromEl, picked) {
    const opts = picked ? picked.opts : [];
    const key = lineKey(item.id, opts);
    const prev = box[key];
    flyToBox(fromEl, item);
    saveBox({ ...box, [key]: { id: item.id, key, name: item.name, img: item.img || null, ...(item.photo ? { photo: item.photo } : {}), opts, labels: picked ? picked.names : [], qty: Math.min(MAX_QTY, (prev ? prev.qty : 0) + 1) } });
    bumpBadge();
    toast(`${item.name} added to your box`);
  }
  function setQty(key, qty) {
    if (!box[key]) return;
    if (qty <= 0) { const { [key]: _gone, ...rest } = box; saveBox(rest); return; }
    saveBox({ ...box, [key]: { ...box[key], qty: Math.min(MAX_QTY, qty) } });
  }
  const count = () => Object.values(box).reduce((n, i) => n + i.qty, 0);
  const qtyOf = (id) => Object.values(box).reduce((n, i) => n + (i.id === id ? i.qty : 0), 0);

  /* ---------- item choices (size, add-ons...) ---------- */
  // The option groups the owner set for a product, from the shop's data: [{ id, name, pick, required, choices: [{ id, name, price }] }]
  let optionIndex = { shop: null, map: new Map() };
  function groupsOf(id) {
    const shop = window.SEREN_SHOP;
    if (!shop || !Array.isArray(shop.products)) return [];
    if (optionIndex.shop !== shop) optionIndex = { shop, map: new Map(shop.products.map((p) => [p.id, Array.isArray(p.options) ? p.options : []])) };
    return optionIndex.map.get(id) || [];
  }
  // Checks chosen options against the groups the way the server does. Returns { ok, extra (paise), names }.
  function resolveOpts(id, opts) {
    const left = new Set(opts || []);
    let extra = 0;
    const names = [];
    for (const g of groupsOf(id)) {
      const hits = g.choices.filter((ch) => left.has(`${g.id}-${ch.id}`));
      hits.forEach((ch) => left.delete(`${g.id}-${ch.id}`));
      if ((g.pick === "one" && hits.length > 1) || (g.required && !hits.length)) return { ok: false, extra: 0, names: [] };
      for (const ch of hits) { extra += Number(ch.price) || 0; names.push(ch.name); }
    }
    return { ok: left.size === 0, extra, names };
  }
  // The price of one piece of a bag line (base + extras), or null when it can't be ordered right now.
  function unitPrice(line) {
    const shop = window.SEREN_SHOP;
    const p = shop && shop.prices[line.id];
    const r = resolveOpts(line.id, line.opts);
    return p && r.ok ? p.price + r.extra : null;
  }
  // The names of a line's choices: from the shop's data when it is loaded, otherwise what was saved with the line
  const lineChoices = (line) => {
    if (!(line.opts || []).length) return [];
    const r = window.SEREN_SHOP ? resolveOpts(line.id, line.opts) : null;
    return r && r.ok ? r.names : line.labels || [];
  };
  const lineText = (line) => { const c = lineChoices(line); return c.length ? `${line.name} (${c.join(", ")})` : line.name; };

  // Every "Add" button reads its name and picture from the shared catalog (src/catalog.js).
  const addBtn = (id) => {
    const item = CAT.get(id);
    if (!item) throw new Error(`Product ${id} is missing from the catalog`);
    return `<button class="add" type="button" data-add='${esc(JSON.stringify({ id: item.id, name: item.name, img: item.img, photo: item.photo || null }))}'>+ Add to box</button>`;
  };

  /* ---------- sections ---------- */
  function marquee() {
    const words = ["Bomboloni", "Entremets", "Illusory fruit", "Gelato", "Cookies", "Bonbons", "Choux", "Focaccia"];
    const one = words.map((w) => `<span>${esc(w)}<svg aria-hidden="true"><use href="#burst"/></svg></span>`).join("");
    $("#marquee").innerHTML = one + one;
  }

  function bomboloni() {
    $("#bombRail").innerHTML = MENU.bomboloni.map((b, i) => `
      <article class="paper" data-pid="${esc(b.id)}" style="--r:${i % 2 ? 1.2 : -1.2}deg">
        <div class="ph"><img src="${img(b.img)}" alt="${esc(b.en)} bombolone cut open" loading="lazy"></div>
        <span class="it">${esc(b.en)}</span>
        <h3>${esc(b.name)}</h3>
        <p>${esc(b.desc)}</p>
        <div class="row">${addBtn(b.id)}</div>
      </article>`).join("");
  }

  function cookies() {
    $("#cookieGrid").innerHTML = MENU.cookies.map((c) => `
      <article class="cookie" data-pid="${esc(c.id)}">
        <div class="disc"><img src="${img(c.img)}" alt="${esc(c.name)} cookie" loading="lazy">${c.hover ? `<img class="alt" src="${img(c.hover)}" alt="" loading="lazy">` : ""}</div>
        <h3>${esc(c.name)}</h3><p>${esc(c.desc)}</p>
        ${addBtn(c.id)}
      </article>`).join("");
  }

  function fruit() {
    const list = $("#fruitList");
    list.innerHTML = MENU.fruit.map((f, i) => `
      <button type="button" role="tab" id="tab-${f.id}" aria-selected="${i === 0}" data-i="${i}">${esc(f.name)}<small>${esc(f.desc)}</small></button>`).join("");
    list.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-i]");
      if (b) showFruit(Number(b.dataset.i));
    });
    showFruit(0, true);
  }
  function showFruit(i, first) {
    const f = MENU.fruit[i];
    document.querySelectorAll("#fruitList button").forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.i) === i)));
    const visual = f.img ? `<img src="${img(f.img)}" alt="${esc(f.name)} illusory fruit dessert">` : `<div class="blob">${esc(f.name)}</div>`;
    $("#fruitView").innerHTML = `<div class="ring"></div>${visual}<ul class="layers">${f.layers.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
    $("#fruitDetail").innerHTML = `<span class="hand" style="font-size:26px">${esc(f.name)}, cut open</span>${addBtn(f.id)}`;
    renderBox(); // fresh buttons need their price / "in box" labels
    if (!first) document.dispatchEvent(new CustomEvent("seren:fruit"));
  }

  function entremets() {
    const tabs = $("#entTabs");
    tabs.innerHTML = MENU.entremets.map((e, i) => `
      <button type="button" role="tab" id="tab-${e.id}" aria-selected="${i === 0}" data-i="${i}"><b>${esc(e.name)}</b><small>${esc(e.kicker)}</small></button>`).join("");
    tabs.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-i]");
      if (b) showCake(Number(b.dataset.i));
    });
    showCake(0, true);
  }
  function showCake(i, first) {
    const e = MENU.entremets[i];
    document.querySelectorAll("#entTabs button").forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.i) === i)));
    $("#cakeStack").innerHTML = e.layers.map(([label, color]) => `<div class="layer" style="background-color:${esc(color)}"><span>${esc(label)}</span></div>`).join("");
    $("#entAdd").innerHTML = addBtn(e.id);
    renderBox(); // fresh buttons need their price / "in box" labels
    if (!first) document.dispatchEvent(new CustomEvent("seren:cake"));
  }

  function pastry() {
    $("#pastryGrid").innerHTML = MENU.pastry.map((p) => `
      <article class="pcard" data-pid="${esc(p.id)}">
        <div class="ph"><img src="${img(p.img)}" alt="${esc(p.name)}" loading="lazy">${p.hover ? `<img class="alt" src="${img(p.hover)}" alt=""><span class="peek">hover to cut open</span>` : ""}</div>
        <div class="row"><h3>${esc(p.name)}</h3>${addBtn(p.id)}</div>
        <p>${esc(p.desc)}</p>
      </article>`).join("");
  }

  function gelato(kind) {
    const list = MENU.gelato[kind];
    $("#scoops").innerHTML = list.map(([name, base, fleck]) => {
      const id = window.serenGelatoId(kind, name);
      return `<article class="scoop" data-pid="${esc(id)}">
        <div class="drop"><div class="ball" style="background:${esc(base)};--fleck:${esc(fleck)}"><i></i><b></b></div></div><div class="cone"></div>
        <h3>${esc(name)}</h3>${addBtn(id)}
      </article>`;
    }).join("");
    document.querySelectorAll("#gTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.k === kind)));
    renderBox(); // fresh buttons need their price / "in box" labels
    document.dispatchEvent(new CustomEvent("seren:scoops"));
  }

  function chocolates() {
    $("#bonbons").innerHTML = MENU.chocolates.bonbons.map((b) => `
      <article class="bonbon" data-pid="${esc(b.id)}"><span class="bob"><img src="${img(b.img)}" alt="${esc(b.name)} bonbon" loading="lazy"></span><h3>${esc(b.name)}</h3><p>${esc(b.desc)}</p>
      ${addBtn(b.id)}</article>`).join("");
    $("#truffles").innerHTML = MENU.chocolates.truffles.map((t) => `
      <article class="truffle" data-pid="${esc(t.id)}"><img src="${img(t.img)}" alt="${esc(t.name)}" loading="lazy">
      <div><h3>${esc(t.name)}</h3><p>${esc(t.desc)}</p>${addBtn(t.id)}</div></article>`).join("");
  }

  const mark = (veg) => (veg === null || veg === undefined ? `<span class="mark-gap"></span>` : `<span class="mark ${veg ? "veg" : "non"}" role="img" aria-label="${veg ? "Vegetarian" : "Non-vegetarian"}"></span>`);

  function kitchen() {
    $("#slabs").innerHTML = MENU.focaccia.map((s) => `
      <article class="slab-card" data-pid="${esc(s.id)}"><div class="ph"><img src="${img(s.img)}" alt="${esc(s.name)} focaccia slab" loading="lazy"></div>
      <div class="body"><h3>${mark(s.veg)}${esc(s.name)}</h3><p>${esc(s.desc)}</p>${addBtn(s.id)}</div></article>`).join("");
    $("#kmenu").innerHTML = MENU.kitchen.map((g) => `
      <div><h3>${esc(g.group)}</h3><ul>${g.items.map((it) => `<li ${it.img ? `data-img="${img(it.img)}"` : ""}>${mark(it.veg)}<span>${esc(it.name)}</span></li>`).join("")}</ul></div>`).join("");
    peekImages();
  }

  function peekImages() {
    const peek = $("#peek"); const pimg = peek.querySelector("img");
    document.querySelectorAll("#kmenu li[data-img]").forEach((li) => {
      li.addEventListener("mouseenter", () => { pimg.src = li.dataset.img; pimg.alt = li.textContent.trim(); peek.classList.add("on"); });
      li.addEventListener("mouseleave", () => peek.classList.remove("on"));
    });
    window.addEventListener("mousemove", (e) => {
      const w = 260, h = 330;
      const x = e.clientX + 150 + w / 2 > window.innerWidth ? e.clientX - 150 : e.clientX + 150;
      const y = Math.min(Math.max(e.clientY, h / 2 + 8), window.innerHeight - h / 2 - 8);
      peek.style.left = `${x}px`; peek.style.top = `${y}px`;
    }, { passive: true });
  }

  function visit() {
    const facts = [["Instagram", `@${CFG.instagram}`], ["Address", CFG.address], ["Hours", CFG.hours], ["Phone", CFG.phone]].filter(([, v]) => v);
    $("#visitFacts").innerHTML = facts.map(([k, v]) => `<div>${esc(k)} <span>${esc(v)}</span></div>`).join("");
    $("#igLink").href = `https://instagram.com/${encodeURIComponent(CFG.instagram)}`;
    $("#igLink").textContent = `Follow @${CFG.instagram}`;
  }

  /* ---------- drawer ---------- */
  function orderText() {
    const lines = Object.values(box).map((i) => `${i.qty} × ${lineText(i)}`);
    return `Hi SEREN! I'd like to order:\n${lines.join("\n")}`;
  }
  function renderBox() {
    $("#boxCount").textContent = String(count());
    const items = Object.values(box);
    const list = $("#boxList");
    if (!items.length) {
      list.innerHTML = `<li class="empty" style="display:grid;border:0"><span class="hand">Your box is empty</span><span>Tap "+ Add to box" on anything you'd like.</span></li>`;
    } else {
      list.innerHTML = items.map((i) => `<li>${i.photo ? `<img src="${esc(photoUrl(i.photo))}" alt="">` : i.img ? `<img src="${esc(img(i.img))}" alt="">` : `<img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">`}
        <span class="n">${esc(i.name)}${choiceList(i)}${linePrice(i)}</span>
        <span class="qty"><button type="button" data-q="${esc(i.key)}" data-d="-1" aria-label="One fewer ${esc(lineText(i))}">−</button><b>${esc(Number(i.qty) | 0)}</b><button type="button" data-q="${esc(i.key)}" data-d="1" aria-label="One more ${esc(lineText(i))}">+</button></span></li>`).join("");
    }
    suggest(items);
    boxBar(items);
    const wa = $("#waBtn");
    const hasWa = Boolean(CFG.whatsapp) && items.length > 0;
    wa.hidden = !hasWa;
    if (hasWa) wa.href = `https://wa.me/${encodeURIComponent(CFG.whatsapp)}?text=${encodeURIComponent(orderText())}`;
    $("#copyBtn").disabled = !items.length;
    const shop = window.SEREN_SHOP; // set by checkout.js when the order system is online
    document.querySelectorAll(".add[data-add]").forEach((b) => {
      const id = JSON.parse(b.dataset.add).id;
      const inBox = qtyOf(id) > 0;
      const p = shop && shop.prices[id];
      const soldOut = Boolean(p && p.left === 0);
      const blocked = Boolean(shop && shop.live && (!p || !p.available || soldOut));
      b.disabled = blocked && !inBox;
      b.classList.toggle("added", inBox);
      b.classList.toggle("off", b.disabled);
      const few = p && p.left !== undefined && p.left <= 5 ? ` · ${p.left} left` : "";
      const from = groupsOf(id).length ? "from " : ""; // the price grows with the choices
      const hasChoices = groupsOf(id).length > 0;
      // simple items in the box get a − n + stepper right on the card (like the big delivery apps);
      // items with choices keep an "add another" button, because each pick can be different
      const step = !hasChoices && inBox && box[lineKey(id, [])];
      b.hidden = Boolean(step);
      let st = b.nextElementSibling && b.nextElementSibling.classList.contains("step") ? b.nextElementSibling : null;
      if (step) {
        if (!st) { st = document.createElement("span"); st.className = "step"; b.after(st); }
        const key = lineKey(id, []);
        const label = esc(b.closest("[data-pid]")?.querySelector("h3")?.textContent || "");
        st.innerHTML = `<button type="button" data-q="${esc(key)}" data-d="-1" aria-label="One fewer ${label}">−</button><b aria-live="polite">${esc(Number(step.qty) | 0)}</b><button type="button" data-q="${esc(key)}" data-d="1" aria-label="One more ${label}" ${step.qty >= MAX_QTY ? "disabled" : ""}>+</button>`;
      } else if (st) st.remove();
      b.textContent = inBox ? `✓ ${qtyOf(id)} in box · add another` : blocked ? (soldOut ? "Sold out today" : p ? "Sold out" : "Coming soon") : p ? `+ Add · ${from}${money(p.price)}${few}` : "+ Add to box";
    });
    document.dispatchEvent(new CustomEvent("seren:box"));
  }
  // The bottom bar on phones: "2 items · ₹360   View box →" (the total uses the shop's live prices when known).
  function boxBar(items) {
    const bar = $("#boxBar");
    if (!bar) return;
    const count = items.reduce((n, i) => n + (Number(i.qty) | 0), 0);
    const priced = window.SEREN_SHOP && window.SEREN_SHOP.live ? items.map((i) => (unitPrice(i) === null ? null : unitPrice(i) * i.qty)) : [];
    const total = priced.length && priced.every((x) => x !== null) ? priced.reduce((a, b) => a + b, 0) : null;
    $("#boxBarSum").textContent = total === null ? `${count} item${count === 1 ? "" : "s"}` : `${count} item${count === 1 ? "" : "s"} · ${money(total)}`;
    bar.hidden = !count;
    document.documentElement.classList.toggle("has-boxbar", count > 0);
  }

  // "Goes well with": up to three small add-ons from sections not yet in the box (one per section),
  // only things that can be ordered right now. Made-to-order cakes are never suggested.
  function suggest(items) {
    const el = $("#boxAlso");
    if (!el) return;
    const shop = window.SEREN_SHOP;
    const inBox = new Set(items.map((i) => i.id));
    const taken = new Set(items.map((i) => (CAT.get(i.id) || {}).category));
    const orderable = (c) => !shop || !shop.live || Boolean(shop.prices[c.id] && shop.prices[c.id].available && shop.prices[c.id].left !== 0);
    const pick = [];
    for (const c of CAT.values()) {
      if (pick.length >= 3) break;
      if (inBox.has(c.id) || taken.has(c.category) || c.category === "entremets" || !orderable(c) || groupsOf(c.id).length) continue;
      taken.add(c.category);
      pick.push(c);
    }
    el.hidden = !items.length || !pick.length;
    el.innerHTML = el.hidden ? "" : `<h3 class="also-h">Goes well with</h3><ul>${pick.map((c) => {
      const p = shop && shop.prices[c.id];
      return `<li data-pid="${esc(c.id)}">${c.img ? `<img src="${esc(img(c.img))}" alt="" loading="lazy" width="56" height="56">` : ""}
        <span class="also-n"><b>${esc(c.name)}</b>${p ? `<small>${esc(money(p.price))}</small>` : ""}</span>${addBtn(c.id)}</li>`;
    }).join("")}</ul>`;
  }

  // the choices of a bag line, under its name (one span each, so each can be translated)
  function choiceList(i) {
    const names = lineChoices(i);
    return names.length ? `<small class="ch">${names.map((n) => `<span>${esc(n)}</span>`).join("")}</small>` : "";
  }
  function linePrice(i) {
    const p = window.SEREN_SHOP && window.SEREN_SHOP.prices[i.id];
    if (!p) return "";
    const unit = unitPrice(i);
    return `<small>${p.available && unit !== null ? `${esc(money(unit * i.qty))}${p.unit ? ` · ${esc(p.unit)}` : ""}` : "Not available right now"}</small>`;
  }
  function setDrawer(on) {
    const d = $("#drawer");
    d.classList.toggle("on", on); d.setAttribute("aria-hidden", String(!on)); d.inert = !on;
    $("#scrim").classList.toggle("on", on);
    document.documentElement.classList.toggle("box-open", on);
    document.dispatchEvent(new CustomEvent("seren:drawer", { detail: { open: on } }));
  }
  function openBox() { setDrawer(true); $("#closeBox").focus(); }
  function closeBox() { setDrawer(false); $("#boxBtn").focus(); }

  /* the product's picture (or a sugar dot) arcs into the box button */
  function flyToBox(fromEl, item) {
    if (!fromEl || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !Element.prototype.animate) return;
    const card = fromEl.closest("article, .fruit-stage, .ent-stage");
    const srcImg = card && card.querySelector("img");
    const start = (srcImg || fromEl).getBoundingClientRect();
    const end = $("#boxBtn").getBoundingClientRect();
    const fly = document.createElement(item.img ? "img" : "div");
    fly.className = "fly";
    if (item.img) { fly.src = img(item.img); fly.alt = ""; }
    document.body.appendChild(fly);
    const sx = start.left + start.width / 2 - 32, sy = start.top + start.height / 2 - 32;
    const ex = end.left + end.width / 2 - 32, ey = end.top + end.height / 2 - 32;
    const mx = (sx + ex) / 2, my = Math.min(sy, ey) - 140;
    fly.animate([
      { transform: `translate(${sx}px,${sy}px) scale(1.4)`, opacity: 1 },
      { transform: `translate(${mx}px,${my}px) scale(1) rotate(-20deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${ex}px,${ey}px) scale(.25) rotate(20deg)`, opacity: .4 },
    ], { duration: 850, easing: "cubic-bezier(.5,0,.3,1)" }).onfinish = () => fly.remove();
  }

  /* wavy chocolate-drip edges, generated so they always span the full width */
  function drips() {
    document.querySelectorAll(".drip path").forEach((path, n) => {
      let d = "M0 0H1440V24", x = 1440;
      let k = n * 7 + 3;
      const rnd = () => { k = (k * 9301 + 49297) % 233280; return k / 233280; };
      while (x > 0) {
        const w = 50 + rnd() * 70, depth = 30 + rnd() * 52, nx = Math.max(x - w, 0), mid = (x + nx) / 2;
        d += ` C${x - w * 0.15} 24 ${mid + w * 0.22} ${depth} ${mid} ${depth} S${nx + w * 0.15} 24 ${nx} 24`;
        x = nx;
      }
      path.setAttribute("d", d + " V0Z");
    });
  }

  async function copyOrder() {
    const text = orderText();
    try { await navigator.clipboard.writeText(text); $("#boxStatus").textContent = "Order copied. Paste it into a message to SEREN."; }
    catch (e) { $("#boxStatus").textContent = "Couldn't copy automatically. Here's your order: " + text.replace(/\n/g, ", "); }
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("on");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 1800);
  }
  function bumpBadge() { const b = $("#boxBtn"); b.classList.remove("bump"); void b.offsetWidth; b.classList.add("bump"); }

  /* ---------- the "choose your options" sheet (size, add-ons...) ---------- */
  let choosing = null; // { item, trigger, groups, base } while the sheet is open
  let sheet = null;
  function choiceSheet() {
    if (sheet) return sheet;
    sheet = document.createElement("dialog");
    sheet.className = "tabsheet optsheet";
    sheet.setAttribute("data-lenis-prevent", "");
    document.body.appendChild(sheet);
    sheet.addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === sheet) sheet.close(); });
    sheet.addEventListener("close", () => { const t = choosing && choosing.trigger; choosing = null; if (t && t.isConnected && !t.disabled) t.focus({ preventScroll: true }); });
    sheet.addEventListener("change", () => { if (choosing) refreshChoices(); });
    sheet.addEventListener("submit", (e) => { e.preventDefault(); submitChoices(); });
    return sheet;
  }
  const pickedOpts = () => [...sheet.querySelectorAll("input[data-opt]:checked")].map((i) => i.dataset.opt);
  function refreshChoices() {
    const { groups, base } = choosing;
    const chosen = new Set(pickedOpts());
    const extra = groups.reduce((n, g) => n + g.choices.reduce((m, ch) => m + (chosen.has(`${g.id}-${ch.id}`) ? Number(ch.price) || 0 : 0), 0), 0);
    sheet.querySelector(".os-go").textContent = `Add to box · ${money(base + extra)}`;
    sheet.querySelector(".err").textContent = "";
  }
  function openChoices(item, trigger) {
    const groups = groupsOf(item.id);
    const p = window.SEREN_SHOP && window.SEREN_SHOP.prices[item.id];
    const dlg = choiceSheet();
    choosing = { item, trigger, groups, base: p ? Number(p.price) || 0 : 0 };
    dlg.setAttribute("aria-label", item.name);
    const group = (g) => {
      const many = g.pick === "many";
      const input = (value, attrs, label, priceHtml) => `<label class="os-c"><input type="${many ? "checkbox" : "radio"}" name="g-${esc(g.id)}" ${attrs}><span class="os-n">${esc(label)}</span>${priceHtml}</label>`;
      return `<fieldset class="os-group" data-g="${esc(g.id)}">
        <legend>${esc(g.name)} <span class="opt">${g.required ? "Required" : many ? "Pick any" : "Optional"}</span></legend>
        ${!many && !g.required ? `<label class="os-c"><input type="radio" name="g-${esc(g.id)}" checked><span class="os-n">None</span></label>` : ""}
        ${g.choices.map((ch) => input(ch.id, `value="${esc(ch.id)}" data-opt="${esc(`${g.id}-${ch.id}`)}"`, ch.name, Number(ch.price) > 0 ? `<span class="os-p">+${esc(money(Number(ch.price)))}</span>` : "")).join("")}
      </fieldset>`;
    };
    dlg.innerHTML = `<form class="ts-in os-form" novalidate>
      <div class="ts-head"><h2>${esc(item.name)}</h2><button class="close" type="button" data-close aria-label="Close">×</button></div>
      ${groups.map(group).join("")}
      <p class="err" role="alert"></p>
      <button class="pill fill os-go" type="submit"></button>
    </form>`;
    refreshChoices();
    if (!dlg.open) dlg.showModal();
  }
  function submitChoices() {
    const { item, trigger, groups } = choosing;
    const opts = pickedOpts();
    const err = sheet.querySelector(".err");
    const have = new Set(opts);
    const missing = groups.find((g) => g.required && !g.choices.some((ch) => have.has(`${g.id}-${ch.id}`)));
    if (missing) {
      err.textContent = `Please choose: ${missing.name}`;
      const first = sheet.querySelector(`fieldset[data-g="${CSS.escape(missing.id)}"] input`);
      if (first) first.focus();
      return;
    }
    const r = resolveOpts(item.id, opts);
    if (!r.ok) { err.textContent = "That choice isn't available any more. Please pick again."; return; }
    const picked = { opts: [...new Set(opts)].sort(), names: r.names };
    sheet.close();
    addItem(item, trigger, picked);
  }

  function wire() {
    document.addEventListener("click", (e) => {
      const add = e.target.closest(".add[data-add]");
      if (add) {
        const item = JSON.parse(add.dataset.add);
        if (groupsOf(item.id).length) openChoices(item, add); else addItem(item, add); // items with choices ask first
        return;
      }
      const q = e.target.closest("[data-q]");
      if (q) { const key = q.dataset.q; setQty(key, (box[key]?.qty || 0) + Number(q.dataset.d)); }
    });
    $("#boxBtn").addEventListener("click", openBox);
    if ($("#boxBar")) $("#boxBar").addEventListener("click", openBox);
    $("#openBox2").addEventListener("click", openBox);
    $("#closeBox").addEventListener("click", closeBox);
    $("#scrim").addEventListener("click", closeBox);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#drawer").classList.contains("on")) closeBox(); });
    $("#copyBtn").addEventListener("click", copyOrder);
    $("#gTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-k]"); if (b) gelato(b.dataset.k); });
  }

  // photos the owner uploads in the dashboard are served by the order system
  function photoUrl(key) { return `${String(CFG.api || "").replace(/\/+$/, "")}/img/${encodeURIComponent(key)}`; }

  // Dashboard edits (new name or photo): later "Add" buttons and the box use the new details.
  function updateItem(item) {
    CAT.set(item.id, { ...(CAT.get(item.id) || {}), ...item });
    document.querySelectorAll(".add[data-add]").forEach((b) => {
      const d = JSON.parse(b.dataset.add);
      if (d.id === item.id) b.dataset.add = JSON.stringify({ ...d, name: item.name, photo: item.photo || null });
    });
    const lines = Object.entries(box).filter(([, l]) => l.id === item.id);
    if (lines.length) saveBox({ ...box, ...Object.fromEntries(lines.map(([k, l]) => [k, { ...l, name: item.name, photo: item.photo || null }])) });
  }

  // Once the shop's data arrives, dashboard-made products that no longer exist (or are hidden) leave the bag.
  function dropUnknownCustom() {
    const shop = window.SEREN_SHOP;
    if (!shop || !Array.isArray(shop.products)) return;
    const live = new Set(shop.products.filter((p) => !p.hidden).map((p) => p.id));
    const keep = Object.entries(box).filter(([, l]) => CAT.has(l.id) || live.has(l.id));
    if (keep.length !== Object.keys(box).length) saveBox(Object.fromEntries(keep));
  }
  document.addEventListener("seren:shop", () => { dropUnknownCustom(); renderBox(); showFssai(); }); // prices are known now: totals, bar, suggestions
  // FSSAI licence number in the footer (food businesses selling online must show it)
  function showFssai() {
    const el = $("#fssai");
    const shop = window.SEREN_SHOP;
    const no = String((shop && shop.settings && shop.settings.fssaiNo) || CFG.fssai || "").replace(/\D/g, "");
    if (!el || !/^\d{14}$/.test(no)) return;
    el.textContent = `FSSAI Lic. No. ${no}`;
    el.hidden = false;
  }
  showFssai();

  // the online-ordering scripts (checkout.js, products.js) use these
  window.SEREN_BOX = { items: () => Object.values(box), clear: () => saveBox({}), rerender: renderBox, addBtn, updateItem, photoUrl, unitPrice, lineText, groupsOf };

  drips(); marquee(); bomboloni(); cookies(); fruit(); entremets(); pastry(); gelato("signature"); chocolates(); kitchen(); visit();
  wire(); renderBox();
})();
