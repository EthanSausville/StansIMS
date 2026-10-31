-- Stans IMS database schema.
-- Run once in Supabase: SQL Editor -> New query -> paste this file -> Run.
-- After that, every Cloudflare deploy re-applies it (tools/migrate.mjs), so
-- it must stay safe to run again: create/alter only what's missing, never drop data.
-- Then run seed.sql to load the data from Stans.xlsm.
--
-- Security model
--   * Nobody can read or write anything without signing in (no grants to "anon").
--   * Every signed-in person can read everything and record day-to-day activity:
--     production, goods receipts, cycle counts and sales.
--   * Only admins can change the setup: items, standard costs and prices,
--     recipes, bills of materials, labor settings and purchase settings.
--   * The first account created becomes an admin. Everyone else is added by an
--     admin (Settings → Users); an account that appears any other way (a
--     public sign-up) starts disabled and can see nothing until an admin
--     enables it. A disabled account can see nothing.

-- ---------- helper: who is an admin ----------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  role       text not null default 'staff' check (role in ('staff', 'admin')),
  created_at timestamptz not null default now()
);

-- Added later: a name, and a switch to shut an account out.
alter table public.profiles add column if not exists name     text;
alter table public.profiles add column if not exists disabled boolean not null default false;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where user_id = auth.uid() and role = 'admin' and not disabled);
$$;
-- Signed in with an account that's enabled (staff or admin).
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where user_id = auth.uid() and not disabled);
$$;

-- New sign-ins get a profile automatically (first one is admin).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- The very first account is the admin; any other starts disabled until an
  -- admin enables it (the admin panel enables the people it adds).
  insert into public.profiles (user_id, email, role, disabled)
  values (new.id, new.email,
          case when exists (select 1 from public.profiles where role = 'admin') then 'staff' else 'admin' end,
          exists (select 1 from public.profiles where role = 'admin'))
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Records who last changed a row and when.
create or replace function public.touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- ---------- setup (admins edit) ----------
create table if not exists public.items (
  item_no   int primary key,
  name      text not null unique,
  type      text not null check (type in ('Raw Material', 'Component', 'Indirect Cost', 'Recipe', 'Finished Good')),
  unit      text,
  pack_note text,            -- e.g. "30lbs ea", shown under the column headings
  sort      int not null default 0
);
-- How an item is received when that differs from its base unit: a box of
-- cheese is 30 lb, a case of 7 oz containers is 1,000.
alter table public.items add column if not exists receiving_unit      text;
alter table public.items add column if not exists units_per_receiving numeric check (units_per_receiving > 0);

create table if not exists public.standard_costs (
  item_no int not null references public.items (item_no) on update cascade on delete cascade,
  year    int not null,
  cost    numeric not null,
  primary key (item_no, year)
);

create table if not exists public.standard_prices (
  item_no int not null references public.items (item_no) on update cascade on delete cascade,
  year    int not null,
  price   numeric not null,
  primary key (item_no, year)
);

create table if not exists public.recipes (
  item_no    int primary key references public.items (item_no) on update cascade on delete cascade,
  name       text not null unique,
  batch_size numeric not null check (batch_size > 0)   -- oz per batch
);

create table if not exists public.recipe_lines (
  id                 bigint generated always as identity primary key,
  recipe_item_no     int not null references public.recipes (item_no) on update cascade on delete cascade,
  item_no            int not null references public.items (item_no) on update cascade,
  qty                numeric,                    -- per batch, in the item's unit
  uses_batch_minutes boolean not null default false, -- labor/overhead: qty = minutes per batch setting
  sort               int not null default 0
);

create table if not exists public.fg_lines (     -- finished goods bill of materials
  id         bigint generated always as identity primary key,
  fg_item_no int not null references public.items (item_no) on update cascade on delete cascade,
  item_no    int not null references public.items (item_no) on update cascade,
  qty        numeric,
  sort       int not null default 0
);

-- Multi-level bills of materials. A BOM belongs to the item it makes and says
-- how much one run makes (yield_qty, e.g. 1 case or a 3,220 oz batch). Lines
-- can be any item, including one that has its own BOM, to any depth.
-- (recipes / recipe_lines / fg_lines above are the older layout; the app now
-- uses these tables, and existing rows are copied in at the end of this file.)
create table if not exists public.boms (
  item_no    int primary key references public.items (item_no) on update cascade on delete cascade,
  yield_qty  numeric not null default 1 check (yield_qty > 0),
  yield_unit text
);

create table if not exists public.bom_lines (
  id                 bigint generated always as identity primary key,
  parent_item_no     int not null references public.boms (item_no) on update cascade on delete cascade,
  item_no            int not null references public.items (item_no) on update cascade,
  qty                numeric,                         -- per run of the parent BOM
  uses_batch_minutes boolean not null default false,  -- labor/overhead: qty = minutes per batch setting
  sort               int not null default 0,
  check (parent_item_no <> item_no)
);
create index if not exists bom_lines_parent_idx on public.bom_lines (parent_item_no);

create table if not exists public.settings (
  id                    int primary key default 1 check (id = 1),
  salaried_count        numeric not null default 0,
  hourly_a_count        numeric not null default 0,
  hourly_b_count        numeric not null default 0,
  salaried_wage         numeric not null default 0, -- annual, incl. fringe
  hourly_a_rate         numeric not null default 0,
  hourly_b_rate         numeric not null default 0,
  minutes_per_batch     numeric not null default 0,
  production_batch_size numeric not null default 0  -- oz
);

-- The date the whole site treats as today. Blank = the real date (normal).
alter table public.settings add column if not exists site_date date;
-- It was pinned to 7/13/2026 while the data was being caught up; back to the real date.
update public.settings set site_date = null where id = 1 and site_date = '2026-07-13';

