# Stan's IMS

A web version of the Stans production, inventory and costing workbook, with sign-in.
Tabs across the top follow the workbook: Dashboard, Production, Goods Receipt, Cycle Counts,
Inventory, Purchase Demand, Sales, Standard Cost, Recipes, Finished Goods, Standard Price,
Labor, Journals, and Users (admins only).

- **Site:** plain HTML/CSS/JavaScript in `public/` (no build step), served by a Cloudflare Worker (`src/worker.js`, `wrangler.jsonc`).
- **Data and sign-in:** Supabase (Postgres + Auth). Schema and access rules are in `supabase/schema.sql`.
- **Calculations:** `public/js/calc.js` reproduces the workbook's formulas and is tested against the numbers Excel calculated.

> This repository is public. Company data (the workbook, `supabase/seed.sql`, `tests/fixtures/`) is listed in `.gitignore` and must never be committed.

## Who can do what

| | Staff | Admin |
|---|---|---|
| See everything | ✓ | ✓ |
| Enter production, goods receipts, cycle counts, sales | ✓ | ✓ |
| Change items, standard costs and prices, recipes, bills of materials, labor and purchase settings | | ✓ |
| Change people's roles (Users tab) | | ✓ |

The first account created becomes an admin; later accounts are staff. There is always at least one admin.

## Setup

### 1. Supabase

1. **SQL Editor → New query:** paste `supabase/schema.sql`, Run. Then paste `seed.sql` (kept outside the repo), Run.
2. **Authentication → Sign In / Providers → Email:** turn off **Allow new users to sign up**, so only people you invite can get in.
3. **Authentication → URL Configuration:** set **Site URL** to the site's address (e.g. `https://inventory.example.com`) and add it under **Redirect URLs**. Invite and password-reset links go there.
4. **Authentication → Users → Add user → Create new user:** your own email and a password, with **Auto Confirm User** on. Being first, you're the admin.
5. To add staff later: **Authentication → Users → Invite user**. They get an email, choose a password, and appear on the Users tab as staff.

### 2. Cloudflare Worker

The Worker is built from this repository (Workers & Pages → the `stansims` Worker → Settings → Build):

- Build command: `npm run build` (does nothing; there is no build step) or leave empty
- Deploy command: `npx wrangler deploy`
- The Worker's name must match `"name"` in `wrangler.jsonc` (`stansims`). If yours is named differently, change that line.

Under **Settings → Variables and Secrets** (runtime variables, type *Text*), add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → Data API → Project URL |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API Keys → Publishable key (`sb_publishable_…`) |

These two values are public by design; the data is protected by sign-in and row-level security. Never use the secret / service_role key here.
Build variables (such as `VITE_…`) are not visible to the running Worker, so they must be runtime variables.

Custom domain: once the domain's DNS is on Cloudflare, open the Worker → **Settings → Domains & Routes → Add → Custom domain**.

## Updating from a newer workbook

```sh
python3 tools/excel_export.py Stans.xlsm tests/fixtures/workbook.json
python3 tools/make_seed.py tests/fixtures/workbook.json supabase/seed.sql
```

`seed.sql` only fills empty tables and skips rows that already exist, so it won't overwrite data entered on the site.

## Tests

```sh
npm test                                  # calculations vs. Excel (needs tests/fixtures/workbook.json)
python3 tests/ui_test.py [screenshot_dir] # headless browser, in-memory database (needs Playwright)
```

Database rules can be checked on a local Postgres with `tests/supabase_stub.sql`, then `supabase/schema.sql`, `seed.sql` and `tests/rls_test.sql`.

## How the numbers work

- **Standard cost:** raw materials, packaging and overhead are entered per year. Direct labor per minute comes from the labor scenario chosen for that year. A recipe's cost per oz = Σ(ingredient cost × qty per batch) ÷ batch size. A finished good's cost = Σ(part cost × qty).
- **Production:** oz = Σ cases × oz per case; batches = oz ÷ batch size, rounded up; estimated loss = leftover oz in the last batch × that year's average price per oz.
- **Usage:** each case uses (recipe qty ÷ batch size × oz per case) of every raw material, plus its packaging.
- **Daily inventory:** starts at each item's first cycle count. Each day = (that day's count, or yesterday's balance) + receipts − usage. Finished goods add cases produced and subtract cases sold.
- **Purchase demand:** safety stock = threshold × lead time × planning usage. A standard purchase is suggested on any day when inventory plus all purchases suggested so far is below safety stock.
- **Sales:** standard price, cost and margin use the sale year's standards, or the nearest year that has them.

### Differences from the workbook

- Daily Inventory in the workbook reads packaging receipts from the next column over (7 oz Container used 7 oz Lid receipts, and so on; Gallon Box read an empty column). The site matches receipts by item number.
- Finished-goods inventory was blank in the workbook; the site calculates it from counts, production and sales.
- SalesReport's standard price always used the 2026 column; the site uses the sale's year (falling back to the nearest year with prices), and does the same for standard cost.
- EndingInventory$'s "Total Components" summed the row above each component; the site totals by type, in dollars at standard cost.
- The Journals sheet listed the sale entry as Dr. Sales Revenue / Cr. Cash; the site shows Dr. Cash / Cr. Sales Revenue.
