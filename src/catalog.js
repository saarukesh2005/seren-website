/* Every product a customer can put in the box, built from SEREN_MENU.
   The website and the order backend both read this list, so ids and names always match.
   Prices are not here: the owner sets them in the dashboard. */
(function (root) {
  "use strict";
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  function buildCatalog(menu) {
    const out = [];
    const add = (category, id, name, img, veg) => out.push({ id, name, category, img: img || null, veg: veg === undefined ? null : veg });
    menu.bomboloni.forEach((b) => add("bomboloni", b.id, b.name, b.img));
    menu.cookies.forEach((c) => add("cookies", c.id, `${c.name} cookie`, c.img));
    menu.fruit.forEach((f) => add("fruit", f.id, `${f.name} illusory fruit`, f.img));
    menu.entremets.forEach((e) => add("entremets", e.id, e.name, null));
    menu.pastry.forEach((p) => add("pastry", p.id, p.name, p.img));
    ["signature", "classic", "sorbet"].forEach((kind) =>
      menu.gelato[kind].forEach(([name]) => add("gelato", `gelato-${kind}-${slug(name)}`, kind === "sorbet" ? `${name} sorbet` : `${name} gelato`, null)));
    menu.chocolates.bonbons.forEach((b) => add("chocolates", b.id, `${b.name} bonbon`, b.img));
    menu.chocolates.truffles.forEach((t) => add("chocolates", t.id, t.name, t.img));
    menu.focaccia.forEach((s) => add("focaccia", s.id, `${s.name} slab`, s.img, s.veg));
    return out;
  }

  const CATEGORIES = {
    bomboloni: "Bomboloni", cookies: "Cookies", fruit: "Illusory fruit", entremets: "Entremets",
    pastry: "Choux & tarts", gelato: "Gelato & sorbet", chocolates: "Chocolates", focaccia: "Focaccia slabs",
  };

  root.SEREN_CATEGORIES = CATEGORIES;
  root.SEREN_CATALOG = buildCatalog(root.SEREN_MENU);
  root.serenGelatoId = (kind, name) => `gelato-${kind}-${slug(name)}`;
})(typeof window !== "undefined" ? window : globalThis);
