/* Menu tab: price, unit, on/off and daily limit for every product (saves by itself),
   plus editing products (name, description, photo, hide) and adding new ones. */
SA.prices = (function () {
  "use strict";
  const { esc, api, toPaise, toRupees, toast } = SA;
  const $ = (s) => document.querySelector(s);
  const timers = new Map();
  const MAX_SIDE = 900; // photos are shrunk to at most 900 px before upload

  async function loadCatalog() {
    SA.state.catalog = await api("/catalog");
    return SA.state.catalog;
  }

  function render() {
    setTimeout(() => { if ($("#menuFind") && $("#menuFind").value) filterMenu($("#menuFind").value); }, 0);
    const { categories, items } = SA.state.catalog;
    $("#priceGroups").innerHTML = Object.entries(categories).map(([key, label]) => `
      <section class="pgroup"><h2>${esc(label)}</h2>
        ${items.filter((i) => i.category === key).map((i) => `
          <div class="prow ${i.hidden ? "is-hidden" : ""}" data-id="${esc(i.id)}">
            <span class="nm">${i.photo ? `<img src="/img/${esc(i.photo)}" alt="">` : ""}${esc(i.name)}${i.hidden ? ` <span class="badge cancelled">Hidden</span>` : ""}${i.custom ? ` <span class="badge">New</span>` : ""}</span>
            <label class="money"><input name="price" inputmode="decimal" placeholder="Price" value="${esc(toRupees(i.price))}" aria-label="${esc(i.name)} price in rupees"></label>
            <input class="unit" name="unit" maxlength="30" placeholder="per piece" value="${esc(i.unit)}" aria-label="${esc(i.name)} unit">
            <input class="limit" name="dailyLimit" inputmode="numeric" placeholder="Per day" value="${i.dailyLimit ?? ""}" aria-label="${esc(i.name)} daily limit" title="How many can be sold per day (empty = no limit)">
            <label class="switch"><input type="checkbox" name="available" ${i.price === null || i.available ? "checked" : ""}> On sale</label>
            <span class="st" aria-live="polite">${i.price === null ? "Hidden" : i.leftToday !== null ? `${i.leftToday} left today` : ""}</span>
            <button class="btn ghost small" type="button" data-edit="${esc(i.id)}">Edit</button>
          </div>`).join("")}
      </section>`).join("");
  }

  function queue(row) {
    clearTimeout(timers.get(row.dataset.id));
    row.querySelector(".st").className = "st";
    row.querySelector(".st").textContent = "…";
    timers.set(row.dataset.id, setTimeout(() => save(row), 600));
  }

  async function save(row) {
    const st = row.querySelector(".st");
    const price = toPaise(row.querySelector('[name="price"]').value);
    const limitRaw = row.querySelector('[name="dailyLimit"]').value.trim();
    if (Number.isNaN(price) || (limitRaw && !/^\d+$/.test(limitRaw))) { st.className = "st bad"; st.textContent = "Numbers only"; return; }
    const body = { price, unit: row.querySelector('[name="unit"]').value, available: row.querySelector('[name="available"]').checked, dailyLimit: limitRaw === "" ? null : Number(limitRaw) };
    try {
      await api(`/prices/${encodeURIComponent(row.dataset.id)}`, body);
      SA.state.catalog = { ...SA.state.catalog, items: SA.state.catalog.items.map((i) => (i.id === row.dataset.id ? { ...i, price, unit: body.unit, available: body.available ? 1 : 0, dailyLimit: body.dailyLimit } : i)) };
      st.className = "st saved"; st.textContent = price === null ? "Hidden" : "Saved ✓";
    } catch (e) {
      st.className = "st bad"; st.textContent = e.message.length > 40 ? "Not saved" : e.message;
      toast(e.message, true);
    }
  }

  /* ---------- product editor ---------- */
  function editor(item) {
    const d = $("#editSheet");
    const cats = SA.state.catalog.categories;
    const isNew = !item;
    const p = item || { name: "", category: Object.keys(cats)[0], description: "", veg: null, hidden: false, photo: null, custom: true };
    d.innerHTML = `<form class="sheet-in" id="productForm">
      <div class="sheet-head"><h2 id="editTitle">${isNew ? "New product" : "Edit product"}</h2><button class="close" type="button" data-close aria-label="Close">×</button></div>
      <label>Name<input name="name" maxlength="80" required value="${esc(p.name)}"></label>
      ${isNew || p.custom ? `<label>Section<select name="category">${Object.entries(cats).map(([k, l]) => `<option value="${esc(k)}" ${k === p.category ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` : `<p class="meta">Section: ${esc(cats[p.category])}</p>`}
      <label>Description <span class="opt">(shown on the website)</span><textarea name="description" rows="2" maxlength="240">${esc(p.description)}</textarea></label>
      <details class="box" ${p.nameTa || p.descriptionTa ? "open" : ""}><summary><b>Tamil</b> <span class="opt">(for the தமிழ் website; leave empty to use the built-in Tamil)</span></summary>
        <label>Tamil name<input name="nameTa" maxlength="80" lang="ta" value="${esc(p.nameTa || "")}" placeholder="எ.கா. ரோஸ் பிஸ்தா எக்ளேர்"></label>
        <label>Tamil description<textarea name="descriptionTa" rows="2" maxlength="240" lang="ta">${esc(p.descriptionTa || "")}</textarea></label>
      </details>
      <details class="box" ${(p.options || []).length ? "open" : ""}><summary><b>Sizes &amp; add-ons</b> <span class="opt">(e.g. Size: 500 g / 1 kg · Add-ons: extra Nutella +₹30)</span></summary>
        <div class="opt-editor" id="optEditor">${(p.options || []).map(groupHtml).join("")}</div>
        <button class="btn ghost small" type="button" id="addGroup">+ Add a choice group</button>
        <p class="meta">"Pick one" groups (like Size) can be required. Extra price is added to the item's price.</p>
      </details>
      <details class="box" ${p.tax ? "open" : ""}><summary><b>GST for this item</b> <span class="opt">(only if it differs from its section, e.g. a packed chocolate sold as goods)</span></summary>
        <label class="check"><input type="checkbox" name="ownTax" ${p.tax ? "checked" : ""}> This item has its own GST</label>
        <div class="two"><label>HSN / SAC<input name="taxHsn" inputmode="numeric" maxlength="8" value="${esc(p.tax ? p.tax.hsn : "")}" placeholder="e.g. 1806"></label>
        <label>GST rate<select name="taxRate">${[0, 0.25, 3, 5, 12, 18, 28, 40].map((r) => `<option value="${r}" ${p.tax && Number(p.tax.rate) === r ? "selected" : !p.tax && r === 5 ? "selected" : ""}>${r}%</option>`).join("")}</select></label></div>
        <p class="meta">Ask your CA. After GST 2.0 (22 Sep 2025) cakes, pastries, cookies, chocolates and ice cream sold as goods are mostly 5%; plain bread is nil.</p>
      </details>
      <fieldset class="seg"><legend>Food mark</legend>
        ${[["", "None"], ["1", "Veg"], ["0", "Non-veg"]].map(([v, l]) => `<label><input type="radio" name="veg" value="${v}" ${String(p.veg === null ? "" : p.veg ? 1 : 0) === v ? "checked" : ""}><span>${l}</span></label>`).join("")}</fieldset>
      <div class="photo">
        <img id="photoPreview" alt="" ${p.photo ? `src="/img/${esc(p.photo)}"` : "hidden"}>
        <label class="btn ghost small">Choose photo<input type="file" accept="image/*" id="photoFile" hidden></label>
        <span class="meta" id="photoNote">${p.photo ? "Uploaded photo" : isNew ? "Optional" : "Using the website's photo"}</span>
      </div>
      <label class="check"><input type="checkbox" name="hidden" ${p.hidden ? "checked" : ""}> Hide from the website and online ordering</label>
      <p class="err" id="productErr" role="alert"></p>
      <button class="btn primary" type="submit">${isNew ? "Add product" : "Save"}</button>
      ${isNew ? `<p class="meta">After adding, give it a price below so customers can order it.</p>` : ""}
    </form>`;
    let photo = p.photo || null;
    d.querySelector("[data-close]").addEventListener("click", () => d.close());
    const ed = d.querySelector("#optEditor");
    d.querySelector("#addGroup").addEventListener("click", () => { if (ed.children.length < 5) ed.insertAdjacentHTML("beforeend", groupHtml({ name: "", pick: "one", required: false, choices: [{ name: "", price: 0 }] })); });
    ed.addEventListener("click", (e) => {
      if (e.target.closest("[data-addch]")) { const g = e.target.closest(".grp"); if (g.querySelectorAll(".ch-row").length < 12) g.querySelector(".chs").insertAdjacentHTML("beforeend", choiceHtml({ name: "", price: 0 })); }
      if (e.target.closest("[data-delch]")) e.target.closest(".ch-row").remove();
      if (e.target.closest("[data-delgrp]")) e.target.closest(".grp").remove();
    });
    d.querySelector("#photoFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const note = d.querySelector("#photoNote");
      note.textContent = "Uploading…";
      try {
        const dataUrl = await shrink(file);
        photo = (await api("/images", { dataUrl })).key;
        const img = d.querySelector("#photoPreview");
        img.src = dataUrl; img.hidden = false;
        note.textContent = "Photo ready. Press Save.";
      } catch (ex) { note.textContent = ex.message; }
    });
    d.querySelector("#productForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const v = (n) => f.elements.namedItem(n);
      const vegRaw = v("veg").value;
      const body = { name: v("name").value, description: v("description").value, veg: vegRaw === "" ? null : vegRaw === "1", hidden: v("hidden").checked, img: photo,
        nameTa: v("nameTa").value, descriptionTa: v("descriptionTa").value, options: readOptions(ed),
        tax: v("ownTax").checked ? { hsn: v("taxHsn").value.trim(), rate: Number(v("taxRate").value) } : null };
      if (v("category")) body.category = v("category").value;
      try {
        if (isNew) await api("/products", body);
        else await api(`/products/${encodeURIComponent(p.id)}`, body);
        toast(isNew ? "Product added. Now set its price." : "Saved");
        d.close();
        await loadCatalog(); render();
      } catch (ex) { d.querySelector("#productErr").textContent = ex.message; }
    });
    d.showModal();
  }

  const choiceHtml = (c) => `<div class="ch-row"><input data-chname maxlength="30" placeholder="Choice, e.g. 1 kg" value="${esc(c.name)}" aria-label="Choice name">
    <span class="money"><input data-chprice inputmode="decimal" placeholder="extra ₹" value="${c.price ? esc(String(c.price / 100)) : ""}" aria-label="Extra price"></span>
    <button class="btn ghost small" type="button" data-delch aria-label="Remove choice">×</button></div>`;
  function groupHtml(g) {
    return `<div class="grp"><div class="grp-head"><input data-gname maxlength="30" placeholder="Group, e.g. Size" value="${esc(g.name)}" aria-label="Group name">
      <select data-gpick aria-label="How many"><option value="one" ${g.pick !== "many" ? "selected" : ""}>Pick one</option><option value="many" ${g.pick === "many" ? "selected" : ""}>Pick any</option></select>
      <button class="btn ghost small" type="button" data-delgrp aria-label="Remove group">×</button></div>
      <label class="check"><input type="checkbox" data-greq ${g.required ? "checked" : ""}> Must choose (for "Pick one")</label>
      <div class="chs">${g.choices.map(choiceHtml).join("")}</div>
      <button class="btn ghost small" type="button" data-addch>+ Add a choice</button></div>`;
  }
  function readOptions(ed) {
    return [...ed.querySelectorAll(".grp")].map((g) => ({
      name: g.querySelector("[data-gname]").value.trim(),
      pick: g.querySelector("[data-gpick]").value,
      required: g.querySelector("[data-greq]").checked,
      choices: [...g.querySelectorAll(".ch-row")].map((r) => ({ name: r.querySelector("[data-chname]").value.trim(), price: Math.round(Number(r.querySelector("[data-chprice]").value || 0) * 100) || 0 })).filter((c) => c.name),
    })).filter((g) => g.name && g.choices.length);
  }

  // Shrinks a photo in the browser (keeps uploads small and fast) and returns a WebP/JPEG data URL.
  function shrink(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) { reject(new Error("Choose a photo file")); return; }
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        let out = c.toDataURL("image/webp", 0.82);
        if (!out.startsWith("data:image/webp")) out = c.toDataURL("image/jpeg", 0.82); // Safari can't make WebP
        resolve(out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that photo")); };
      img.src = url;
    });
  }

  function filterMenu(raw) {
    const q = String(raw || "").trim().toLowerCase();
    document.querySelectorAll("#priceGroups .pgroup").forEach((g) => {
      let shown = 0;
      g.querySelectorAll(".prow").forEach((r) => { const hit = !q || r.textContent.toLowerCase().includes(q); r.hidden = !hit; if (hit) shown += 1; });
      g.hidden = shown === 0;
    });
  }

  function start() {
    $("#priceGroups").addEventListener("input", (e) => { const row = e.target.closest(".prow"); if (row && e.target.name !== "available") queue(row); });
    $("#priceGroups").addEventListener("change", (e) => { const row = e.target.closest(".prow"); if (row && e.target.type === "checkbox") queue(row); });
    $("#priceGroups").addEventListener("click", (e) => {
      const b = e.target.closest("[data-edit]");
      if (b) editor(SA.state.catalog.items.find((i) => i.id === b.dataset.edit));
    });
    $("#addProduct").addEventListener("click", () => editor(null));
    // find a product by name: other rows and empty sections hide while typing
    $("#menuFind").addEventListener("input", (e) => filterMenu(e.target.value));
    if (!SA.can("menu")) $("#addProduct").hidden = true;
  }
  return { start, render, loadCatalog };
})();
