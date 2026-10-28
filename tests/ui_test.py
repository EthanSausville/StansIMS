"""Headless-browser test of the site against an in-memory database.

Run:  python3 tests/ui_test.py [screenshot_dir]
Serves ./public locally, swaps the Supabase library for tests/mock-supabase.js,
loads the workbook data from tests/fixtures/workbook.json, then signs in and
exercises every tab.
"""
import json, sys, threading, functools, http.server, socketserver, pathlib, re
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
inputs = json.load(open(ROOT / 'tests/fixtures/workbook.json'))['inputs']

def mock_db():
    db = {k: v for k, v in inputs.items() if isinstance(v, list)}
    db['production'] = [dict(date=r['date'], item_no=r['item_no'], cases=r['cases']) for r in inputs['production']]
    for t in ('recipe_lines', 'fg_lines'):
        db[t] = [dict(r, id=i + 1) for i, r in enumerate(db[t])]
    db['sales'] = [dict({k: v for k, v in r.items() if k != 'row'}, id=i + 1) for i, r in enumerate(inputs['sales'])]
    db['settings'] = [dict(inputs['settings'], id=1)]
    db['profiles'] = [dict(user_id='u1', email='owner@stans.test', role='admin', created_at='2026-10-27T12:00:00Z'),
                      dict(user_id='u2', email='staff@stans.test', role='staff', created_at='2026-10-27T12:00:00Z')]
    return db

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
server = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT / 'public')))
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{port}'

failures = []
def check(cond, label):
    print(('PASS ' if cond else 'FAIL ') + label)
    if not cond: failures.append(label)

