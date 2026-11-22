/* Shows the owner's dashboard edits on the website: renamed or hidden products, new photos,
   and brand-new products (in a "New at SEREN" section). Runs once the order system has answered. */
(function () {
  "use strict";
  const BOX = window.SEREN_BOX;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CATS = window.SEREN_CATEGORIES || {};
  let applied = false;

  function editCard(p) {
    const card = document.querySelector(`[data-pid="${CSS.escape(p.id)}"]`);
    const tab = document.getElementById(`tab-${p.id}`);
    if (p.hidden) {
      if (card) card.hidden = true;
      if (tab) tab.hidden = true;
      return;
    }
    if (card) {
      const h = card.querySelector("h3");
      const d = card.querySelector("p");
      if (h) h.lastChild.textContent = p.name; // keeps the veg / non-veg mark in front
      if (d && p.description) d.textContent = p.description;
      const pic = card.querySelector("img:not(.alt)");
      if (pic && p.photo) pic.src = BOX.photoUrl(p.photo);
    }
    if (tab) {
      const title = tab.querySelector("b") || tab.firstChild;
      if (title) title.textContent = p.name;
      const small = tab.querySelector("small");
      if (small && p.description) small.textContent = p.description;
    }
  }

  function newProducts(list) {
    const fresh = list.filter((p) => p.custom && !p.hidden);
    if (!fresh.length) return;
    const section = document.createElement("section");
    section.className = "slab extras";
    section.id = "new";
    section.setAttribute("aria-labelledby", "newTitle");
    section.innerHTML = `<div class="wrap">
        <p class="eyebrow">Fresh from the kitchen</p>
        <h2 class="display" id="newTitle">New at SEREN</h2>
        <div class="extras-grid">${fresh.map((p) => `
          <article class="paper extra" data-pid="${esc(p.id)}">
            <div class="ph">${p.photo ? `<img src="${esc(BOX.photoUrl(p.photo))}" alt="${esc(p.name)}" loading="lazy">` : `<span class="hand">${esc(p.name)}</span>`}</div>
            <span class="it">${esc(CATS[p.category] || "")}</span>
            <h3>${esc(p.name)}</h3>
            ${p.description ? `<p>${esc(p.description)}</p>` : ""}
            <div class="row">${BOX.addBtn(p.id)}</div>
          </article>`).join("")}</div>
      </div>`;
    const visit = document.getElementById("visit");
    visit.parentNode.insertBefore(section, visit);
  }

  document.addEventListener("seren:shop", () => {
    const shop = window.SEREN_SHOP;
    if (!shop || applied || !Array.isArray(shop.products)) return;
    applied = true;
    for (const p of shop.products) {
      BOX.updateItem({ id: p.id, name: p.name, category: p.category, photo: p.photo, veg: p.veg, ...(p.custom ? { img: null } : {}) });
      if (!p.custom) editCard(p);
    }
    newProducts(shop.products);
    BOX.rerender();
  });
})();
