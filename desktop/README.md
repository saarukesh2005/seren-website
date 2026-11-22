# SEREN Counter (Windows)

The shop-counter billing program for SEREN. It installs like normal Windows software and gives you:

- **Billing.** Big product tiles and a running bill.
- **Payments.** Cash shows the change due. UPI shows a QR with the exact amount. Card is one tap.
- **Held bills.** Park a customer's bill and serve the next one.
- **Silent receipt printing** to your USB receipt printer, with no print window.
- **Customer screen.** It opens full-screen on a second monitor: the bill, then "Scan to pay ₹…", then "Thank you".
- **Works when the internet drops.** Bills are kept on the PC and sent automatically when the connection is back.

Keyboard: **F1** cash · **F2** UPI · **F3** card · **F4** hold · **F6** held bills · **F8** reprint last receipt · **/** search · **Esc** clear.

## Get the installer

1. Open the repository's **Releases** page on GitHub: `github.com/saarukesh2005/seren-website/releases`.
2. Download `SEREN-Counter-Setup-<version>.exe`.

GitHub builds a new installer automatically whenever this folder changes. To release a new version, raise `version` in `package.json`.

## Install on the shop PC

1. Run the `.exe`.
   - Windows may show **"Windows protected your PC"** because the program isn't code-signed. That's a paid certificate, about ₹15,000 a year.
   - Click **More info → Run anyway**.
2. Choose where to install. A **SEREN Counter** icon appears on the desktop.
3. First start: type your **shop server address** (the order system, ending in `.workers.dev`).
4. Log in with your name and password. The owner leaves the name empty.

To change the server address later, press **Alt** to show the menu, then **SEREN → Change shop server…**.

## Receipt printer

1. Install the printer's **Windows driver** from the box or the maker's website, so Windows shows it as a printer.
2. In the counter, click **Printer**:
   - choose the printer,
   - pick 80 mm or 58 mm paper,
   - press **Print a test receipt**.
3. **Cash drawer:** most receipt-printer drivers have an **"open cash drawer"** option (Printer properties → Device settings, or similar). Switch it on, and the drawer opens on every receipt.

## For developers

```bash
npm install
SEREN_SERVER=http://127.0.0.1:8790 npm start          # run against the local backend
node test/desktop.cjs /tmp                            # drives the real app; receipts saved as PDF
npm run dist:win                                      # build the installer (best on Windows; CI does this)
```

- The window loads `<server>/pos/` (the counter screen lives in `backend/public/pos/`).
- `preload.js` exposes only `serenNative.printers()` and `serenNative.printHtml()`.
- The main process answers only pages from the configured server.
