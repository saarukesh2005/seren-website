# SEREN order system

Online orders, UPI payments, bills and the owner dashboard for the SEREN website.
Runs free on Cloudflare (Workers + D1 database). No payment gateway and no fees: customers pay
SEREN's own UPI ID, and the owner confirms the money arrived.

## How an order works

1. **The customer orders.** They fill their box on the website and choose dine-in (scanning the QR on their table), pickup or delivery. Pickup and delivery need a day and time.
2. **The customer pays.** The website shows a UPI QR code plus a "Pay with GPay / PhonePe" button, with the amount filled in. After paying, the customer types the 12-digit UPI reference (UTR) from their receipt.
3. **The owner gets an alert.** The dashboard chimes, and Telegram sends one too if it's set up.
   - The owner checks the bank or UPI business app for that amount and reference.
   - Then they tap **Money received ✓**. This issues a numbered bill (e.g. `SRN/2627/00001`, with no gaps in the series).
4. **The order moves along.** The owner taps Being made → Ready → Handed over / Served. The customer's order page updates by itself, and they can print their bill.
5. **Unpaid orders expire** after 30 minutes. This can be changed in Settings.

Walk-in customers: use **New bill** in the dashboard. Pick products, take cash / UPI / card, and print the receipt.

## Everything else the system does

- **Staff logins**: owner (all), manager (all but settings/staff), cashier (orders, bills, tables), kitchen (kitchen screen only). Every important action goes in the **activity log**. "Log out everyone" if a phone is lost.
- **Kitchen screen** (`/admin/kitchen.html`) for a tablet: To make → Being made → Ready, chimes, and can print a kitchen ticket (KOT) for each new order.
- **Tables**: signed table QR cards; guests call a waiter or ask for the bill from their phone. With **pay at the end** on, a table orders rounds and staff make one bill; guests pay it by UPI on their phone or staff take cash/card.
- **Daily stock limits** ("12 per day"): sold-out shows by itself on the website.
- **Coupons** (% or ₹ off, minimum order, dates, number of uses, once per customer) online and at the counter.
- **Loyalty points**: earned on paid orders by mobile number, spent at the counter by staff.
- **Refunds** make a numbered **credit note** (its own series) so the GST accounts stay right; the CSV export lists bills and credit notes.
- **WhatsApp**: customers can send their order to the shop's WhatsApp; the owner sends ready-made updates in one tap (free); optional automatic messages through Meta's paid WhatsApp Cloud API (set `WHATSAPP_TOKEN` and the templates in Settings).
- **Customers**: list with orders, spend, points and favourite item; offers sent only to customers who ticked "send me offers".
- **Feedback**: 1–5 stars on the order page; 4–5 star customers are invited to your Google review page.
- **Reports**: sales by day and hour, best sellers, payment split, coupons, refunds, rating; printable **day closing** with the cash expected in the drawer.
- **Products**: rename, describe, add photos, hide, or add new products from the dashboard; the website updates by itself.
- **Backups**: download any time; sent to Telegram every night if Telegram is set up.

## The dashboard

`https://<your-worker>.workers.dev/admin/`, protected by the owner password.

- **Orders**: today's sales, payments to check, orders to make. Tap an order for details, to confirm payment, to print the bill, or to WhatsApp the customer.
- **New bill**: the counter. Add a table number for dine-in.
- **Prices**: the price, unit and on/off for every product. A product with no price is hidden from online ordering.
- **Settings**:
  - UPI ID, opening hours, and delivery fee and area
  - dine-in tables and **Print table QR codes**
  - GSTIN, HSN codes and GST rates
  - CSV export of bills for the accountant

## First-time setup (one time)

```bash
cd backend
npm install
npx wrangler login                       # opens Cloudflare in the browser; log in there
npx wrangler d1 create seren-orders      # copy the database_id it prints into wrangler.toml
npm run db:remote                        # creates the tables
npx wrangler secret put ADMIN_PASSWORD   # type the dashboard password (10+ characters)
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
npm run deploy                           # prints the https://seren-orders.<name>.workers.dev address
```

Then put that address in `src/menu.js` → `SEREN_CONFIG.api`, rebuild the website (`python3 -I tools/build.py`) and push.

Optional phone alerts:
1. Create a Telegram bot with @BotFather.
2. Run `npx wrangler secret put TELEGRAM_BOT_TOKEN`.
3. Put your chat id in `TELEGRAM_CHAT_ID` in `wrangler.toml`, then deploy again.

## Developing and testing locally

Local secrets go in `backend/.dev.vars` (git-ignored):

```text
ADMIN_PASSWORD="any-local-password"
SESSION_SECRET="64 random hex characters"
```

```bash
npm run db:local && npm run dev          # backend on http://127.0.0.1:8790
npm test                                 # logic tests
node test/api.mjs                        # API checks against the local backend
node test/upgrade.mjs                    # staff, stock, coupons, loyalty, refunds, tables, WhatsApp, reports
node test/admin-ui.cjs /tmp              # dashboard in a headless browser
node test/admin-ui2.cjs /tmp             # the newer dashboard screens and the kitchen screen
```

Website against the local backend:

```bash
SEREN_API=http://127.0.0.1:8790 python3 -I tools/build.py
node tools/ordertest.cjs /tmp
```

Build again **without** `SEREN_API` before pushing.

## Notes

- **Prices are checked on the server.** The total always comes from the dashboard prices, never from the browser.
- **The product list comes from the website.** `src/catalog.js` builds it from `src/menu.js`, and `npm run catalog` copies it into the backend (deploy does this automatically).
- **Personal UPI IDs.** Some UPI apps refuse payment links with a pre-filled amount to personal IDs. A free business UPI ID (PhonePe Business, Paytm for Business or Google Pay for Business) avoids this.
- **GST.** Bills are worked out as intra-state sales (CGST + SGST). Ask your accountant which HSN codes and rates to use.
- **Don't change `SESSION_SECRET` casually.** Staff passwords and the printed table QR cards are tied to it. Changing it logs everyone out, means every staff password must be set again, and needs new table cards. If it ever leaks, change it and do all three.
- **Pay at the end** only works once staff open the table ("Seat a table" in the Tables tab), so a photo of a table card can't be used to order on credit from elsewhere. The tab closes when its bill is paid.
- **Loyalty points** are spent at the counter by mobile number. Check it's really the customer (their name shows up). Every use is in the activity log. If a refunded order's points were already spent, they aren't taken back.
