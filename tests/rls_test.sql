\set ON_ERROR_STOP on
-- Two people sign up: the first becomes admin, the second staff.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'owner@stans.test');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000b', 'staff@stans.test');
select email, role from public.profiles order by email;

\echo '--- anonymous visitor (not signed in) ---'
set role anon;
\set ON_ERROR_STOP off
select count(*) from public.items;
select count(*) from public.sales;
\set ON_ERROR_STOP on
reset role;

\echo '--- staff ---'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select (select count(*) from public.items) items, (select count(*) from public.sales) sales, (select count(*) from public.production) production;
insert into public.production (date, item_no, cases) values ('2026-10-26', 20001, 50);
update public.production set cases = 60 where date = '2026-10-26' and item_no = 20001;
select cases, updated_by from public.production where date = '2026-10-26';
delete from public.production where date = '2026-10-26';
\echo 'staff changing a standard cost (should change 0 rows):'
update public.standard_costs set cost = 99 where item_no = 10001;
\set ON_ERROR_STOP off
\echo 'staff adding an item (should fail):'
insert into public.items (item_no, name, type) values (99999, 'Hack', 'Component');
\echo 'staff promoting self (should change 0 rows):'
update public.profiles set role = 'admin' where user_id = auth.uid();
\set ON_ERROR_STOP on
select count(*) as profiles_staff_can_see from public.profiles;
reset role;

\echo '--- admin ---'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
create temp table keep as select cost from public.standard_costs where item_no = 10001 and year = 2026;
update public.standard_costs set cost = cost + 1 where item_no = 10001 and year = 2026;
update public.standard_costs set cost = (select cost from keep) where item_no = 10001 and year = 2026;
select count(*) as profiles_admin_can_see from public.profiles;
update public.profiles set role = 'admin' where email = 'staff@stans.test';
update public.profiles set role = 'staff' where email = 'staff@stans.test';
\set ON_ERROR_STOP off
\echo 'demoting the last admin (should fail):'
update public.profiles set role = 'staff' where email = 'owner@stans.test';
\set ON_ERROR_STOP on
reset role;
select email, role from public.profiles order by email;
select cost from public.standard_costs where item_no = 10001 and year = 2026;
