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
--   * The first account created becomes an admin; everyone after that is staff.
--     Admins can change roles on the Users tab.

-- ---------- helper: who is an admin ----------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  role       text not null default 'staff' check (role in ('staff', 'admin')),
  created_at timestamptz not null default now()
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where user_id = auth.uid() and role = 'admin');
$$;

-- New sign-ins get a profile automatically (first one is admin).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, email, role)
  values (new.id, new.email,
          case when exists (select 1 from public.profiles where role = 'admin') then 'staff' else 'admin' end)
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

create table if not exists public.purchase_settings (
  item_no           int primary key references public.items (item_no) on update cascade on delete cascade,
  avg_weekly        numeric,
  max_weekly        numeric,
  manual_usage      numeric,
  standard_purchase numeric,
  lead_time         numeric,
  safety_threshold  numeric
);
-- Planning: lead time in days (blank = 14) and a typed-in safety stock (blank = calculated).
alter table public.purchase_settings add column if not exists lead_days    int check (lead_days >= 0);
alter table public.purchase_settings add column if not exists safety_stock numeric check (safety_stock >= 0);

-- Demand plan: cases of a finished good forecast for a week (weeks start Monday).
-- Weeks with no row use the product's average weekly sales.
create table if not exists public.demand_forecast (
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

-- ---------- access rules ----------
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.is_admin() to authenticated;

do $$
declare t text;
begin
  -- Setup tables: everyone signed in reads, admins write.
  foreach t in array array['items', 'standard_costs', 'standard_prices', 'recipes', 'recipe_lines', 'fg_lines',
                           'boms', 'bom_lines', 'settings', 'year_settings', 'purchase_settings', 'labor_positions', 'demand_forecast'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('drop policy if exists "admins write" on public.%I', t);
    execute format('create policy "read" on public.%I for select to authenticated using (true)', t);
    execute format('create policy "admins write" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
  -- Activity tables: everyone signed in reads and writes.
  foreach t in array array['production', 'goods_receipts', 'cycle_counts', 'sales', 'sales_imports', 'qb_name_map'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "signed in" on public.%I', t);
    execute format('create policy "signed in" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

alter table public.profiles enable row level security;
drop policy if exists "see self or admin" on public.profiles;
drop policy if exists "admins change roles" on public.profiles;
create policy "see self or admin" on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "admins change roles" on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- Profiles are created by the sign-up trigger only.
revoke insert, delete on public.profiles from authenticated;

-- Keeps at least one admin, so nobody can lock everyone out of the setup.
create or replace function public.keep_an_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin' and new.role <> 'admin'
     and not exists (select 1 from public.profiles where role = 'admin' and user_id <> old.user_id) then
    raise exception 'There must be at least one admin.';
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
                           'purchase_settings', 'labor_positions', 'demand_forecast'] loop
    execute format('drop trigger if exists audit on public.%I', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function public.audit_change()', t);
  end loop;
end $$;

alter table public.audit_log enable row level security;
drop policy if exists "admins read" on public.audit_log;
create policy "admins read" on public.audit_log for select to authenticated using (public.is_admin());
grant select on public.audit_log to authenticated;
revoke insert, update, delete on public.audit_log from authenticated;
