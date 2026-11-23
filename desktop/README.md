# SEREN Counter (Windows and Mac)

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
2. Download the file for your computer:
   - **Windows:** `SEREN-Counter-Setup-<version>.exe`
   - **Mac with an Apple chip (M1–M4):** `SEREN-Counter-<version>-mac-arm64.dmg`
   - **Mac with an Intel chip:** `SEREN-Counter-<version>-mac-x64.dmg`

GitHub builds the Windows and Mac versions together automatically whenever this folder changes. To release a new version, raise `version` in `package.json`. A release is never overwritten: if that version is already published, the release step fails until the version is raised.

Each release also has `SHA256SUMS.txt` and a signed build-provenance record. To check a download on a PC with the GitHub CLI:

```bash
gh attestation verify SEREN-Counter-Setup-<version>.exe --repo saarukesh2005/seren-website
```

## Install on the shop PC

1. Run the `.exe`.
   - Windows may show **"Windows protected your PC"** because the program isn't code-signed. That's a paid certificate, about ₹15,000 a year.
   - Click **More info → Run anyway**.
2. Choose where to install. A **SEREN Counter** icon appears on the desktop.
3. First start: type your **shop server address** (the order system, ending in `.workers.dev`).
4. Log in with your name and password. The owner leaves the name empty.

To change the server address later, press **Alt** to show the menu, then **SEREN → Change shop server…**.

## Install on a Mac (for testing)

1. Open the `.dmg` and drag **SEREN Counter** into **Applications**.
2. The first time, **right-click** the app → **Open** → **Open**. The Mac warns because the app isn't signed with a paid Apple Developer certificate (about ₹8,000 a year); after this first time it opens normally.
   If the Mac still refuses: System Settings → Privacy & Security → scroll down → **Open Anyway**.
3. Type the shop server address (it must start with `https://`), then log in as on Windows.

Silent receipt printing works on a Mac too: add the printer in System Settings → Printers & Scanners first.

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
npm run dist:win                                      # build the Windows installer (best on Windows; CI does this)
npm run dist:mac                                      # build the Mac app (.dmg and .zip, Apple chip and Intel)
```

- The window loads `<server>/pos/` (the counter screen lives in `backend/public/pos/`).
- `preload.js` exposes only `serenNative.printers()` and `serenNative.printHtml()`.
- The main process answers only pages from the configured server.
- Hardening: the app never hands links to the OS browser (off-server navigation, redirects and new windows are simply blocked); installed builds accept only an `https://` web name (not an IP number) and ask the owner to confirm the address before saving it; the test switches (`SEREN_SERVER`, `SEREN_USER_DATA`, `SEREN_PRINT_TO_PDF`, plain-http localhost) work only when run from source, never in the installed app.
- Electron fuses are set in `package.json` (`build.electronFuses`). `grantFileProtocolExtraPrivileges` stays **on** because the setup/offline pages load from `file://`; with it off they fail to load (tested).
- `overrides` in `package.json` pins `minimatch` to a patched version inside electron-builder (`npm audit` reports 0 issues). Re-test `npx electron-builder --dir` after changing it.
