# Stan's IMS

A web version of the Stans production, inventory and costing workbook, with sign-in.
Tabs are grouped across the top:

- **Dashboard**
- **Accounting:** Journals (entries A–H with each month's amounts), T-Accounts (debits, credits and balances for a month or the year to date)
- **Sales:** Sales Detail (the workbook's SalesReport; load QuickBooks reports onto it), By Customer, By Product, Standard Price
- **Inventory:** Production (daily entry; Lots traces each day's production to the customers it shipped to), New Receipts (enter a delivery in boxes, bags or cases), All Receipts (every delivery by day, to check or fix), New Counts (the blind count sheet: full boxes plus loose), All Counts (every count by day, and Check a day: counted vs. expected), Daily Inventory, Consumption (standard usage by month, actual vs. standard between cycle counts, daily usage)
- **Planning:** Production (the cases made each of the last 6 weeks, their average, and the cases to make each of the next 6 weeks, typed in, with the average shown in grey until then), Purchases (every raw material and packaging item: red and gently flashing if below safety stock, orange if the day to order has passed, yellow if it needs ordering within a week, white otherwise; with when to order, how much and the estimated cost at standard; click an item for all its orders over the next 6 weeks), Safety Stocks (item #, minimum orders in each item’s unit, demand over the next 6 weeks, lead times, safety stocks, and notes that start as the minimum order and what it comes in until typed over, `purchase_settings.notes`). Purchase orders themselves are placed and tracked in QuickBooks.
- **Standards:** Master List (every item by item #, with its Receipt — how it’s delivered, typed like “30 lb box” — and its standard cost per year; a typed-in cost left blank for a year uses the year before’s, shown in grey, and in December a note says so for next year), BOMs (every bill of materials for a year as an expandable tree; New BOM, or select a BOM and Edit BOM, opens the editor in the left side bar. BOMs are by year: a year without its own BOM carries the latest earlier one, so next year's BOMs can be changed freely; editing the current or a past year shows a warning; BOMs can contain other BOMs to any depth), Labor
- **Settings** (the gear at the far right): My Account (who you're signed in as, change password, refresh, sign out) for everyone; for admins also Users, Security (sign-ups off, user-management key, admins, turned-off, unused and pending accounts, what protects the site, latest user changes) and Change history.
- **Today:** the whole site treats 7/13/2026 as today for now, since the data runs through the week of 7/6 (`settings.site_date` in the database, blank = the real date; until the database has that setting, `PRETEND_TODAY` in `public/js/ui.js`).
- **Layout:** each page’s how-to text sits above it as plain text (no (i) button); tables run edge to edge across the page area (the margin is inside the first and last columns), with lines between rows only; a heading over a group of columns is centered with lines out to the columns it covers; only the page area scrolls (the header and side bar stay put), and a table too wide for the page gets a sideways scrollbar docked to the bottom of the screen, starting after the columns that stay put. Anything you can type in has a light yellow background; tables of items start with the Item #, pinned with the name when the table scrolls sideways.
- **Users** and **Change history** (admins, from the gear menu at the right of the brown bar). Change history lists every change to setup data: who, when and what.

On table tabs, the actions (loading a report, month and year pickers, Add item / Add sale, Clear filters …) and the add / edit forms are in a side bar on the left; click a row to select it (it's highlighted) and edit it from there. Money shows to the penny, or to two significant digits when that shows more, with the $ at the far left of the cell (like Excel's Accounting format). Drag its edge to resize it, or fold it away with the ‹ button; both are remembered. The (i) at the right of the page tabs explains the page.

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
| Manage users: add (invite or set a password), change name / email / role, turn off and on, reset or set passwords, delete (Settings → Users) | | ✓ |

The first account created becomes an admin. Everyone else is added by an admin on Settings → Users. An account that appears any other way starts turned off and can see nothing until an admin turns it on. There is always at least one enabled admin, and admins can't turn off, demote or delete themselves.

## Security

- **Sign-in only.** Nothing is readable without signing in (`anon` has no access), and every table has row-level security. A signed-in account that's turned off (or was never added by an admin) can read and change nothing (`is_member()`); setup tables are admin-only to change (`is_admin()`).
- **No public sign-ups.** Every main deploy turns off Supabase sign-ups, requires 10+ character passwords, confirms email changes on both addresses, and makes sign-in refresh tokens single-use (`tools/migrate.mjs`; leaked-password checking too where the Supabase plan has it). The site and the Worker also require a letter, a number and a symbol.
- **User management** goes through the Worker (`/api/admin/users`), which holds the Supabase secret key as a Worker secret. Each request must carry an enabled admin's own session (checked with Supabase), come from the site's own pages, and stay under a rate limit; inputs are validated, admins can't lock themselves or the site out, and every change is written to Change history. Turning an account off both blocks it in the database and bans its sign-in.
- **Profiles** can only have their name, role and on/off changed (column grants), only by admins, and never so that no enabled admin is left.
- **Change history** (audit log) records changes to setup tables and users; it can't be edited.
- **Browser protections** (`public/_headers` and the Worker): a strict Content-Security-Policy (scripts only from the site and the Supabase library's CDN, no framing, no plugins), HSTS, no sniffing, same-origin isolation, and no camera / microphone / location access. The page never builds HTML from data, so typed-in text can't run as code.
- **Security questions.** Everyone picks three (from a fixed list) before they can use the site. Answers are compared without case, spaces or punctuation, must be at least 4 letters or numbers, different from each other and not trivially guessable; one of a question's most common answers gets a warning. They're stored only as bcrypt hashes (`public.security_answers`, answers never readable, admins can see who has set them and clear them).
- **Proving it's you.** Changing your password needs your current password or all three security answers, checked by the database (`public.check_identity`, 5 wrong tries per 15 minutes); the Worker (`/api/account/password`) does the change only after that check. A "forgot password" link also asks the security answers before a new password, and changing the questions needs the current password.
- **Sessions** end after 1 hour without activity (`IDLE_MINUTES` in `public/js/ui.js`) on that browser.
- **Secrets**: the Supabase access token lives only in the Cloudflare *build* secrets, the secret key only in the Worker's runtime secrets; neither is in the repository or the website. Company data (the workbook, `seed.sql`, test fixtures) is never committed.

## Setup

### 1. Supabase

1. **SQL Editor → New query:** paste `supabase/schema.sql`, Run (later changes are applied automatically; see *Automatic database updates*). Then paste `seed.sql` (kept outside the repo), Run.
2. **Authentication → Sign In / Providers → Email:** turn off **Allow new users to sign up**, so only people you invite can get in.
3. **Authentication → URL Configuration:** set **Site URL** to the site's address (e.g. `https://inventory.example.com`) and add it under **Redirect URLs**. Invite and password-reset links go there.
4. **Authentication → Users → Add user → Create new user:** your own email and a password, with **Auto Confirm User** on. Being first, you're the admin.
5. Add everyone else on the site: **Settings → Users** (needs the Worker secret below). People added in the Supabase dashboard instead start turned off; turn them on in Settings → Users.

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

These two values are public by design; the data is protected by sign-in and row-level security.

For **Settings → Users** (adding, deleting, emails and passwords), add one more runtime variable, type **Secret** (never *Text*):

| Name | Value |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → Secret key (`sb_secret_…`) |

It stays inside the Worker: the browser never sees it, and the Worker only uses it after checking the request comes from a signed-in, enabled admin on this site. Never put it in `wrangler.jsonc`, the code, or a *Text* variable.
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
- **Receiving units:** an item can come in a bigger unit than its base unit (`items.receiving_unit` is a plain word like box, bag, case or drum; `units_per_receiving` is what one holds: a box of cheese = 30 lb, a case of 7 oz lids = 1,000). Quantities are always stored in the base unit. **New Receipts** asks how many boxes / bags / cases came in and shows the conversion as you type; **New Counts** counts full boxes plus anything loose and doesn't show the expected numbers (a blind count; All Counts → Check a day compares them); The Purchase Plan orders in whole receiving units unless an order size is set.
- **Item numbers:** six digits; the first digit is the type: 1 raw material, 2 packaging (component), 3 indirect cost (direct labor 300001, overhead, marketing, …), 4 recipe, 5 finished good. `schema.sql` renumbers older five-digit items once, and every table follows along. `tools/make_seed.py` writes the new numbers too (the workbook keeps its old ones).
- **BOM storage:** `boms` (what each BOM makes per run) and `bom_lines` (what goes into one run). The older `recipes`, `recipe_lines` and `fg_lines` tables are kept but no longer used; running `schema.sql` copies them into the BOM tables once. Each BOM row has a `year` it starts in (rows from before this start in 2026); a year uses its own BOM or the latest earlier one. A database trigger refuses any line that would put an item inside itself.
- **Production:** oz = Σ cases × oz per case. Each recipe is batched on its own in its recipe BOM's batch size (what one run makes): batches = recipe oz ÷ batch size, rounded up; estimated loss = leftover oz × that year's average price per oz.
- **Labor minutes per batch:** set on each recipe BOM (the BOM editor on the BOMs tab). Direct Labor and Overhead lines marked “Labor minutes” use it.
- **Usage:** each case uses (recipe qty ÷ batch size × oz per case) of every raw material, plus its packaging.
- **Daily inventory:** starts at each item's first cycle count. Each day = (that day's count, or yesterday's balance) + receipts − usage. Finished goods add cases produced and subtract cases sold.
- **Production plan:** weeks start Monday; 12 weeks ahead (the first 6 are typed in on Production). A product's production for a week is the number typed in (`production_plan`), otherwise its average weekly cases actually made (Production entries) over the 6 weeks before this one — or the last 6 weeks with production entered, if entries stop earlier — rounded to whole cases.
- **Purchases:** the next 6 weeks of the production plan × each product's BOM (for that year) give the weekly use of every raw material and packaging item, spread evenly over the week's days. Lead time is 14 days unless set per item on Safety Stocks (`purchase_settings.lead_days`). Safety stock, unless typed in (`purchase_settings.safety_stock`), is the use over twice the lead time: average weekly use (planned, or past if higher) × 2 × lead time in weeks. Stock is projected day by day; the day it would drop below safety stock is when an order must arrive, so Order by is one lead time before (if that's already past, the order is overdue and arrives one lead time from today). Est. cost = how much × the item's standard cost. An order is enough to get back to safety stock plus one lead time of use, rounded up to whole receiving units and at least the minimum order (`purchase_settings.standard_purchase`, shown as Min Order). Status: red (on hand below safety stock), orange (Order by has passed), yellow (Order by within the next 7 days), white. The workbook's older Purchase Demand formula is still in `calc.js` (`purchaseDemand`) and tested, but no longer shown.
- **Consumption:** standard usage = cases produced × what one case uses by its BOM. Count to count: actual usage between two cycle counts of an item = first count + received − second count (a count is taken at the start of its day); variance = actual − standard, in units, % and $ at standard cost.
- **Journals:** (A/B) deliveries at standard cost by type (what was actually paid, and so the price variance, is in QuickBooks). (C/D) actual payroll and overhead come from the books and aren't posted. (E) cases produced at standard cost, credited to raw materials, components, labor and overhead in the proportions of each product's BOM. (F) count − running inventory the day before, at standard (an item's first count starts its inventory and isn't posted). (G) revenue at invoice amounts; COGS at standard. (H) January: Dec 31 inventory × (new standard − old standard). Every entry balances.
- **Count sheet:** expected = the running inventory at the end of the day before the count; counts more than 10% off are flagged (and outlined in the month grid).
- **Lots:** each production day × product is a lot (YYMMDD-item #). Sales are matched to lots first in, first out among lots made on or before the sale date.
- **Downloads:** the "Download for Excel" button saves the rows showing (after filters) as a CSV file.
- **Change history:** a database trigger writes every insert, update and delete on setup tables to `audit_log`, with the signed-in user; admins can read it, nobody can change it.
- **Sales:** standard price, cost and margin use the sale year's standards, or the nearest year that has them.

### Differences from the workbook

- Production batched every recipe made on a day together in one batch size. The site batches each recipe on its own in its own batch size, so a day making both recipes can need one more batch, and a larger estimated loss, than the workbook showed.

- Daily Inventory in the workbook reads packaging receipts from the next column over (7 oz Container used 7 oz Lid receipts, and so on; Gallon Box read an empty column). The site matches receipts by item number.
- Finished-goods inventory was blank in the workbook; the site calculates it from counts, production and sales.
- SalesReport's standard price always used the 2026 column; the site uses the sale's year (falling back to the nearest year with prices), and does the same for standard cost.
- EndingInventory$'s "Total Components" summed the row above each component; the site totals by type, in dollars at standard cost.
- The Journals sheet listed the sale entry as Dr. Sales Revenue / Cr. Cash; the site shows Dr. Cash / Cr. Sales Revenue.
