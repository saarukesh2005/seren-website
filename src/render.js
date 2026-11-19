/* Builds every product section from SEREN_MENU and runs the order box. */
(function () {
  "use strict";
  const MENU = window.SEREN_MENU;
  const CFG = window.SEREN_CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const img = (name) => (name ? `img/${name}.webp` : "");
  const STORE_KEY = "seren-box-v1";

  /* ---------- order box state (immutable updates) ---------- */
  let box = loadBox();
  function loadBox() {
    try { const raw = localStorage.getItem(STORE_KEY); const v = raw ? JSON.parse(raw) : {}; return v && typeof v === "object" ? v : {}; }
    catch (e) { return {}; }
  }
  function saveBox(next) {
    box = next;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch (e) { /* storage unavailable: box still works for this visit */ }
    renderBox();
  }
  function addItem(item, fromEl) {
    const prev = box[item.id];
    flyToBox(fromEl, item);
    saveBox({ ...box, [item.id]: { id: item.id, name: item.name, img: item.img || null, qty: (prev ? prev.qty : 0) + 1 } });
    bumpBadge();
    toast(`${item.name} added to your box`);
  }
  function setQty(id, qty) {
    if (qty <= 0) { const { [id]: _gone, ...rest } = box; saveBox(rest); return; }
    saveBox({ ...box, [id]: { ...box[id], qty } });
  }
  const count = () => Object.values(box).reduce((n, i) => n + i.qty, 0);

  const addBtn = (item) =>
    `<button class="add" type="button" data-add='${esc(JSON.stringify({ id: item.id, name: item.name, img: item.img || null }))}'>+ Add to box</button>`;

  /* ---------- sections ---------- */
  function marquee() {
    const words = ["Bomboloni", "Entremets", "Illusory fruit", "Gelato", "Cookies", "Bonbons", "Choux", "Focaccia"];
    const one = words.map((w) => `<span>${esc(w)}<svg aria-hidden="true"><use href="#burst"/></svg></span>`).join("");
    $("#marquee").innerHTML = one + one;
  }

  function bomboloni() {
    $("#bombRail").innerHTML = MENU.bomboloni.map((b, i) => `
      <article class="paper" style="--r:${i % 2 ? 1.2 : -1.2}deg">
        <div class="ph"><img src="${img(b.img)}" alt="${esc(b.en)} bombolone cut open" loading="lazy"></div>
        <span class="it">${esc(b.en)}</span>
        <h3>${esc(b.name)}</h3>
        <p>${esc(b.desc)}</p>
        <div class="row">${addBtn({ id: b.id, name: b.name, img: b.img })}</div>
      </article>`).join("");
  }

  function cookies() {
    $("#cookieGrid").innerHTML = MENU.cookies.map((c) => `
      <article class="cookie">
        <div class="disc"><img src="${img(c.img)}" alt="${esc(c.name)} cookie" loading="lazy">${c.hover ? `<img class="alt" src="${img(c.hover)}" alt="" loading="lazy">` : ""}</div>
        <h3>${esc(c.name)}</h3><p>${esc(c.desc)}</p>
        ${addBtn({ id: c.id, name: `${c.name} cookie`, img: c.img })}
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
    $("#fruitDetail").innerHTML = `<span class="hand" style="font-size:26px">${esc(f.name)}, cut open</span>${addBtn({ id: f.id, name: `${f.name} illusory fruit`, img: f.img })}`;
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
    $("#entAdd").innerHTML = addBtn({ id: e.id, name: e.name, img: null });
    if (!first) document.dispatchEvent(new CustomEvent("seren:cake"));
  }

  function pastry() {
    $("#pastryGrid").innerHTML = MENU.pastry.map((p) => `
      <article class="pcard">
        <div class="ph"><img src="${img(p.img)}" alt="${esc(p.name)}" loading="lazy">${p.hover ? `<img class="alt" src="${img(p.hover)}" alt=""><span class="peek">hover to cut open</span>` : ""}</div>
        <div class="row"><h3>${esc(p.name)}</h3>${addBtn({ id: p.id, name: p.name, img: p.img })}</div>
        <p>${esc(p.desc)}</p>
      </article>`).join("");
  }

  function gelato(kind) {
    const list = MENU.gelato[kind];
    $("#scoops").innerHTML = list.map(([name, base, fleck]) => {
      const id = `gelato-${kind}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const label = kind === "sorbet" ? `${name} sorbet` : `${name} gelato`;
      return `<article class="scoop">
        <div class="drop"><div class="ball" style="background:${esc(base)};--fleck:${esc(fleck)}"><i></i><b></b></div></div><div class="cone"></div>
        <h3>${esc(name)}</h3>${addBtn({ id, name: label, img: null })}
      </article>`;
    }).join("");
    document.querySelectorAll("#gTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.k === kind)));
    document.dispatchEvent(new CustomEvent("seren:scoops"));
  }

  function chocolates() {
    $("#bonbons").innerHTML = MENU.chocolates.bonbons.map((b) => `
      <article class="bonbon"><span class="bob"><img src="${img(b.img)}" alt="${esc(b.name)} bonbon" loading="lazy"></span><h3>${esc(b.name)}</h3><p>${esc(b.desc)}</p>
      ${addBtn({ id: b.id, name: `${b.name} bonbon`, img: b.img })}</article>`).join("");
    $("#truffles").innerHTML = MENU.chocolates.truffles.map((t) => `
      <article class="truffle"><img src="${img(t.img)}" alt="${esc(t.name)}" loading="lazy">
      <div><h3>${esc(t.name)}</h3><p>${esc(t.desc)}</p>${addBtn({ id: t.id, name: t.name, img: t.img })}</div></article>`).join("");
  }

  const mark = (veg) => (veg === null || veg === undefined ? `<span class="mark-gap"></span>` : `<span class="mark ${veg ? "veg" : "non"}" role="img" aria-label="${veg ? "Vegetarian" : "Non-vegetarian"}"></span>`);

  function kitchen() {
    $("#slabs").innerHTML = MENU.focaccia.map((s) => `
      <article class="slab-card"><div class="ph"><img src="${img(s.img)}" alt="${esc(s.name)} focaccia slab" loading="lazy"></div>
      <div class="body"><h3>${mark(s.veg)}${esc(s.name)}</h3><p>${esc(s.desc)}</p>${addBtn({ id: s.id, name: `${s.name} slab`, img: s.img })}</div></article>`).join("");
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
    const lines = Object.values(box).map((i) => `${i.qty} × ${i.name}`);
    return `Hi SEREN! I'd like to order:\n${lines.join("\n")}`;
  }
  function renderBox() {
    $("#boxCount").textContent = String(count());
    const items = Object.values(box);
    const list = $("#boxList");
    if (!items.length) {
      list.innerHTML = `<li class="empty" style="display:grid;border:0"><span class="hand">Your box is empty</span><span>Tap "+ Add to box" on anything you'd like.</span></li>`;
    } else {
      list.innerHTML = items.map((i) => `<li>${i.img ? `<img src="${img(i.img)}" alt="">` : `<img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">`}
        <span class="n">${esc(i.name)}</span>
        <span class="qty"><button type="button" data-q="${esc(i.id)}" data-d="-1" aria-label="One fewer ${esc(i.name)}">−</button><b>${i.qty}</b><button type="button" data-q="${esc(i.id)}" data-d="1" aria-label="One more ${esc(i.name)}">+</button></span></li>`).join("");
    }
    const wa = $("#waBtn");
    const hasWa = Boolean(CFG.whatsapp) && items.length > 0;
    wa.hidden = !hasWa;
    if (hasWa) wa.href = `https://wa.me/${encodeURIComponent(CFG.whatsapp)}?text=${encodeURIComponent(orderText())}`;
    $("#copyBtn").disabled = !items.length;
    document.querySelectorAll(".add[data-add]").forEach((b) => {
      const id = JSON.parse(b.dataset.add).id;
      const inBox = Boolean(box[id]);
      b.classList.toggle("added", inBox);
      b.textContent = inBox ? `✓ In box (${box[id].qty})` : "+ Add to box";
    });
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

  function wire() {
    document.addEventListener("click", (e) => {
      const add = e.target.closest(".add[data-add]");
      if (add) { addItem(JSON.parse(add.dataset.add), add); return; }
      const q = e.target.closest("[data-q]");
      if (q) { const id = q.dataset.q; setQty(id, (box[id]?.qty || 0) + Number(q.dataset.d)); }
    });
    $("#boxBtn").addEventListener("click", openBox);
    $("#openBox2").addEventListener("click", openBox);
    $("#closeBox").addEventListener("click", closeBox);
    $("#scrim").addEventListener("click", closeBox);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#drawer").classList.contains("on")) closeBox(); });
    $("#copyBtn").addEventListener("click", copyOrder);
    $("#gTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-k]"); if (b) gelato(b.dataset.k); });
  }

  drips(); marquee(); bomboloni(); cookies(); fruit(); entremets(); pastry(); gelato("signature"); chocolates(); kitchen(); visit();
  wire(); renderBox();
})();