create table if not exists public.year_settings (
  year           int primary key,
  labor_scenario int not null check (labor_scenario between 1 and 5)
);

-- Labor minutes per run of a BOM (a recipe's labor minutes per batch). BOM
-- lines marked uses_batch_minutes (Direct Labor, Overhead) take this as their
-- quantity. First time: filled from the old single minutes-per-batch setting.
alter table public.boms add column if not exists labor_minutes numeric;
update public.boms b set labor_minutes = s.minutes_per_batch
from public.settings s
where s.id = 1 and b.labor_minutes is null and s.minutes_per_batch > 0
  and exists (select 1 from public.bom_lines l where l.parent_item_no = b.item_no and l.uses_batch_minutes);

-- ---------- labor rate (Labor tab) ----------
-- Each year's people, entered fresh for that year (the Labor tab can copy the
-- year before as a starting point). Amounts are per person. Hourly: hourly
-- rate + monthly fringe. Salaried: annual salary + annual fixed cost. All paid
-- time is in the labor rate. People who work the line are on it while it runs
-- (the year's production hours a week), up to the hours they're paid.
create table if not exists public.labor_positions (
  id              bigint generated by default as identity primary key,
  year            int not null,
  name            text not null,
  pay_type        text not null default 'hourly' check (pay_type in ('hourly', 'salaried')),
  headcount       numeric not null default 1,
  hourly_rate     numeric,                       -- hourly: wage per hour
  monthly_fringe  numeric,                       -- hourly: benefits etc. per month
  annual_salary   numeric,                       -- salaried: salary per year
  annual_fixed    numeric,                       -- salaried: benefits etc. per year
  payroll_tax_pct numeric not null default 7.65, -- employer payroll taxes, % of base pay
  paid_hours_week numeric not null default 40,   -- hours a week paid
  on_line         boolean not null default true, -- works on the production line
  notes           text,
  sort            int not null default 0
);
create index if not exists labor_positions_year_idx on public.labor_positions (year);

-- Each year's line assumptions.
alter table public.year_settings drop constraint if exists year_settings_labor_scenario_check;
alter table public.year_settings alter column labor_scenario drop not null;
alter table public.year_settings add column if not exists labor_prod_weeks numeric; -- weeks the line runs (blank = 52)
alter table public.year_settings add column if not exists labor_line_hours numeric; -- production hours a week
alter table public.year_settings add column if not exists labor_inflation_pct numeric; -- a year without its own people starts from the year before, raised by this %

-- First time: the earliest standards year's people, from the old staffing
-- settings. The line ran that year's workbook scenario days x 8 hours a week;
-- hourly people were paid for those hours, salaried people for 40.
update public.year_settings y set labor_line_hours = coalesce(y.labor_scenario, 5) * 8
where y.year = (select min(year) from public.year_settings) and y.labor_line_hours is null
  and not exists (select 1 from public.labor_positions)
  and exists (select 1 from public.settings s where s.id = 1 and s.salaried_count + s.hourly_a_count + s.hourly_b_count > 0);
insert into public.labor_positions (year, name, pay_type, headcount, hourly_rate, annual_salary, payroll_tax_pct, paid_hours_week, sort)
select y.year, p.name, p.pay_type, p.headcount, p.rate, p.salary, 0, p.hours, p.sort
from public.settings s
cross join lateral (select year, coalesce(labor_scenario, 5) * 8::numeric as line_hours from public.year_settings order by year limit 1) y
cross join lateral (values
  ('Salaried', 'salaried', s.salaried_count, null::numeric, s.salaried_wage, 40::numeric, 1),
  ('Hourly (A)', 'hourly', s.hourly_a_count, s.hourly_a_rate, null::numeric, y.line_hours, 2),
  ('Hourly (B)', 'hourly', s.hourly_b_count, s.hourly_b_rate, null::numeric, y.line_hours, 3)
) as p (name, pay_type, headcount, rate, salary, hours, sort)
where s.id = 1 and s.salaried_count + s.hourly_a_count + s.hourly_b_count > 0
  and not exists (select 1 from public.labor_positions);
-- 2026 starting pay and fringe (per person). Only fills rows still at the
-- values first copied from the workbook, so nothing entered since is changed.
update public.labor_positions set annual_salary = 70500, annual_fixed = 5600
where year = 2026 and name = 'Salaried' and pay_type = 'salaried' and annual_salary = 80000 and annual_fixed is null;
update public.labor_positions set monthly_fringe = 250
where year = 2026 and name = 'Hourly (A)' and pay_type = 'hourly' and hourly_rate = 21.55 and monthly_fringe is null;
update public.labor_positions set monthly_fringe = 200
where year = 2026 and name = 'Hourly (B)' and pay_type = 'hourly' and hourly_rate = 16.19 and monthly_fringe is null;

-- ---------- overhead rate (Overhead tab) ----------
-- Each year's overhead costs (rent, utilities, insurance...), per month. A
-- year without its own starts from the year before, raised by the year's
-- overhead inflation %. Overhead (item 300002) costs the year's total divided
-- by the year's production minutes: line minutes (production hours a week x
-- weeks x 60, from the Labor tab's line assumptions) or labor minutes (the
-- same, times everyone on the line), per year_settings.overhead_basis.
create table if not exists public.overhead_costs (
  id             bigint generated by default as identity primary key,
  year           int not null,
  name           text not null,
  monthly_amount numeric not null default 0,
  notes          text,
  sort           int not null default 0
);
create index if not exists overhead_costs_year_idx on public.overhead_costs (year);
alter table public.year_settings add column if not exists overhead_basis text check (overhead_basis in ('line', 'labor')); -- blank = line
alter table public.year_settings add column if not exists overhead_inflation_pct numeric;

