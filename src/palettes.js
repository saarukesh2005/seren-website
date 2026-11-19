/* SEREN colour palettes + the preview switcher.
   Roles: caramel = warm light section, plum = deep section, aubergine = dark accent/text,
   butter = highlight, cream = light background, ink = darkest background. */
window.SEREN_PALETTES = [
  { name: "SEREN Original", mood: "Your cover today", caramel: "#C89B6F", plum: "#662937", aubergine: "#57293A", butter: "#EBCB8B", cream: "#F8EEDC", ink: "#140C0E" },
  { name: "Pistachio & Cocoa", mood: "Fresh, nutty, calm", caramel: "#B9C78F", plum: "#3E2A20", aubergine: "#2B1C15", butter: "#F1E3B5", cream: "#F6F2E4", ink: "#13100C" },
  { name: "Raspberry Ganache", mood: "Romantic, jewel-toned", caramel: "#E8A0A8", plum: "#5B1A2E", aubergine: "#4A1424", butter: "#F7D6A0", cream: "#FCEFEA", ink: "#160A0E" },
  { name: "Matcha Noir", mood: "Japanese café luxe", caramel: "#9DB57A", plum: "#1F2B22", aubergine: "#16201A", butter: "#E6E0B8", cream: "#F2F0E3", ink: "#0C110E" },
  { name: "Blood Orange Tart", mood: "Warm, bold, juicy", caramel: "#F2A65A", plum: "#7A1F1F", aubergine: "#5E1717", butter: "#FFD9A8", cream: "#FFF3E6", ink: "#150B08" },
  { name: "Blueberry Cheesecake", mood: "Cool, modern, soft", caramel: "#A9B8E0", plum: "#2B2F5E", aubergine: "#1F2247", butter: "#F4D9A7", cream: "#F5F3EE", ink: "#0D0E1C" },
  { name: "Sea Salt Caramel", mood: "Coastal, grown-up", caramel: "#D8A35D", plum: "#2E3A40", aubergine: "#1F2A30", butter: "#F3E2C0", cream: "#F7F4EE", ink: "#0F1316" },
  { name: "Rose Pâtisserie", mood: "Parisian pastel", caramel: "#F1B8C4", plum: "#7A3B4E", aubergine: "#5C2A3A", butter: "#F9E4B7", cream: "#FFF5F4", ink: "#1A0F13" },
  { name: "Espresso & Cream", mood: "Quiet coffee-house", caramel: "#C4A484", plum: "#3B2418", aubergine: "#2A1910", butter: "#E9D8BE", cream: "#F5EEE4", ink: "#110A07" },
  { name: "Mango Lassi", mood: "Sunny, Indian summer", caramel: "#F7C85C", plum: "#1F5E4A", aubergine: "#164536", butter: "#FFF0C2", cream: "#FFFAEC", ink: "#0B1A15" },
  { name: "Black Forest", mood: "Dark, rich, dramatic", caramel: "#B8484E", plum: "#2A1A1A", aubergine: "#1C1111", butter: "#F2C9A0", cream: "#F6EFE8", ink: "#0E0909" },
  { name: "Lemon Meringue", mood: "Bright and airy", caramel: "#F2DD7A", plum: "#3C4A63", aubergine: "#2B364A", butter: "#FFF6D6", cream: "#FFFDF5", ink: "#10131A" },
  { name: "Midnight Praline", mood: "Night-time luxury", caramel: "#C08A5B", plum: "#1E2C3A", aubergine: "#15202B", butter: "#E7C9A0", cream: "#F2EEE8", ink: "#0A0F14" },
  { name: "Strawberry Milk", mood: "Playful, Gen-Z pink", caramel: "#F4A6B5", plum: "#C13B4F", aubergine: "#8E2638", butter: "#FFF0D1", cream: "#FFF7F8", ink: "#1E0F12" },
  { name: "Saffron & Kulfi", mood: "Royal, festive", caramel: "#E9B949", plum: "#6E2A3E", aubergine: "#52202F", butter: "#F6E6B4", cream: "#FBF5E6", ink: "#140C0B" },
];

(function () {
  "use strict";
  const KEY = "seren-palette-v1";
  const ROLES = ["caramel", "plum", "aubergine", "butter", "cream", "ink"];
  const list = window.SEREN_PALETTES;
  const cfg = window.SEREN_CONFIG || {};
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function apply(p) {
    const root = document.documentElement;
    ROLES.forEach((r) => root.style.setProperty(`--${r}`, p[r]));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = p.plum;
  }
  function find(name) { return list.find((p) => p.name === name) || list[0]; }
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function save(name) { try { localStorage.setItem(KEY, name); } catch (e) { /* preview still works without storage */ } }

  const chosen = find(cfg.palette || "SEREN Original");
  apply(cfg.showPalettePicker ? find(saved() || chosen.name) : chosen);
  if (!cfg.showPalettePicker) return;

  const swatch = (p) => ROLES.map((r) => `<b style="background:${p[r]}"></b>`).join("");
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "pal-btn"; btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-controls", "palPanel");
  const panel = document.createElement("div");
  panel.id = "palPanel"; panel.className = "pal-panel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Try a colour palette");

  function render(active) {
    const dots = ["caramel", "plum", "butter"].map((r) => `<b style="background:${active[r]}"></b>`).join("");
    btn.innerHTML = `<i aria-hidden="true">${dots}</i><span class="t">Colours: ${esc(active.name)}&nbsp;</span>`;
    btn.setAttribute("aria-label", `Colours: ${active.name}. Try another palette`);
    panel.innerHTML = `<h3>Try a palette</h3><p>Preview only. Tell Claude the name you like and it becomes the site's colours.</p>
      <div class="pal-grid">${list.map((p) => `<button type="button" data-pal="${esc(p.name)}" aria-pressed="${p.name === active.name}"><span class="sw">${swatch(p)}</span>${esc(p.name)}</button>`).join("")}</div>`;
  }
  btn.addEventListener("click", () => {
    const on = !panel.classList.contains("on");
    panel.classList.toggle("on", on); btn.setAttribute("aria-expanded", String(on));
  });
  panel.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pal]");
    if (!b) return;
    const p = find(b.dataset.pal);
    apply(p); save(p.name); render(p);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { panel.classList.remove("on"); btn.setAttribute("aria-expanded", "false"); } });
  render(find(saved() || chosen.name));
  document.body.append(btn, panel);
})();
