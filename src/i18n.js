/* English / தமிழ் switch for the whole customer website.
   English is the default; a visitor's choice is remembered on their device.
   Every piece of text on the page (and anything shown later: box, checkout, payment, messages)
   is looked up in the Tamil dictionary (i18n-ta.js) and swapped in, so the page code stays in English. */
(function () {
  "use strict";
  const KEY = "seren-lang-v1";
  const FONTS = "https://fonts.googleapis.com/css2?family=Catamaran:wght@800;900&family=Kavivanar&family=Noto+Sans+Tamil:wght@400;500;600;700&display=swap";
  const WORDMARK_TA = "செரென்"; // SEREN in Tamil: செ | ரென் mirrors SE | REN

  function saved() {
    try { return localStorage.getItem(KEY) === "ta" ? "ta" : "en"; } catch (e) { return "en"; }
  }
  const lang = saved();
  window.SEREN_LANG = lang;
  window.serenLocale = () => (lang === "ta" ? "ta-IN" : "en-IN");
  // "16:30" -> "4:30 pm", or in Tamil "மாலை 4:30" (morning / noon / evening / night)
  window.serenTimeLabel = (hhmm) => {
    const [h, m] = String(hhmm).split(":").map(Number);
    const clock = `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}`;
    if (lang !== "ta") return `${clock} ${h < 12 ? "am" : "pm"}`;
    const part = h < 12 ? "காலை" : h < 16 ? "மதியம்" : h < 19 ? "மாலை" : "இரவு";
    return `${part} ${clock}`;
  };

  const TA = window.SEREN_TA || { words: {}, patterns: [] };
  const words = TA.words;
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  // Translates one string (exact phrase first, then the patterns for text with numbers or names in it).
  function tr(text) {
    const key = norm(text);
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(words, key)) return words[key];
    for (const [re, fn] of TA.patterns) {
      const m = key.match(re);
      if (m) return fn(m, name);
    }
    const asName = name(key); // e.g. "Mango sorbet" in the box
    return asName !== key ? asName : null;
  }
  // product names, including the catalog's "… cookie", "… gelato" style names
  function name(n) {
    const key = norm(n);
    if (Object.prototype.hasOwnProperty.call(words, key)) return words[key];
    for (const [suffix, ta] of TA.suffixes || []) {
      if (key.endsWith(` ${suffix}`)) {
        const base = key.slice(0, -suffix.length - 1);
        return `${Object.prototype.hasOwnProperty.call(words, base) ? words[base] : base} ${ta}`;
      }
    }
    return key;
  }
  window.serenT = (s) => (lang === "ta" ? tr(s) ?? s : s);

  /* ---------- the switch button ---------- */
  function addSwitch() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lang-btn";
    btn.setAttribute("data-no-i18n", "");
    btn.lang = lang === "ta" ? "en" : "ta";
    btn.setAttribute("aria-label", lang === "ta" ? "Switch to English" : "தமிழுக்கு மாற்றவும் (Switch to Tamil)");
    btn.innerHTML = lang === "ta" ? `<span class="lb-a">EN</span><span class="lb-b">English</span>` : `<span class="lb-a">த</span><span class="lb-b">தமிழ்</span>`;
    btn.addEventListener("click", () => {
      try { localStorage.setItem(KEY, lang === "ta" ? "en" : "ta"); } catch (e) { /* storage blocked: switch for this visit only */ }
      document.documentElement.classList.add("lang-leaving");
      setTimeout(() => location.reload(), 220);
    });
    const spot = document.querySelector(".nav .box-btn") || document.querySelector(".op-top .pill");
    if (spot) spot.parentNode.insertBefore(btn, spot);
  }
  addSwitch();
  if (lang !== "ta") return;

  /* ---------- Tamil: fonts, page language, and translating text as it appears ---------- */
  document.documentElement.lang = "ta";
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = FONTS;
  document.head.appendChild(link);
  if (words[document.title]) document.title = words[document.title];
  const meta = document.querySelector('meta[name="description"]');
  if (meta && words[meta.content]) meta.content = words[meta.content];

  const ATTRS = ["placeholder", "aria-label", "alt", "title"];
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "CODE"]);

  function translateNode(node) {
    if (node.nodeType === 3) {
      const out = tr(node.data);
      if (out !== null && out !== norm(node.data)) {
        const lead = node.data.match(/^\s*/)[0];
        const trail = node.data.match(/\s*$/)[0];
        node.data = lead + out + trail;
      }
      return;
    }
    if (node.nodeType !== 1 || SKIP.has(node.tagName) || node.closest("[data-no-i18n]")) return;
    for (const a of ATTRS) {
      const v = node.getAttribute(a);
      if (v) { const out = tr(v); if (out !== null && out !== v) node.setAttribute(a, out); }
    }
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.nodeType === 1 && (SKIP.has(n.tagName) || n.hasAttribute("data-no-i18n")) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n = walker.nextNode();
    while (n) {
      if (n.nodeType === 3) translateNode(n);
      else for (const a of ATTRS) { const v = n.getAttribute(a); if (v) { const out = tr(v); if (out !== null && out !== v) n.setAttribute(a, out); } }
      n = walker.nextNode();
    }
    // form boxes: translate their hints, never what the customer typed
    node.querySelectorAll("input[placeholder], textarea[placeholder], input[aria-label], select[aria-label]").forEach((f) => {
      for (const a of ["placeholder", "aria-label"]) { const v = f.getAttribute(a); if (v) { const out = tr(v); if (out !== null && out !== v) f.setAttribute(a, out); } }
    });
  }
  window.serenTranslate = translateNode;

  // Tamil names and descriptions the owner typed in the dashboard (for renamed and new products)
  const api = String((window.SEREN_CONFIG || {}).api || "").replace(/\/+$/, "");
  if (api) {
    fetch(`${api}/api/menu`).then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (!data || !Array.isArray(data.products)) return;
      let added = false;
      for (const p of data.products) {
        if (p.nameTa) { words[norm(p.name)] = p.nameTa; added = true; }
        if (p.descriptionTa && p.description) { words[norm(p.description)] = p.descriptionTa; added = true; }
      }
      if (added) translateNode(document.body);
    }).catch(() => { /* offline: built-in Tamil still shows */ });
  }

  // product details in the menu data (so cards, tabs and layers are built in Tamil)
  const M = window.SEREN_MENU;
  if (M) {
    const item = (i) => ({ ...i, desc: i.desc ? tr(i.desc) ?? i.desc : i.desc, kicker: i.kicker ? tr(i.kicker) ?? i.kicker : i.kicker,
      notes: (i.notes || []).map((x) => tr(x) ?? x), layers: Array.isArray(i.layers) ? i.layers.map((l) => (Array.isArray(l) ? [tr(l[0]) ?? l[0], l[1]] : tr(l) ?? l)) : i.layers });
    window.SEREN_MENU = {
      ...M,
      bomboloni: M.bomboloni.map((b) => ({ ...item(b), en: tr(b.en) ?? b.en })),
      cookies: M.cookies.map(item), fruit: M.fruit.map(item), entremets: M.entremets.map(item), pastry: M.pastry.map(item), focaccia: M.focaccia.map(item),
      chocolates: { truffles: M.chocolates.truffles.map(item), bonbons: M.chocolates.bonbons.map(item) },
      kitchen: M.kitchen.map((g) => ({ ...g, group: tr(g.group) ?? g.group })),
    };
  }

  // The big SEREN (opening animation, logo, footer) rebuilt from whole Tamil letters, one span each,
  // so the rise-in, wobble and scroll-split animations work exactly as in English.
  function wordmark() {
    const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("ta", { granularity: "grapheme" }) : null;
    const letters = seg ? [...seg.segment(WORDMARK_TA)].map((x) => x.segment) : ["செ", "ரெ", "ன்"];
    document.querySelectorAll(".hero-word, .logo, footer .big").forEach((el) => {
      el.replaceChildren(...letters.map((ch) => { const s = document.createElement("span"); s.textContent = ch; return s; }));
      el.dataset.left = "1"; // how many letters sit on the dark side of the seam
      el.classList.add("wordmark-ta");
      if (el.hasAttribute("aria-label")) el.setAttribute("aria-label", el.classList.contains("logo") ? "செரென் முகப்பு" : WORDMARK_TA);
    });
  }
  wordmark();

  translateNode(document.body); // the page as written, before the animations split headings into letters
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "characterData") translateNode(m.target);
      else if (m.type === "attributes") translateNode(m.target.nodeType === 1 ? m.target : m.target.parentNode);
      else m.addedNodes.forEach(translateNode);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
})();