-- First time: one line for the earliest year, worked back from that year's
-- overhead standard cost per minute and its line minutes, so the standard
-- comes out the same as before.
insert into public.overhead_costs (year, name, monthly_amount, sort)
select c.year, 'Overhead', round(c.cost * y.labor_line_hours * coalesce(y.labor_prod_weeks, 52) * 60 / 12, 2), 1
from public.standard_costs c
join public.year_settings y on y.year = c.year
where c.item_no in (300002, 10020) and c.cost > 0 and y.labor_line_hours > 0
  and not exists (select 1 from public.overhead_costs)
order by c.year
limit 1;

create table if not exists public.purchase_settings (
  item_no           int primary key references public.items (item_no) on update cascade on delete cascade,
  avg_weekly        numeric,
  max_weekly        numeric,
  manual_usage      numeric,
  standard_purchase numeric,
  lead_time         numeric,
  safety_threshold  numeric
);
-- Planning: lead time in days (blank = 14), a typed-in safety stock (blank =
-- calculated), and free notes about the item (Safety Stocks, the (i) by its name).
alter table public.purchase_settings add column if not exists lead_days    int check (lead_days >= 0);
alter table public.purchase_settings add column if not exists safety_stock numeric check (safety_stock >= 0);
alter table public.purchase_settings add column if not exists notes        text;

-- Production plan: cases of a finished good to make in a week (weeks start
-- Monday). Weeks with no row use the product's average weekly sales.
create table if not exists public.production_plan (
  item_no int  not null references public.items (item_no) on update cascade on delete cascade,
  week    date not null check (extract(isodow from week) = 1),
  cases   numeric not null check (cases >= 0),
  primary key (item_no, week)
);

-- ---------- day-to-day activity (everyone signed in) ----------

create table if not exists public.production (
  date       date not null,
  item_no    int not null references public.items (item_no) on update cascade,
  cases      numeric not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (date, item_no)
);

create table if not exists public.goods_receipts (
  date       date not null,
  item_no    int not null references public.items (item_no) on update cascade,
  qty        numeric not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (date, item_no)
);

create table if not exists public.cycle_counts (
  date       date not null,
  item_no    int not null references public.items (item_no) on update cascade,
  qty        numeric not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (date, item_no)
);

create table if not exists public.sales (
  id         bigint generated always as identity primary key,
  date       date not null,
  invoice    text,
  quantity   numeric,
  price      numeric,
  amount     numeric,
  customer   text,
  product    text,      -- finished good name, or "Other" for fees and credits
  item_no    int references public.items (item_no) on update cascade,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create index if not exists sales_date_idx on public.sales (date);

-- Sales Detail (public.sales) can be loaded from QuickBooks "Sales by
-- Product/Service Detail" reports. Each load is recorded so it can be undone,
-- and loaded rows keep the QuickBooks names they came from.
create table if not exists public.sales_imports (
  id            bigint generated always as identity primary key,
  file_name     text,
  period        text,              -- as printed on the report, e.g. "February-July, 2026"
  date_from     date,
  date_to       date,
  lines_added   int not null default 0,
  lines_skipped int not null default 0,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);
alter table public.sales add column if not exists txn_type    text;  -- Invoice, Credit Memo, ...
alter table public.sales add column if not exists description text;
alter table public.sales add column if not exists qb_product  text;  -- QuickBooks product/service
alter table public.sales add column if not exists qb_customer text;  -- QuickBooks customer full name
alter table public.sales add column if not exists import_id   bigint references public.sales_imports (id) on delete cascade;

-- How QuickBooks names become Sales Detail names, e.g.
-- customer "Grocer Corporate:Grocer, Inc - Springfield" -> "Grocer (Springfield)",
-- product "14 oz Case - Original Pimento Cheese (24)" -> a finished good, or "Other".
create table if not exists public.qb_name_map (
  kind    text not null check (kind in ('customer', 'product')),
  qb_name text not null,
  name    text not null,
  primary key (kind, qb_name)
);


do $$
declare t text;
begin
  foreach t in array array['production', 'goods_receipts', 'cycle_counts', 'sales'] loop
    execute format('drop trigger if exists touch on public.%I', t);
    execute format('create trigger touch before update on public.%I for each row execute function public.touch()', t);
  end loop;
end $$;

-- ---------- roles (Settings → Roles) ----------
-- Each person has one role. Admin can do everything, including Settings; it
-- can't be changed. Every other role says, page by page (keys are the site's
-- tab ids, e.g. newreceipts), whether it's hidden ('none'), view only ('view')
-- or can be changed ('edit').
-- Staff is built in (it can be changed but not deleted); admins add others.
create table if not exists public.roles (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  name        text not null,
  description text,
  permissions jsonb not null default '{}'::jsonb,
  builtin     boolean not null default false,
  sort        int not null default 0
);
insert into public.roles (id, name, description, permissions, builtin, sort) values
  ('admin', 'Admin', null, '{}'::jsonb, true, 0),
  ('staff', 'Accountant', null,
   '{"dashboard":"view","journals":"view","taccounts":"view","sales":"edit","sales-customers":"view","sales-products":"view","prices":"edit","production":"edit","lots":"view","newlots":"edit","newreceipts":"edit","receipts":"edit","newcounts":"edit","counts":"edit","inventory":"view","consumption":"view","planning":"edit","purchasing":"view","safety":"edit","costs":"edit","bom":"edit","labor":"edit","overhead":"edit","periods":"edit"}'::jsonb, true, 1)
