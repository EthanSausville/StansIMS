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

create table if not exists public.purchase_settings (
  item_no           int primary key references public.items (item_no) on update cascade on delete cascade,
  avg_weekly        numeric,
  max_weekly        numeric,
  manual_usage      numeric,
  standard_purchase numeric,
  lead_time         numeric,
  safety_threshold  numeric
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
                           'boms', 'bom_lines', 'settings', 'year_settings', 'purchase_settings'] loop
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
      on conflict (item_no) do nothing;
    insert into public.bom_lines (parent_item_no, item_no, qty, uses_batch_minutes, sort)
      select recipe_item_no, item_no, qty, uses_batch_minutes, sort from public.recipe_lines;
    insert into public.bom_lines (parent_item_no, item_no, qty, uses_batch_minutes, sort)
      select fg_item_no, item_no, qty, false, sort from public.fg_lines;
  end if;
end $$;
