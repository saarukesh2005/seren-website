# SEREN Entremets — website

Animated store and online-order site for SEREN: bomboloni, cookies, illusory fruit, entremets, choux and tarts, gelato and sorbet, chocolates, focaccia slabs and the kitchen.

## Folders

- `src/` — the site's source: `index.html`, `order.html`, styles, `menu.js` (all products and store settings), `catalog.js` (the product list shared with the backend), `palettes.js`, `render.js`, `motion.js`, `interactions.js`, `pay.js`, `checkout.js`, `order.js`, `img/`.
- `backend/` — the order system (orders, UPI payments, bills, owner dashboard).
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

## English / தமிழ்

The switch at the top flips the whole customer site (including the big SEREN wordmark, now செரென்) between English and Tamil.
English is the default; each visitor's choice is remembered on their phone.

- Tamil text lives in `src/i18n-ta.js`: English on the left, Tamil on the right. Edit the Tamil there and rebuild.
- `src/i18n.js` swaps the text in as the page draws, so the rest of the code stays in English.
- Products you rename or add in the dashboard have optional **Tamil name / Tamil description** boxes.
- Messages sent to the shop (WhatsApp order text) and everything the owner sees stay in English.
- Test: `node tools/langtest.cjs /tmp`.

## Online orders, UPI payments and bills

The order system lives in `backend/` (Cloudflare Worker + D1). Customers order dine-in (table QR), pickup or delivery and pay
SEREN's UPI ID directly; the owner confirms payments and prints GST bills from the dashboard. See `backend/README.md`.
Set `SEREN_CONFIG.api` in `src/menu.js` to the Worker address to switch online ordering on; while it's empty the box
works by WhatsApp / copy as before.

## Test locally

```bash
python3 -m http.server 4321 --directory site
node tools/fulltest.cjs /tmp
```