on conflict (id) do nothing;
-- The built-in staff role is called Accountant; roles no longer have descriptions.
update public.roles set name = 'Accountant' where id = 'staff' and name = 'Staff';
update public.roles set description = null where description is not null;
-- Production became its own module (Daily, Lots, New Lots): a role keeps what it
-- had on Production for Daily and gets the same on New Lots, and can see Lots.
update public.roles set permissions = permissions
  || jsonb_build_object('newlots', permissions->>'production')
  || jsonb_build_object('lots', case when permissions->>'production' in ('view', 'edit') then 'view' else 'none' end)
where permissions ? 'production' and not permissions ? 'newlots';
-- A profile's role is one of these (it used to be only staff or admin).
alter table public.profiles drop constraint if exists profiles_role_check;
do $$ begin
  alter table public.profiles add constraint profiles_role_fkey foreign key (role) references public.roles (id) on update cascade;
exception when duplicate_object then null; end $$;

-- Someone can have several roles: they get the most access any of them gives.
-- profiles.roles holds them all; profiles.role is kept in step (admin if
-- they're an admin, otherwise their first role) for the checks that only ask
-- "is this an admin?". Setting just profiles.role (older code) sets roles to it.
alter table public.profiles add column if not exists roles text[] not null default '{}';
update public.profiles set roles = array[role] where roles = '{}';
create or replace function public.profiles_roles() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r text; clean text[] := '{}';
begin
  if tg_op = 'UPDATE' and new.role is distinct from old.role and new.roles is not distinct from old.roles then new.roles := array[new.role]; end if;
  if coalesce(cardinality(new.roles), 0) = 0 then new.roles := array[coalesce(new.role, 'staff')]; end if;
  foreach r in array new.roles loop
    if not exists (select 1 from public.roles x where x.id = r) then raise exception 'Unknown role: %', r; end if;
    if not r = any(clean) then clean := clean || r; end if;
  end loop;
  new.roles := clean;
  new.role := case when 'admin' = any(clean) then 'admin' else clean[1] end;
  return new;
end $$;
-- Named to run before keep_an_admin (triggers run in name order), so that sees the synced role.
drop trigger if exists profiles_roles on public.profiles;
drop trigger if exists a_profiles_roles on public.profiles;
create trigger a_profiles_roles before insert or update on public.profiles for each row execute function public.profiles_roles();

-- Admin can't be changed; built-in roles and roles someone has can't be deleted.
create or replace function public.roles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.builtin then raise exception 'The % role is built in and can’t be deleted.', old.name; end if;
    if exists (select 1 from public.profiles p where old.id = any(p.roles)) then
      raise exception 'Someone still has the % role. Give them another role first.', old.name;
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.id = 'admin' then raise exception 'The Admin role can’t be changed.'; end if;
    if new.id <> old.id or new.builtin <> old.builtin then raise exception 'A role’s id can’t be changed.'; end if;
  end if;
  return new;
end $$;
drop trigger if exists roles_guard on public.roles;
create trigger roles_guard before insert or update or delete on public.roles for each row execute function public.roles_guard();

-- Can the signed-in person view (or, with 'edit', change) this page?
create or replace function public.can(p_area text, p_need text default 'view') returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.user_id = auth.uid() and not p.disabled
       and ('admin' = any(p.roles) or p.role = 'admin'
            or exists (select 1 from public.roles r
                        where r.id = any(p.roles)
                          and case coalesce(r.permissions ->> p_area, 'none')
                                when 'edit' then true
                                when 'view' then p_need = 'view'
                                else false end)))
$$;
-- Any of these pages.
create or replace function public.can_any(p_areas text[], p_need text default 'view') returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from unnest(p_areas) a where public.can(a, p_need))
$$;
-- Sales lines and prices are only sent to people who can see a page built from them.
create or replace function public.can_see_sales() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.can_any(array['sales', 'sales-customers', 'sales-products', 'prices', 'dashboard', 'journals', 'taccounts'])
$$;

-- ---------- closed periods (Settings → Periods) ----------
-- A closed month's production, deliveries, counts and sales can't be added to,
-- changed or removed, by anyone, until an admin reopens it.
create table if not exists public.closed_periods (
  month           date primary key check (extract(day from month) = 1),
  closed_at       timestamptz not null default now(),
  closed_by       uuid default auth.uid(),
  closed_by_email text,
  note            text
);
create or replace function public.closed_periods_who() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.closed_by := auth.uid();
  new.closed_at := now();
  select p.email into new.closed_by_email from public.profiles p where p.user_id = auth.uid();
  return new;
end $$;
drop trigger if exists closed_periods_who on public.closed_periods;
create trigger closed_periods_who before insert on public.closed_periods for each row execute function public.closed_periods_who();

-- A whole year can be closed too (Settings → Periods → Close year). Its months
-- are closed with it and can't be reopened one by one until the year is
-- reopened; reopening the year leaves its months closed.
create table if not exists public.closed_years (
  year            int primary key,
  closed_at       timestamptz not null default now(),
  closed_by       uuid default auth.uid(),
  closed_by_email text
);
drop trigger if exists closed_years_who on public.closed_years;
create trigger closed_years_who before insert on public.closed_years for each row execute function public.closed_periods_who();
create or replace function public.month_in_closed_year() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.closed_years y where y.year = extract(year from old.month)::int) then
    raise exception '% Ending is closed. Reopen it first, then the month.', extract(year from old.month)::int;
  end if;
  return old;
end $$;
drop trigger if exists month_in_closed_year on public.closed_periods;
create trigger month_in_closed_year before delete on public.closed_periods for each row execute function public.month_in_closed_year();