def open_app(browser, role='admin', signed_in=True, viewport=(1440, 900)):
    ctx = browser.new_context(viewport={'width': viewport[0], 'height': viewport[1]})
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    cfg = ('window.STANS_CONFIG={supabaseUrl:"https://test.supabase.co",supabaseKey:"sb_publishable_test"};'
           f'window.__MOCK_DB__={json.dumps(mock_db())};window.__MOCK_ROLE__="{role}";window.__MOCK_SIGNED_IN__={str(signed_in).lower()};')
    page.route('**/config.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=cfg))
    page.route('https://cdn.jsdelivr.net/**', lambda r: r.fulfill(status=200, content_type='text/javascript', body=(ROOT / 'tests/mock-supabase.js').read_text()))
    return ctx, page, errors

def shot(page, name):
    if SHOTS: SHOTS.mkdir(parents=True, exist_ok=True); page.screenshot(path=str(SHOTS / f'{name}.png'), full_page=False)

GROUPS = {
    'Dashboard': ['Dashboard'],
    'Inventory': ['Production', 'Goods Receipt', 'Cycle Counts', 'Daily Inventory', 'Purchase Demand', 'Sales'],
    'Standard Cost': ['Standard Cost', 'Recipes', 'Finished Goods', 'Standard Price', 'Labor', 'Journals'],
}
ALL_TABS = [t for ts in GROUPS.values() for t in ts] + ['Users']

def tab(page, label):
    if label == 'Users':
        page.locator('.who a', has_text='Users').click()
    else:
        group = next(g for g, ts in GROUPS.items() if label in ts)
        page.locator('.groups .group', has_text=group).first.click(); page.wait_for_timeout(80)
        if label != 'Dashboard':
            page.get_by_role('tab', name=label, exact=True).click()
    page.wait_for_timeout(150)

def cell(page, key):
    return page.locator(f'input[data-k="{key}"]')

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---- sign in ----
    ctx, page, errors = open_app(browser, signed_in=False)
    page.goto(BASE + '/')
    page.wait_for_selector('form input[type=email]')
    check(page.get_by_text('Sign in to manage').is_visible(), 'sign-in screen shows when signed out')
    page.fill('input[type=email]', 'owner@stans.test'); page.fill('input[type=password]', 'wrong')
    page.click('button[type=submit]'); page.wait_for_timeout(200)
    check(page.get_by_text('don’t match').is_visible(), 'wrong password shows an error')
    shot(page, '00-signin')
    page.fill('input[type=password]', 'correct-horse'); page.click('button[type=submit]')
    page.wait_for_selector('.groups .group')
    check(page.locator('h1', has_text='Management Dashboard').is_visible(), 'dashboard loads after sign-in')
    groups = page.locator('.groups .group').all_inner_texts()
    print('   groups:', ' | '.join(groups))
    check(groups == ['Dashboard', 'Inventory', 'Standard Cost'], 'three groups across the top')
    check(page.locator('.tabs').is_hidden(), 'Dashboard has no second row of tabs')
    page.locator('.groups .group', has_text='Inventory').click(); page.wait_for_timeout(100)
    sub = page.locator('.tabs .tab').all_inner_texts()
    check(sub == GROUPS['Inventory'], f'Inventory group shows its tabs ({sub})')
    page.locator('.groups .group', has_text='Standard Cost').click(); page.wait_for_timeout(100)
    sub = page.locator('.tabs .tab').all_inner_texts()
    check(sub == GROUPS['Standard Cost'], f'Standard Cost group shows its tabs ({sub})')
    page.get_by_role('tab', name='Recipes', exact=True).click(); page.wait_for_timeout(80)
    page.locator('.groups .group', has_text='Dashboard').click(); page.wait_for_timeout(80)
    page.locator('.groups .group', has_text='Standard Cost').click(); page.wait_for_timeout(100)
    check(page.locator('h1', has_text='Recipes').is_visible(), 'returning to a group reopens the last tab used there')
    check(page.locator('.who a', has_text='Users').is_visible(), 'admin sees the Users link')
    tabs = ALL_TABS

    # ---- every tab renders without errors ----
    for i, label in enumerate(tabs):
        tab(page, label)
        bad = page.locator('.note.bad', has_text='Something went wrong').count()
        check(bad == 0, f'tab renders: {label}')
        shot(page, f'{i + 1:02d}-{re.sub(r"[^a-z]+", "-", label.lower())}')
    check(not errors, 'no browser errors while visiting tabs' + (f': {errors[:3]}' if errors else ''))

    # ---- dashboard numbers (2026 through Dec) ----
    tab(page, 'Dashboard')
    page.select_option('select >> nth=1', '12'); page.wait_for_timeout(150)
    sales_card = page.locator('.stat', has_text='Sales').first.locator('.value').inner_text()
    want = '${:,.0f}'.format(sum(s['amount'] or 0 for s in inputs['sales'] if s['date'].startswith('2026')))
    check(sales_card == want, f'dashboard 2026 sales total = {want} (got {sales_card})')
    shot(page, '20-dashboard-full-year')

    # ---- production entry: July 2026 ----
    tab(page, 'Production')
    page.get_by_role('button', name='Today').click(); page.wait_for_timeout(100)
    today_label = page.locator('.monthpick .label').inner_text()
    import datetime
    back = (datetime.date.today().year - 2026) * 12 + datetime.date.today().month - 7
    for _ in range(back): page.get_by_role('button', name='Previous month').click(); page.wait_for_timeout(60)
    page.wait_for_timeout(150)
    check(page.locator('.monthpick .label').inner_text() == 'Jul 2026', 'month picker goes back to July 2026')
    c = cell(page, 'production|2026-07-14|20001')
    c.click(); c.fill('24*10'); c.press('Enter'); page.wait_for_timeout(300)
    stored = page.evaluate("window.__MOCK_DB__.production.find(r => r.date==='2026-07-14' && r.item_no===20001)")
    check(stored and stored['cases'] == 240, 'typing 24*10 saves 240 cases')
    oz = page.locator('tr:has(input[data-k="production|2026-07-14|20001"]) td.calc').nth(2).inner_text()
    check(oz == '40,320', f'oz recalculates to 40,320 (got {oz})')
    focused = page.evaluate('document.activeElement.dataset.k')
    check(focused == 'production|2026-07-15|20001', f'Enter moves to the next day (focus on {focused})')
    c = cell(page, 'production|2026-07-14|20001'); c.click(); c.fill(''); c.press('Tab'); page.wait_for_timeout(300)
    gone = page.evaluate("!window.__MOCK_DB__.production.some(r => r.date==='2026-07-14' && r.item_no===20001)")
    check(gone, 'clearing a cell deletes the entry')
    c = cell(page, 'production|2026-07-14|20001'); c.click(); c.fill('abc'); c.press('Tab'); page.wait_for_timeout(200)
    check(page.locator('.toast.bad').count() > 0, 'bad entry shows an error and is not saved')
    shot(page, '21-production-july')

    # ---- inventory reacts to a delivery ----
    tab(page, 'Daily Inventory')
    before = page.evaluate("1")
    tab(page, 'Goods Receipt')
    c = cell(page, 'goods_receipts|2026-07-20|10001'); c.click(); c.fill('30*100'); c.press('Enter'); page.wait_for_timeout(300)
    stored = page.evaluate("window.__MOCK_DB__.goods_receipts.find(r => r.date==='2026-07-20' && r.item_no===10001)")
    check(stored and stored['qty'] == 3000, 'goods receipt of 30*100 lb cheese saved as 3000')
    tab(page, 'Daily Inventory')
    row = page.locator('tbody tr', has=page.locator('td.sticky-col', has_text='7/20/2026'))
    vals = row.locator('td').all_inner_texts()
    tab(page, 'Goods Receipt')
    c = cell(page, 'goods_receipts|2026-07-20|10001'); c.click(); c.fill(''); c.press('Enter'); page.wait_for_timeout(300)
    tab(page, 'Daily Inventory')
    vals2 = page.locator('tbody tr', has=page.locator('td.sticky-col', has_text='7/20/2026')).locator('td').all_inner_texts()
    a = float(vals[1].replace(',', '')); b = float(vals2[1].replace(',', ''))
    check(abs((a - b) - 3000) < 0.01, f'cheese inventory on 7/20 moves by the 3,000 lb delivery ({a} vs {b})')

    # ---- sales ----
    tab(page, 'Sales')
    n0 = page.evaluate('window.__MOCK_DB__.sales.length')
    page.fill('form.inline-form input[type=date]', '2026-10-26')
    page.fill('form.inline-form input[placeholder="e.g. 14664"]', 'T-1')
    page.select_option('form.inline-form select', 'Original gallon')
    page.fill('form.inline-form input[placeholder=Customer]', 'Test Market')
    page.fill('form.inline-form input[placeholder=Cases]', '10')
    page.wait_for_timeout(100)
    price = page.input_value('form.inline-form input[placeholder="Per case"]')
    amount = page.input_value('form.inline-form input[placeholder="Qty × price"]')
    std = next(p['price'] for p in inputs['standard_prices'] if p['item_no'] == 20003 and p['year'] == 2026)
    check(float(price) == std and abs(float(amount) - 10 * std) < 0.01, f'standard price fills in and amount = qty × price ({price}, {amount})')
    page.click('form.inline-form button[type=submit]'); page.wait_for_timeout(300)
    n1 = page.evaluate('window.__MOCK_DB__.sales.length')
    check(n1 == n0 + 1, 'adding a sale saves it')
    check(page.locator('tbody td', has_text='Test Market').count() == 1, 'new sale appears in the list')
    shot(page, '22-sales-added')
    page.locator('tr', has_text='Test Market').get_by_role('button', name='Delete').click()
    page.get_by_role('button', name='Delete', exact=True).last.click(); page.wait_for_timeout(300)
    check(page.evaluate('window.__MOCK_DB__.sales.length') == n0, 'deleting a sale removes it')

    # ---- admin edits a standard cost and recipe cost follows ----
    tab(page, 'Standard Cost')
    rec = page.locator('tr', has_text='RECIPE: Original').locator('td').nth(5).inner_text()
    orig = cell(page, 'sc|10001|2026').input_value()
    c = cell(page, 'sc|10001|2026'); c.click(); c.fill(str(float(orig) + 1)); c.press('Tab'); page.wait_for_timeout(300)
    rec2 = page.locator('tr', has_text='RECIPE: Original').locator('td').nth(5).inner_text()
    check(rec != rec2, f'recipe cost recalculates when cheese cost changes ({rec} -> {rec2})')
    c = cell(page, 'sc|10001|2026'); c.click(); c.fill(orig); c.press('Tab'); page.wait_for_timeout(300)
    check(page.locator('tr', has_text='RECIPE: Original').locator('td').nth(5).inner_text() == rec, 'restoring cheese cost restores recipe cost')
    check(not errors, 'no browser errors during edits' + (f': {errors[:3]}' if errors else ''))

    # ---- sign out ----
    page.get_by_role('button', name='Sign out').click(); page.wait_for_selector('form input[type=email]')
    check(True, 'sign out returns to sign-in')
    ctx.close()

    # ---- staff view ----
    ctx, page, errors = open_app(browser, role='staff')
    page.route('**/config.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=(
        'window.STANS_CONFIG={supabaseUrl:"https://test.supabase.co",supabaseKey:"k"};'
        f'window.__MOCK_DB__={json.dumps(dict(mock_db(), profiles=[dict(user_id="u1", email="owner@stans.test", role="staff")]))};'
        'window.__MOCK_ROLE__="staff";window.__MOCK_SIGNED_IN__=true;')))
    page.goto(BASE + '/#costs'); page.wait_for_selector('.groups .group')
    check(page.locator('.who a', has_text='Users').count() == 0, 'staff does not see the Users link')
    check(cell(page, 'sc|10001|2026').is_disabled(), 'staff cannot edit standard costs')
    tab(page, 'Production')
    check(not cell(page, 'production|' + page.evaluate("(()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-01'})()") + '|20001').is_disabled(), 'staff can enter production')
    shot(page, '23-staff-production')
    page.goto(BASE + '/#users'); page.wait_for_timeout(200)
    check(page.locator('h1', has_text='Management Dashboard').is_visible(), 'staff going to #users lands on the dashboard')
    check(not errors, 'no browser errors for staff' + (f': {errors[:3]}' if errors else ''))
    ctx.close()

    # ---- phone width ----
    ctx, page, errors = open_app(browser, viewport=(390, 844))
    page.goto(BASE + '/'); page.wait_for_selector('.groups .group'); page.wait_for_timeout(200)
    overflow = page.evaluate('document.documentElement.scrollWidth - window.innerWidth')
    check(overflow <= 0, f'no sideways page scroll on a phone (overflow {overflow}px)')
    shot(page, '24-phone-dashboard')
    tab(page, 'Production'); shot(page, '25-phone-production')
    ctx.close()

    # ---- not configured ----
    ctx = browser.new_context(); page = ctx.new_page()
    page.route('**/config.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body='window.STANS_CONFIG={supabaseUrl:"",supabaseKey:""};'))
    page.route('https://cdn.jsdelivr.net/**', lambda r: r.fulfill(status=200, content_type='text/javascript', body=(ROOT / 'tests/mock-supabase.js').read_text()))
    page.goto(BASE + '/'); page.wait_for_timeout(300)
    check(page.get_by_text('isn’t connected to its database').is_visible(), 'missing Supabase settings shows setup instructions')
    ctx.close()
    browser.close()

server.shutdown()
print(f'\n{len(failures)} failure(s)')
sys.exit(1 if failures else 0)
