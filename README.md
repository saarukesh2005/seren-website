# SEREN Entremets — website

Animated store and online-order site for SEREN: bomboloni, cookies, illusory fruit, entremets, choux and tarts, gelato and sorbet, chocolates, focaccia slabs and the kitchen.

## Folders

- `src/` — the site's source: `index.html`, `styles.css`, `effects.css`, `menu.js` (all products and store settings), `palettes.js`, `render.js`, `motion.js`, `interactions.js`, `img/`.
- `site/` — the built website. GitHub Pages serves this folder (see `.github/workflows/pages.yml`).
- `tools/` — build, image and test scripts.

## Change the menu or store details

Edit `src/menu.js`:

- `SEREN_CONFIG.whatsapp` — number with country code, no `+` (for example `919876543210`). Shows the "Send order on WhatsApp" button.
- `phone`, `address`, `hours` — shown in the Visit section.
- `palette` — the site's colours: any name from `src/palettes.js`.
- `showPalettePicker` — set to `false` once the colours are chosen.

Then rebuild and push:

```bash
python3 -I tools/build.py
git add -A && git commit -m "chore: update menu" && git push
```

GitHub Pages redeploys automatically after each push.

## Test locally

```bash
python3 -m http.server 4321 --directory site
node tools/fulltest.cjs /tmp
```