-- Each year also has a Beginning and an Ending (Settings → Periods).
-- Beginning closed: that year's standards (costs, prices, BOMs, labor,
-- overhead and year settings) can't change. Ending closed (closed_years): the
-- year is closed and its standards roll over to the next year's, with the
-- revaluation journal entry stored in closed_years.rollover. The next year's
-- Beginning must be closed first, so the standards rolled over to are final.
create table if not exists public.closed_beginnings (
  year            int primary key,
  closed_at       timestamptz not null default now(),
  closed_by       uuid default auth.uid(),
  closed_by_email text
);
drop trigger if exists closed_beginnings_who on public.closed_beginnings;
create trigger closed_beginnings_who before insert on public.closed_beginnings for each row execute function public.closed_periods_who();
alter table public.closed_years add column if not exists rollover jsonb;

create or replace function public.standards_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare y int;
begin
  if auth.uid() is null then return coalesce(new, old); end if; -- database updates on deploy
  foreach y in array array[case when tg_op <> 'INSERT' then old.year end, case when tg_op <> 'DELETE' then new.year end] loop
    if y is not null and exists (select 1 from public.closed_beginnings b where b.year = y) then
      raise exception '%’s standards are locked, so they can’t be changed. An admin can reopen % Beginning in Settings → Periods.', y, y;
    end if;
  end loop;
  return coalesce(new, old);
end $$;
do $$
declare t text;
begin
  foreach t in array array['standard_costs', 'standard_prices', 'boms', 'bom_lines', 'labor_positions', 'overhead_costs', 'year_settings'] loop
    execute format('drop trigger if exists standards_guard on public.%I', t);
    execute format('create trigger standards_guard before insert or update or delete on public.%I for each row execute function public.standards_guard()', t);
  end loop;
end $$;

-- The order things close in: next year's Beginning before this year's Ending;
-- this year's Ending reopened before next year's Beginning.
create or replace function public.year_order_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'closed_years' and tg_op = 'INSERT'
     and not exists (select 1 from public.closed_beginnings b where b.year = new.year + 1) then
    raise exception 'Close % Beginning first, so the standards % rolls over to are final.', new.year + 1, new.year;
  end if;
  if tg_table_name = 'closed_beginnings' and tg_op = 'DELETE'
     and exists (select 1 from public.closed_years y where y.year = old.year - 1) then
    raise exception '% Ending rolled over to these standards. Reopen % Ending first.', old.year - 1, old.year - 1;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists year_order_guard on public.closed_years;
create trigger year_order_guard before insert on public.closed_years for each row execute function public.year_order_guard();
drop trigger if exists year_order_guard on public.closed_beginnings;
create trigger year_order_guard before delete on public.closed_beginnings for each row execute function public.year_order_guard();

create or replace function public.period_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare d date;
begin
  foreach d in array array[case when tg_op <> 'INSERT' then old.date end, case when tg_op <> 'DELETE' then new.date end] loop
    if d is not null and (exists (select 1 from public.closed_periods c where c.month = date_trunc('month', d)::date)
                          or exists (select 1 from public.closed_years y where y.year = extract(year from d)::int)) then
      raise exception '% is closed, so entries dated % can’t be changed. An admin can reopen it in Settings → Periods.', to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMM/FMDD/YYYY');
    end if;
  end loop;
  return coalesce(new, old);
end $$;
do $$
declare t text;
begin
  foreach t in array array['production', 'goods_receipts', 'cycle_counts', 'sales'] loop
    execute format('drop trigger if exists period_guard on public.%I', t);
    execute format('create trigger period_guard before insert or update or delete on public.%I for each row execute function public.period_guard()', t);
  end loop;
end $$;

-- ---------- access rules ----------
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_member() to authenticated;

-- Roles: admins add, rename and change permissions; whether a role is built in can't be set.
revoke insert, update on public.roles from authenticated;
grant insert (id, name, description, permissions, sort), update (name, description, permissions, sort) on public.roles to authenticated;
-- Closing a month: only which month and a note; who and when are filled in.
revoke insert, update on public.closed_periods from authenticated;
grant insert (month, note), update (note) on public.closed_periods to authenticated;
revoke insert, update on public.closed_years from authenticated;
grant insert (year, rollover) on public.closed_years to authenticated;
revoke insert, update on public.closed_beginnings from authenticated;
grant insert (year) on public.closed_beginnings to authenticated;
grant execute on function public.can(text, text) to authenticated;
grant execute on function public.can_see_sales() to authenticated;
grant execute on function public.can_any(text[], text) to authenticated;

-- Who reads and who changes each table. Reading: everyone signed in, except
-- sales lines and prices (see can_see_sales). Changing: whoever's role can
-- edit a page that changes it (Settings → Roles); admins always can.
do $$
declare t text; a text; rd text;
begin
  for t, a in select * from (values
      ('production', '{production,newlots}'), ('goods_receipts', '{newreceipts,receipts}'), ('cycle_counts', '{newcounts,counts}'),
      ('sales', '{sales}'), ('sales_imports', '{sales}'), ('qb_name_map', '{sales}'), ('standard_prices', '{prices}'),
      ('production_plan', '{planning}'), ('purchase_settings', '{safety}'),
      ('items', '{costs}'), ('standard_costs', '{costs}'), ('boms', '{bom}'), ('bom_lines', '{bom}'),
      ('labor_positions', '{labor}'), ('overhead_costs', '{overhead}'), ('year_settings', '{costs,labor,overhead}'),
      ('roles', '{roles}'), ('closed_periods', '{periods}'), ('closed_years', '{periods}'), ('closed_beginnings', '{periods}'),
      ('settings', null), ('recipes', null), ('recipe_lines', null), ('fg_lines', null)) as x(t, a) loop
    rd := case when t in ('sales', 'sales_imports', 'qb_name_map', 'standard_prices') then 'public.can_see_sales()' else 'public.is_member()' end;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('drop policy if exists "admins write" on public.%I', t);
    execute format('drop policy if exists "signed in" on public.%I', t);
    execute format('drop policy if exists "edit" on public.%I', t);
    execute format('create policy "read" on public.%I for select to authenticated using (%s)', t, rd);
    execute format('create policy "edit" on public.%I for all to authenticated using (%s) with check (%s)', t,
      case when a is null then 'public.is_admin()' else format('public.can_any(%L::text[], %L)', a, 'edit') end,
      case when a is null then 'public.is_admin()' else format('public.can_any(%L::text[], %L)', a, 'edit') end);
  end loop;
