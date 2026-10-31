\set ON_ERROR_STOP on
-- Two people sign up: the first becomes admin; the second is staff and starts
-- disabled until an admin enables them.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'owner@stans.test');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000b', 'staff@stans.test');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000c', 'stranger@stans.test');
select email, role, disabled from public.profiles order by email;

\echo '--- a disabled account (a sign-up nobody approved) sees and changes nothing ---'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select (select count(*) from public.items) items, (select count(*) from public.sales) sales, (select count(*) from public.production) production;
\set ON_ERROR_STOP off
\echo 'disabled account adding production (should fail):'
insert into public.production (date, item_no, cases) values ('2026-10-26', 500001, 50);
\echo 'disabled account enabling itself (should change 0 rows):'
update public.profiles set disabled = false where user_id = auth.uid();
\set ON_ERROR_STOP on
reset role;

\echo '--- the admin enables staff ---'
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
update public.profiles set disabled = false where email = 'staff@stans.test';
\set ON_ERROR_STOP off
\echo 'admin changing who a profile belongs to (should fail):'
update public.profiles set user_id = '00000000-0000-0000-0000-00000000000d' where email = 'stranger@stans.test';
\echo 'admin disabling themselves (should fail):'
update public.profiles set disabled = true where email = 'owner@stans.test';
\set ON_ERROR_STOP on
reset role;
select email, role, disabled from public.profiles order by email;

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
insert into public.production (date, item_no, cases) values ('2026-10-26', 500001, 50);
update public.production set cases = 60 where date = '2026-10-26' and item_no = 500001;
select cases, updated_by from public.production where date = '2026-10-26';
delete from public.production where date = '2026-10-26';
\echo 'staff changing a standard cost (should change 0 rows):'
update public.standard_costs set cost = 99 where item_no = 100001;
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
create temp table keep as select cost from public.standard_costs where item_no = 100001 and year = 2026;
update public.standard_costs set cost = cost + 1 where item_no = 100001 and year = 2026;
update public.standard_costs set cost = (select cost from keep) where item_no = 100001 and year = 2026;
select count(*) as profiles_admin_can_see from public.profiles;
update public.profiles set role = 'admin' where email = 'staff@stans.test';
update public.profiles set role = 'staff' where email = 'staff@stans.test';
\set ON_ERROR_STOP off
\echo 'demoting the last admin (should fail):'
update public.profiles set role = 'staff' where email = 'owner@stans.test';
\set ON_ERROR_STOP on
reset role;
select email, role from public.profiles order by email;
select cost from public.standard_costs where item_no = 100001 and year = 2026;

\echo '--- security questions ---'
update auth.users set encrypted_password = extensions.crypt('Right-pass1!', extensions.gen_salt('bf', 4)) where email = 'staff@stans.test';
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
\echo 'too-easy answers are refused:'
select public.set_security_answers('[{"question":"pet","answer":"n/a"},{"question":"car","answer":"Honda Civic"},{"question":"city","answer":"Detroit MI"}]');
select public.set_security_answers('[{"question":"pet","answer":"Rex the beagle"},{"question":"pet","answer":"Honda Civic"},{"question":"city","answer":"Detroit MI"}]');
select public.set_security_answers('[{"question":"pet","answer":"Rex the beagle"},{"question":"car","answer":"rex THE beagle"},{"question":"city","answer":"Detroit MI"}]');
\echo 'first time, no password needed (empty = saved):'
select public.set_security_answers('[{"question":"pet","answer":"Rex the Beagle"},{"question":"car","answer":"Honda Civic 98"},{"question":"city","answer":"Detroit, MI"}]') = '' as saved;
select slot, question from public.security_answers order by slot;
\set ON_ERROR_STOP off
\echo 'reading the answers back (should fail):'
select answer_hash from public.security_answers;
\set ON_ERROR_STOP on
\echo 'answers match without case, spaces or punctuation (t), a wrong one fails (f):'
select public.check_identity(null, '[{"slot":1,"answer":"rex-the beagle"},{"slot":2,"answer":"HONDA civic 98"},{"slot":3,"answer":"detroit mi"}]');
select public.check_identity(null, '[{"slot":1,"answer":"rex"},{"slot":2,"answer":"honda civic 98"},{"slot":3,"answer":"detroit mi"}]');
select public.check_identity(null, '[{"slot":1,"answer":"rex the beagle"}]');
\echo 'password: right (t), wrong (f):'
select public.check_identity('Right-pass1!'), public.check_identity('wrong');
\echo 'changing them needs the password:'
select public.set_security_answers('[{"question":"job","answer":"Paper route 1999"},{"question":"car","answer":"Honda Civic 98"},{"question":"city","answer":"Detroit, MI"}]', 'wrong');
select public.set_security_answers('[{"question":"job","answer":"Paper route 1999"},{"question":"car","answer":"Honda Civic 98"},{"question":"city","answer":"Detroit, MI"}]', 'Right-pass1!') = '' as saved;
\echo 'five wrong tries lock it for 15 minutes:'
select public.check_identity('nope1'), public.check_identity('nope2'), public.check_identity('nope3'), public.check_identity('nope4'), public.check_identity('nope5');
\echo 'even the right password is refused now (should fail):'
\set ON_ERROR_STOP off
select public.check_identity('Right-pass1!');
\echo 'staff resetting someone''s questions (should fail):'
select public.reset_security_answers('00000000-0000-0000-0000-00000000000a');
\set ON_ERROR_STOP on
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select count(*) as admin_sees_staff_questions from public.security_answers where user_id = '00000000-0000-0000-0000-00000000000b';
select public.reset_security_answers('00000000-0000-0000-0000-00000000000b');
select count(*) as after_reset from public.security_answers where user_id = '00000000-0000-0000-0000-00000000000b';
reset role;
set role anon;
\set ON_ERROR_STOP off
\echo 'anonymous checking (should fail):'
select public.check_identity('x');
\set ON_ERROR_STOP on
reset role;
select action, new_row->>'email' as who from public.audit_log where table_name = 'users' order by at;

\echo '--- the server (service_role) reads profiles and writes the change history ---'
set role service_role;
select count(*) > 0 as service_sees_profiles from public.profiles;
insert into public.audit_log (user_id, email, table_name, action, new_row) values (null, 'worker', 'users', 'test', '{}');
select count(*) as service_audit_rows from public.audit_log where email = 'worker';
reset role;
