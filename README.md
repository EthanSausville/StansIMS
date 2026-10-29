# Stan's IMS

A web version of the Stans production, inventory and costing workbook, with sign-in.
Tabs are grouped across the top:

- **Dashboard**
- **Accounting:** Journals, T-Accounts
- **Sales:** Sales Detail (the workbook's SalesReport; load QuickBooks reports onto it), By Customer, By Product, Standard Price
- **Inventory:** Production, Goods Receipt, Cycle Counts, Daily Inventory, Purchase Demand
- **Standards:** Master List (every item with its standard cost per year), BOMs (every bill of materials for a year as an expandable tree; New BOM, or select a BOM and Edit BOM, opens the editor in the left side bar. BOMs are by year: a year without its own BOM carries the latest earlier one, so next year's BOMs can be changed freely; editing the current or a past year shows a warning; BOMs can contain other BOMs to any depth), Labor
- **Users** (admins, from the gear menu at the right of the blue bar)

On table tabs, the actions (loading a report, month and year pickers, Add item, Clear filters …) are in a side bar on the left. Drag its edge to resize it, or fold it away with the ‹ button; both are remembered. The (i) at the right of the page tabs explains the page.

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

1. **SQL Editor → New query:** paste `supabase/schema.sql`, Run (later changes are applied automatically; see *Automatic database updates*). Then paste `seed.sql` (kept outside the repo), Run.
2. **Authentication → Sign In / Providers → Email:** turn off **Allow new users to sign up**, so only people you invite can get in.
3. **Authentication → URL Configuration:** set **Site URL** to the site's address (e.g. `https://inventory.example.com`) and add it under **Redirect URLs**. Invite and password-reset links go there.
4. **Authentication → Users → Add user → Create new user:** your own email and a password, with **Auto Confirm User** on. Being first, you're the admin.
5. To add staff later: **Authentication → Users → Invite user**. They get an email, choose a password, and appear on the Users tab as staff.

### 2. Cloudflare Worker

The Worker is built from this repository (Workers & Pages → the `stansims` Worker → Settings → Build):

- Build command: `npm run build`. This brings the database up to date with `supabase/schema.sql` before every deploy (see below).
- Deploy command: `npx wrangler deploy`
- The Worker's name must match `"name"` in `wrangler.jsonc` (`stansims`). If yours is named differently, change that line.

#### Automatic database updates

So you never have to paste `schema.sql` into Supabase again, give the build a Supabase access token:

1. Supabase → your account (top right) → **Account preferences → Access Tokens → Generate new token**. Name it `Cloudflare build`, choose an expiry, copy it.
2. Cloudflare → the `stansims` Worker → **Settings → Build → Variables and secrets → Add**: type **Secret**, name `SUPABASE_ACCESS_TOKEN`, paste the token, Save. (This is the *Build* section, not the Worker's runtime variables, so the token never reaches the website.)

Every deploy then runs `tools/migrate.mjs`, which sends `schema.sql` to the project named in `wrangler.jsonc`. The file only creates or changes what's missing and never deletes data; it runs as one transaction, so if anything fails nothing changes and the deploy stops (the build log says why). Without the secret the step is skipped. The token can manage your whole Supabase account, so keep it only in that Cloudflare secret, and give it an expiry you'll remember to renew.

`seed.sql` is different: it's a one-time load of the workbook data and stays out of the repository, so it's never run automatically.

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

## Loading QuickBooks sales detail

**Sales → Sales Detail** is the workbook's SalesReport sheet (date, invoice #, quantity, sales price, amount, customer, product, plus standard price, cost and margin). Its starting rows come from the workbook via `seed.sql`.

To add new sales, run **Reports → Sales by Product/Service Detail** in QuickBooks for any date range, export it to Excel (.xlsx) or CSV, and drop it onto the tab. Each QuickBooks line is converted the way the workbook was built:

- **Customer:** QuickBooks full names become your short names using a saved name list (`qb_name_map`). Names not on the list are shown with a suggestion to confirm, and your choice is remembered.
- **Product:** the finished good with the same size and flavor; fees, deductions, coupons and credits become "Other". A "(1/1)" single-unit item sold below half the standard case price is "Other" (single units, not cases).
- **$0 lines** (voided memos, notes, no-charge lines) are left out.

The table works like an Excel table: the ▾ button on each column heading sorts the column or filters it to the values you tick (with a search box). The totals row stays pinned to the bottom of the screen and adds up only the lines left showing; its **Hide** button tucks it away (a small **Show totals** tab brings it back), and the choice is remembered on that computer. Tables too wide for the screen keep their sideways scrollbar docked at the bottom of the screen as well.

A line is skipped when Sales Detail already has one with the same date, invoice #, customer, product and amount, so overlapping date ranges are safe, and lines typed by hand count too. Each load is listed under **Loaded QuickBooks reports** and can be undone.

## Tests

```sh
npm test                                  # calculations vs. Excel (needs tests/fixtures/workbook.json)
python3 tests/ui_test.py [screenshot_dir] # headless browser, in-memory database (needs Playwright)
```

Database rules can be checked on a local Postgres with `tests/supabase_stub.sql`, then `supabase/schema.sql`, `seed.sql` and `tests/rls_test.sql`.

## How the numbers work

- **Standard cost:** raw materials, packaging and overhead are entered per year. Direct labor per minute comes from the labor scenario chosen for that year. Anything with a BOM costs Σ(line cost × qty per run) ÷ what one run makes, following nested BOMs down every level. A recipe that makes 3,220 oz per batch costs its batch ÷ 3,220 per oz; a product that makes 1 case costs the sum of its lines.
- **Labor rate:** shown for every year from 2026 to next year. A year without its own people starts from the year before, with pay and fixed costs raised by that year's inflation adjustment %; it is a forecast until the year begins (and a year that has begun on the forecast is flagged for review). “Give the year its own people” turns the forecast into editable people for the year. Each position (hourly: rate + monthly fringe; salaried: salary + annual fixed cost; plus payroll tax %) has a labor cost for the year. Hourly line workers are paid only for the weeks they work (no paid time off); salaried people are paid all 52 weeks. The line runs the year's production hours a week and everyone who works the line is on it whenever it runs (hourly people are paid for those hours). Labor rate = all labor cost ÷ minutes on the line. A labor minute is one person working one minute. Master List's Direct Labor uses each year's own rate.
- **Item numbers:** six digits; the first digit is the type: 1 raw material, 2 packaging (component), 3 indirect cost (direct labor 300001, overhead, marketing, …), 4 recipe, 5 finished good. `schema.sql` renumbers older five-digit items once, and every table follows along. `tools/make_seed.py` writes the new numbers too (the workbook keeps its old ones).
- **BOM storage:** `boms` (what each BOM makes per run) and `bom_lines` (what goes into one run). The older `recipes`, `recipe_lines` and `fg_lines` tables are kept but no longer used; running `schema.sql` copies them into the BOM tables once. Each BOM row has a `year` it starts in (rows from before this start in 2026); a year uses its own BOM or the latest earlier one. A database trigger refuses any line that would put an item inside itself.
- **Production:** oz = Σ cases × oz per case. Each recipe is batched on its own in its recipe BOM's batch size (what one run makes): batches = recipe oz ÷ batch size, rounded up; estimated loss = leftover oz × that year's average price per oz.
- **Labor minutes per batch:** set on each recipe BOM (the BOM editor on the BOMs tab). Direct Labor and Overhead lines marked “Labor minutes” use it.
- **Usage:** each case uses (recipe qty ÷ batch size × oz per case) of every raw material, plus its packaging.
- **Daily inventory:** starts at each item's first cycle count. Each day = (that day's count, or yesterday's balance) + receipts − usage. Finished goods add cases produced and subtract cases sold.
- **Purchase demand:** safety stock = threshold × lead time × planning usage. A standard purchase is suggested on any day when inventory plus all purchases suggested so far is below safety stock.
- **Sales:** standard price, cost and margin use the sale year's standards, or the nearest year that has them.

### Differences from the workbook

- Production batched every recipe made on a day together in one batch size. The site batches each recipe on its own in its own batch size, so a day making both recipes can need one more batch, and a larger estimated loss, than the workbook showed.

- Daily Inventory in the workbook reads packaging receipts from the next column over (7 oz Container used 7 oz Lid receipts, and so on; Gallon Box read an empty column). The site matches receipts by item number.
- Finished-goods inventory was blank in the workbook; the site calculates it from counts, production and sales.
- SalesReport's standard price always used the 2026 column; the site uses the sale's year (falling back to the nearest year with prices), and does the same for standard cost.
- EndingInventory$'s "Total Components" summed the row above each component; the site totals by type, in dollars at standard cost.
- The Journals sheet listed the sale entry as Dr. Sales Revenue / Cr. Cash; the site shows Dr. Cash / Cr. Sales Revenue.