end $$;

alter table public.profiles enable row level security;
drop policy if exists "see self or admin" on public.profiles;
drop policy if exists "admins change roles" on public.profiles;
-- Settings → Users and Roles are pages a role can be given (Settings → Roles).
create policy "see self or admin" on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.can_any(array['users', 'roles', 'security']));
create policy "admins change roles" on public.profiles for update to authenticated
  using (public.can('users', 'edit')) with check (public.can('users', 'edit'));
-- Profiles are created by the sign-up trigger only, and admins can change
-- only the name, role and enabled switch (never who a profile belongs to).
revoke insert, delete, update on public.profiles from authenticated;
grant update (name, role, roles, disabled) on public.profiles to authenticated;

-- Keeps at least one admin, so nobody can lock everyone out of the setup.
create or replace function public.keep_an_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Someone who can edit Users but isn't an admin can't touch an admin's
  -- account or hand out the Admin role.
  if auth.uid() is not null and not public.is_admin()
     and ('admin' = any(old.roles) or old.role = 'admin' or 'admin' = any(new.roles) or new.role = 'admin') then
    raise exception 'Only an admin can change an admin’s account or give the Admin role.';
  end if;
  if auth.uid() is not null and not public.is_admin() and new.user_id = auth.uid() and new.roles is distinct from old.roles then
    raise exception 'You can’t change your own roles.';
  end if;
  if old.role = 'admin' and not old.disabled and (new.role <> 'admin' or new.disabled)
     and not exists (select 1 from public.profiles where role = 'admin' and not disabled and user_id <> old.user_id) then
    raise exception 'There must be at least one admin.';
  end if;
  if new.disabled and not old.disabled and new.user_id = auth.uid() then
    raise exception 'You can’t disable your own account.';
  end if;
  return new;
end $$;
drop trigger if exists keep_an_admin on public.profiles;
create trigger keep_an_admin before update on public.profiles for each row execute function public.keep_an_admin();

-- Refuses a BOM line that would make a loop (an item inside itself, at any depth).
create or replace function public.bom_no_loops() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (
    with recursive below(item_no) as (
      select new.item_no
      union
      select l.item_no from public.bom_lines l join below b on l.parent_item_no = b.item_no
    )
    select 1 from below where item_no = new.parent_item_no
  ) then
    raise exception 'That would put an item inside itself.';
  end if;
  return new;
end $$;
drop trigger if exists bom_no_loops on public.bom_lines;
create trigger bom_no_loops before insert or update on public.bom_lines for each row execute function public.bom_no_loops();

-- One-time copy of the older recipe / finished-good layout into the BOM tables.
-- Runs only while the BOM tables are empty, so running this file again is safe.
do $$
begin
  if not exists (select 1 from public.boms) and not exists (select 1 from public.bom_lines) then
    insert into public.boms (item_no, yield_qty, yield_unit)
      select item_no, batch_size, 'oz' from public.recipes;
    insert into public.boms (item_no, yield_qty, yield_unit)
      select distinct fg_item_no, 1, 'case' from public.fg_lines
      on conflict do nothing;
    insert into public.bom_lines (parent_item_no, item_no, qty, uses_batch_minutes, sort)
      select recipe_item_no, item_no, qty, uses_batch_minutes, sort from public.recipe_lines;
    insert into public.bom_lines (parent_item_no, item_no, qty, uses_batch_minutes, sort)
      select fg_item_no, item_no, qty, false, sort from public.fg_lines;
  end if;
end $$;

-- BOMs by year. Each BOM row starts in its `year` and carries forward until a
-- later year has its own, so changing next year's BOM leaves this year (and
-- the past) alone. BOMs from before this existed start in 2026, the first year.
alter table public.boms add column if not exists year int not null default 2026;
alter table public.bom_lines add column if not exists year int not null default 2026;
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.bom_lines'::regclass and conname = 'bom_lines_parent_item_no_fkey') then
    alter table public.bom_lines drop constraint bom_lines_parent_item_no_fkey;
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.boms'::regclass and conname = 'boms_pkey' and array_length(conkey, 1) = 1) then
    alter table public.boms drop constraint boms_pkey;
    alter table public.boms add constraint boms_pkey primary key (item_no, year);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.bom_lines'::regclass and conname = 'bom_lines_parent_year_fkey') then
    alter table public.bom_lines add constraint bom_lines_parent_year_fkey foreign key (parent_item_no, year)
      references public.boms (item_no, year) on update cascade on delete cascade;
  end if;
end $$;
create index if not exists bom_lines_parent_year_idx on public.bom_lines (parent_item_no, year);

-- Item numbers are six digits and the first digit says the type:
-- 1 raw material, 2 component (packaging), 3 indirect cost (labor, overhead,
-- marketing, ...), 4 recipe, 5 finished good. Older five-digit numbers are
-- renumbered once (each type in old-number order); every table that refers to
-- an item follows along (on update cascade).
do $$
begin
  if exists (select 1 from public.items where item_no < 100000) then
    with p as (
      select item_no, type, case type when 'Raw Material' then 1 when 'Component' then 2 when 'Indirect Cost' then 3
                                      when 'Recipe' then 4 when 'Finished Good' then 5 end as prefix
      from public.items where item_no < 100000
    ), ranked as (
      select p.item_no,
             greatest(p.prefix * 100000, coalesce((select max(i.item_no) from public.items i where i.item_no / 100000 = p.prefix and i.item_no >= 100000), 0))
               + row_number() over (partition by p.prefix order by p.item_no) as new_no
      from p
    )
    update public.items i set item_no = r.new_no from ranked r where i.item_no = r.item_no;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.items'::regclass and conname = 'items_item_no_by_type') then
    alter table public.items add constraint items_item_no_by_type check (
      item_no / 100000 = case type when 'Raw Material' then 1 when 'Component' then 2 when 'Indirect Cost' then 3
                                   when 'Recipe' then 4 when 'Finished Good' then 5 end
      and item_no < 600000);
  end if;
end $$;

-- Receiving units as first set up (only where none is set yet). The unit is a
-- plain word (box, bag, case, drum); what's in it is units_per_receiving.
update public.items i set receiving_unit = v.ru, units_per_receiving = v.per
from (values ('Cheese', 'box', 30), ('Mayonnaise', 'drum', 420), ('Pepper', 'bag', 175),
             ('Pimentos', 'case', 96), ('Sodium Benzoate', 'bag', 128), ('Brown Sugar', 'bag', 175),
             ('Hot Sauce', 'case', 64), ('Lemon Juice', 'case', 64), ('Ground Jalapeños', 'case', 175),
             ('7 oz Container', 'case', 1000), ('7 oz Lid', 'case', 1000), ('7 oz Case Box', 'case', 500),
             ('14 oz Container', 'case', 500), ('14 oz Lid', 'case', 1000), ('14 oz Case Box', 'case', 500)) as v (name, ru, per)
where i.name = v.name and i.receiving_unit is null and i.units_per_receiving is null;
-- Earlier descriptive names ("bag (50 lb)") become the plain word.
update public.items set receiving_unit = lower(split_part(receiving_unit, ' (', 1)) where receiving_unit like '% (%';

-- ---------- change history ----------
-- Every change to setup data (items, costs, prices, BOMs, labor, settings,
-- planning): who, when, and the row before and after.
-- Admins can read it; nobody can change it.
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  email      text,
  table_name text not null,
  action     text not null,
  old_row    jsonb,
  new_row    jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);

create or replace function public.audit_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare who uuid := auth.uid(); em text;
begin
  select p.email into em from public.profiles p where p.user_id = who;
  insert into public.audit_log (user_id, email, table_name, action, old_row, new_row)
  values (who, em, tg_table_name, lower(tg_op),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['items', 'standard_costs', 'standard_prices', 'boms', 'bom_lines', 'settings', 'year_settings',
                           'purchase_settings', 'labor_positions', 'overhead_costs', 'production_plan', 'profiles', 'roles', 'closed_periods', 'closed_years', 'closed_beginnings'] loop
    execute format('drop trigger if exists audit on public.%I', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function public.audit_change()', t);
  end loop;
end $$;

alter table public.audit_log enable row level security;
drop policy if exists "admins read" on public.audit_log;
create policy "admins read" on public.audit_log for select to authenticated using (public.can('history'));
grant select on public.audit_log to authenticated;
revoke insert, update, delete on public.audit_log from authenticated;

-- ---------- Security questions ----------
-- Everyone picks three questions from a fixed list. Answers are stored only as
-- bcrypt hashes of a normalized form (lower case, no spaces or punctuation), so
-- "Rex the Beagle" and "rex-the beagle" match, and nobody, admins included,
-- can read them back. They're checked only by check_identity() below, which
-- also takes the current password and allows 5 wrong tries per 15 minutes.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.security_answers (
  user_id     uuid not null references auth.users (id) on delete cascade,
  slot        smallint not null check (slot between 1 and 3),
  question    text not null,
  answer_hash text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, slot)
);
alter table public.security_answers enable row level security;
drop policy if exists "see own or admin" on public.security_answers;
create policy "see own or admin" on public.security_answers for select to authenticated
  using (user_id = auth.uid() or public.can_any(array['users', 'security']));
revoke all on public.security_answers from anon, authenticated;
-- Which questions someone picked, never the answers.
grant select (user_id, slot, question, updated_at) on public.security_answers to authenticated;

-- Every identity check, to slow down guessing.
create table if not exists public.identity_checks (
  user_id uuid not null,
  at      timestamptz not null default now(),
  ok      boolean not null
);
create index if not exists identity_checks_user_at on public.identity_checks (user_id, at desc);
alter table public.identity_checks enable row level security;
revoke all on public.identity_checks from anon, authenticated;

create or replace function public.normalize_answer(a text) returns text
language sql immutable set search_path = '' as
$$ select lower(regexp_replace(coalesce(a, ''), '[[:space:][:punct:]]', '', 'g')) $$;

-- Is this really the signed-in person? Checks their current password, or else
-- all of their security answers. Wrong tries are counted (5 per 15 minutes).
create or replace function public.check_identity(p_password text default null, p_answers jsonb default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); v_ok boolean := false; v_fails int; v_need int; v_hit int;
begin
  if me is null then raise exception 'Sign in again.'; end if;
  select count(*) into v_fails from public.identity_checks c
   where c.user_id = me and not c.ok and c.at > now() - interval '15 minutes'
     and c.at > coalesce((select max(c2.at) from public.identity_checks c2 where c2.user_id = me and c2.ok), '-infinity'::timestamptz);
  if v_fails >= 5 then raise exception 'Too many wrong tries. Wait 15 minutes and try again.'; end if;
  if coalesce(p_password, '') <> '' then
    select coalesce(u.encrypted_password = extensions.crypt(p_password, u.encrypted_password), false) into v_ok
      from auth.users u where u.id = me;
  elsif jsonb_typeof(p_answers) = 'array' then
    select count(*) into v_need from public.security_answers s where s.user_id = me;
    select count(*) into v_hit from public.security_answers s
      join jsonb_to_recordset(p_answers) as a(slot int, answer text) on a.slot = s.slot
     where s.user_id = me and s.answer_hash = extensions.crypt(public.normalize_answer(a.answer), s.answer_hash);
    v_ok := v_need > 0 and v_hit = v_need;
  end if;
  v_ok := coalesce(v_ok, false);
  insert into public.identity_checks (user_id, ok) values (me, v_ok);
  delete from public.identity_checks c where c.at < now() - interval '1 day';
  return v_ok;
end $$;

-- Sets the signed-in person's three questions and answers. Changing ones
-- already set needs the current password. Returns '' when saved, otherwise
-- what to fix (a wrong password is returned rather than raised, so the wrong
-- try still counts).
create or replace function public.set_security_answers(p_items jsonb, p_password text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid(); em text; r record; norm text; i int := 0;
  seen text[] := '{}'; qs text[] := '{}';
  allowed text[] := array['pet', 'street', 'car', 'city', 'school', 'nickname', 'friend', 'parents', 'job', 'sibling', 'teacher', 'food'];
  weak text[] := array['none', 'null', 'nothing', 'na', 'idk', 'dontknow', 'unknown', 'test', 'testing', 'password', 'asdf', 'qwerty',
                       'abcd', 'abc123', 'yes', 'nope', 'same', 'secret', 'answer', 'stans', 'stansims'];
begin
  if me is null or not public.is_member() then raise exception 'Sign in again.'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) <> 3 then return 'Answer three questions.'; end if;
  select u.email into em from auth.users u where u.id = me;
  for r in select * from jsonb_to_recordset(p_items) as x(question text, answer text) loop
    norm := public.normalize_answer(r.answer);
    if r.question is null or not (r.question = any(allowed)) then return 'Pick each question from the list.'; end if;
    if r.question = any(qs) then return 'Pick three different questions.'; end if;
    if length(norm) < 4 then return 'Each answer needs at least 4 letters or numbers.'; end if;
    if length(norm) > 100 then return 'Answers can be up to 100 characters.'; end if;
    if norm = any(weak) or norm ~ '^(.)\1*$' or norm ~ '^[0-9]+$' and length(norm) < 6 or norm in ('1234', '12345', '123456', '0000') then
      return 'One of the answers is too easy to guess.';
    end if;
    if norm = any(seen) then return 'Use a different answer for each question.'; end if;
    if norm = public.normalize_answer(split_part(coalesce(em, ''), '@', 1)) then return 'Don’t use your email as an answer.'; end if;
    qs := qs || r.question; seen := seen || norm;
  end loop;
  if exists (select 1 from public.security_answers s where s.user_id = me) and not public.check_identity(p_password, null) then
    return 'Your current password isn’t right.';
  end if;
  delete from public.security_answers s where s.user_id = me;
  for r in select * from jsonb_to_recordset(p_items) as x(question text, answer text) loop
    i := i + 1;
    insert into public.security_answers (user_id, slot, question, answer_hash)
    values (me, i, r.question, extensions.crypt(public.normalize_answer(r.answer), extensions.gen_salt('bf', 8)));
  end loop;
  insert into public.audit_log (user_id, email, table_name, action, new_row)
  values (me, em, 'users', 'security questions', jsonb_build_object('email', em, 'questions', to_jsonb(qs)));
  return '';
end $$;

-- Admins: clear someone's questions; they're asked to pick new ones when they
-- next sign in.
create or replace function public.reset_security_answers(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare em text; them text;
begin
  if not public.can('users', 'edit') then raise exception 'Only admins can do that.'; end if;
  if not public.is_admin() and exists (select 1 from public.profiles p where p.user_id = p_user and (p.role = 'admin' or 'admin' = any(p.roles))) then
    raise exception 'Only an admin can change an admin’s account.';
  end if;
  select p.email into em from public.profiles p where p.user_id = auth.uid();
  select p.email into them from public.profiles p where p.user_id = p_user;
  delete from public.security_answers s where s.user_id = p_user;
  insert into public.audit_log (user_id, email, table_name, action, new_row)
  values (auth.uid(), em, 'users', 'reset security questions', jsonb_build_object('email', them));
end $$;

revoke all on function public.check_identity(text, jsonb) from public, anon;
revoke all on function public.set_security_answers(jsonb, text) from public, anon;
revoke all on function public.reset_security_answers(uuid) from public, anon;
grant execute on function public.check_identity(text, jsonb) to authenticated;
grant execute on function public.set_security_answers(jsonb, text) to authenticated;
grant execute on function public.reset_security_answers(uuid) to authenticated;

-- ---------- the server's own access (service_role) ----------
-- The site's Worker uses Supabase's secret key, which acts as service_role,
-- for user management (Settings → Users) and password changes. Newer Supabase
-- projects no longer give it access to tables automatically, so it's granted
-- here, after every table above exists. service_role skips row-level security
-- and is never available to the browser.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
