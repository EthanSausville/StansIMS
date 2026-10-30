"""Headless-browser test of the site against an in-memory database.

Run:  python3 tests/ui_test.py [screenshot_dir]
Serves ./public locally, swaps the Supabase library for tests/mock-supabase.js,
loads the workbook data from tests/fixtures/workbook.json, then signs in and
exercises every tab.
"""
import json, sys, threading, functools, http.server, socketserver, pathlib, re, datetime
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
sys.path.insert(0, str(ROOT / 'tools'))
from itemnos import renumber
inputs = renumber(json.load(open(ROOT / 'tests/fixtures/workbook.json'))['inputs'])  # six-digit item numbers, as in the database

def mock_db():
    db = {k: v for k, v in inputs.items() if isinstance(v, list)}
    db['production'] = [dict(date=r['date'], item_no=r['item_no'], cases=r['cases']) for r in inputs['production']]
    for t in ('recipes', 'recipe_lines', 'fg_lines'): db.pop(t, None)
    db['boms'] = [dict(item_no=r['item_no'], yield_qty=r['batch_size'], yield_unit='oz', labor_minutes=inputs['settings']['minutes_per_batch']) for r in inputs['recipes']]
    db['boms'] += [dict(item_no=f, yield_qty=1, yield_unit='case') for f in dict.fromkeys(l['fg_item_no'] for l in inputs['fg_lines'])]
    db['bom_lines'] = [dict(parent_item_no=l['recipe_item_no'], item_no=l['item_no'], qty=l['qty'], uses_batch_minutes=l['uses_batch_minutes'], sort=l['sort']) for l in inputs['recipe_lines']]
    db['bom_lines'] += [dict(parent_item_no=l['fg_item_no'], item_no=l['item_no'], qty=l['qty'], uses_batch_minutes=False, sort=l['sort']) for l in inputs['fg_lines']]
    db['bom_lines'] = [dict(l, id=i + 1, year=2026) for i, l in enumerate(db['bom_lines'])]
    db['boms'] = [dict(b, year=2026) for b in db['boms']]
    db['sales'] = [dict({k: v for k, v in r.items() if k != 'row'}, id=i + 1) for i, r in enumerate(inputs['sales'])]
    db['settings'] = [dict(inputs['settings'], id=1)]
    db['sales_imports'] = []
    st = inputs['settings']
    db['labor_positions'] = [
        dict(id=1, year=2026, name='Salaried', pay_type='salaried', headcount=st['salaried_count'], annual_salary=st['salaried_wage'], annual_fixed=None, hourly_rate=None, monthly_fringe=None, payroll_tax_pct=0, paid_hours_week=40, on_line=True, notes=None, sort=1),
        dict(id=2, year=2026, name='Hourly (A)', pay_type='hourly', headcount=st['hourly_a_count'], hourly_rate=st['hourly_a_rate'], monthly_fringe=None, annual_salary=None, annual_fixed=None, payroll_tax_pct=0, paid_hours_week=16, on_line=True, notes=None, sort=2),
        dict(id=3, year=2026, name='Hourly (B)', pay_type='hourly', headcount=st['hourly_b_count'], hourly_rate=st['hourly_b_rate'], monthly_fringe=None, annual_salary=None, annual_fixed=None, payroll_tax_pct=0, paid_hours_week=16, on_line=True, notes=None, sort=3)]
    for y in db['year_settings']:
        if y['year'] == min(r['year'] for r in db['year_settings']): y['labor_line_hours'] = 16
    nm = ROOT / 'tests/fixtures/qb-name-map.json'
    db['qb_name_map'] = json.load(open(nm)) if nm.exists() else []
    RCV = {'Cheese': ('box', 30), 'Mayonnaise': ('drum', 420), 'Pepper': ('bag', 175), 'Pimentos': ('case', 96),
           'Sodium Benzoate': ('bag', 128), 'Brown Sugar': ('bag', 175), 'Hot Sauce': ('case', 64), 'Lemon Juice': ('case', 64),
           'Ground Jalapeños': ('case', 175), '7 oz Container': ('case', 1000), '7 oz Lid': ('case', 1000), '7 oz Case Box': ('case', 500),
           '14 oz Container': ('case', 500), '14 oz Lid': ('case', 1000), '14 oz Case Box': ('case', 500)}
    for it in db['items']:
        if it['name'] in RCV: it['receiving_unit'], it['units_per_receiving'] = RCV[it['name']]
    db['audit_log'] = [dict(id=2, at='2026-10-27T15:04:00Z', user_id='u1', email='owner@stans.test', table_name='standard_costs', action='update',
                            old_row=dict(item_no=100001, year=2026, cost=1.9), new_row=dict(item_no=100001, year=2026, cost=1.937)),
                       dict(id=1, at='2026-10-26T09:00:00Z', user_id='u1', email='owner@stans.test', table_name='items', action='insert',
                            old_row=None, new_row=dict(item_no=300003, name='Marketing', type='Indirect Cost'))]
    db['profiles'] = [dict(user_id='u1', email='owner@stans.test', role='admin', created_at='2026-10-27T12:00:00Z'),
                      dict(user_id='u2', email='staff@stans.test', role='staff', created_at='2026-10-27T12:00:00Z')]
    return db

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
server = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT / 'public')))
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{port}'

# The site pretends today is 7/13/2026 (ui.js PRETEND_TODAY) while the data runs through early July.
TODAY = datetime.date(2026, 7, 13)
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
    'Inventory': ['Production', 'New Receipts', 'All Receipts', 'New Counts', 'All Counts', 'Daily Inventory', 'Consumption'],
    'Planning': ['Production', 'Purchases', 'Safety Stocks'],
    'Sales': ['Sales Detail', 'By Customer', 'By Product', 'Standard Price'],
    'Standards': ['Master List', 'BOMs', 'Labor'],
    'Accounting': ['Journals', 'T-Accounts'],
}
ALL_TABS = [t for ts in GROUPS.values() for t in ts] + ['Users', 'Change history']

def edit_bom(page, name):
    row = page.locator('table.tree-table tr.d0', has=page.locator('.tree-name', has_text=name)).first
    row.click(); page.wait_for_timeout(100)
    page.get_by_role('button', name='Edit BOM').click(); page.wait_for_timeout(150)


def tab(page, label):
    if label in ('Users', 'Change history'):
        page.locator('.gear').click(); page.locator('.gear-menu a', has_text=label).click()
    else:
        group, label = label.split('/') if '/' in label else (next(g for g, ts in GROUPS.items() if label in ts), label)
        page.locator('.groups .group', has_text=group).first.click(); page.wait_for_timeout(80)
        if label != 'Dashboard':
            page.get_by_role('tab', name=label, exact=True).click()
    page.wait_for_timeout(150)

def acct(text):
    """A number from accounting-style text: '$\n1,250.00' or '$ (30.60)'."""
    t = text.replace('$', '').replace(',', '').replace('\n', '').strip()
    if not t: return None
    neg = t.startswith('(') or t.startswith('-')
    try: v = float(t.strip('()-'))
    except ValueError: return text
    return round(-v if neg else v, 2)

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
    check([g.title() for g in groups] == ['Dashboard', 'Accounting', 'Sales', 'Inventory', 'Planning', 'Standards'], 'six sections across the top, in order')
    check(page.locator('.brandrow').count() == 0 or page.locator('.brandrow').is_hidden(), 'no gray bar')
    check(page.locator('.tabs').is_hidden(), 'Dashboard has no second row of tabs')
    page.locator('.groups .group', has_text='Inventory').click(); page.wait_for_timeout(100)
    sub = page.locator('.tabs .tab').all_inner_texts()
    check(sub == GROUPS['Inventory'], f'Inventory group shows its tabs ({sub})')
    page.locator('.groups .group', has_text='Standards').click(); page.wait_for_timeout(100)
    sub = page.locator('.tabs .tab').all_inner_texts()
    check(sub == GROUPS['Standards'], f'Standards group shows its tabs ({sub})')
    page.get_by_role('tab', name='Labor', exact=True).click(); page.wait_for_timeout(80)
    page.locator('.groups .group', has_text='Dashboard').click(); page.wait_for_timeout(80)
    page.locator('.groups .group', has_text='Standards').click(); page.wait_for_timeout(100)
    check(page.get_by_role('tab', name='Labor', exact=True).get_attribute('aria-selected') == 'true', 'returning to a group reopens the last tab used there')
    check(page.locator('.page-intro', has_text='standard labor cost per minute').is_visible() and page.locator('.tb-info').count() == 0, 'how to use the page is shown above it, with no (i) button')
    page.locator('.groups .group', has_text='Accounting').click(); page.wait_for_timeout(100)
    sub = page.locator('.tabs .tab').all_inner_texts()
    check(sub == GROUPS['Accounting'], f'Accounting group shows Journals and T-Accounts ({sub})')
    page.locator('.gear').click(); page.wait_for_timeout(80)
    check(page.locator('.gear-menu a', has_text='Users').is_visible(), 'admin sees Users in the gear menu')
    page.keyboard.press('Escape')
    tabs = ALL_TABS

    # ---- every tab renders without errors ----
    for i, label in enumerate(tabs):
        tab(page, label)
        bad = page.locator('.note.bad', has_text='Something went wrong').count()
        check(bad == 0, f'tab renders: {label}')
        shot(page, f'{i + 1:02d}-{re.sub(r"[^a-z]+", "-", label.lower())}')
    # Scrolling: no area inside the page scrolls up and down on its own.
    js_vert = """[...document.querySelectorAll('main *')].filter(e => { if (e.closest('.side-inner') || e.matches('.layout > .content')) return false; const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1; }).length"""
    for label in ALL_TABS:
        tab(page, label)
        n = page.evaluate(js_vert)
        if n: check(False, f'{label}: {n} area(s) scroll up and down inside the page')
    check(True, 'only the page scrolls up and down, on every tab')
    tab(page, 'Sales Detail')
    side_w = page.evaluate("Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)")
    check(side_w == 250, f'the side bar starts 250px wide ({side_w}px)')
    page.locator('.side-fold').click(); page.wait_for_timeout(200)
    side_w = page.evaluate("Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)")
    check(side_w == 10, f'the side bar folds to a 10px strip ({side_w}px)')
    wraps = page.evaluate("[...document.querySelectorAll('main .tablewrap')].map(w => w.classList.contains('fits'))")
    check(wraps and all(wraps), f'the Sales Detail table fits the screen, so it has no sideways scrollbar ({wraps})')
    page.evaluate("document.querySelector('#app .layout > .content').scrollTop = 1500"); page.wait_for_timeout(150)
    top = page.evaluate("Math.round(document.querySelector('main .tablewrap thead th').getBoundingClientRect().top)")
    bar = page.evaluate("Math.round(document.querySelector('.topbar').getBoundingClientRect().height)")
    check(abs(top - bar) <= 1, f'Sales Detail column headings stay pinned under the site header ({top} vs {bar})')
    shot(page, '32-sales-scrolled')
    page.evaluate("document.querySelector('#app .layout > .content').scrollTop = 0")
    page.locator('.side-fold').click(); page.wait_for_timeout(200)
    g = page.locator('.side-grip').bounding_box()
    page.mouse.move(g['x'] + 4, g['y'] + 200); page.mouse.down(); page.mouse.move(g['x'] + 104, g['y'] + 200, steps=4); page.mouse.up(); page.wait_for_timeout(150)
    side_w = page.evaluate("Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)")
    check(abs(side_w - 350) <= 3, f'dragging the edge resizes the side bar ({side_w}px)')
    edge = page.evaluate("[Math.round(document.querySelector('.sidebar').getBoundingClientRect().right), Math.round(document.querySelector('main .tablewrap').getBoundingClientRect().left)]")
    check(edge[1] >= edge[0], f'the table and its scrolling sit to the right of the side bar ({edge})')
    page.evaluate("localStorage.removeItem('side:w250')")
    tab(page, 'Production')
    side = page.evaluate("[...document.querySelectorAll('main .tablewrap')].map(w => w.scrollWidth > w.clientWidth)")
    tab(page, 'Daily Inventory')
    page.evaluate("document.querySelector('#app .layout > .content').scrollTop = 700"); page.wait_for_timeout(200)
    fh = page.evaluate("(() => { const f = document.querySelector('.float-head'); if (!f) return null; const r = f.getBoundingClientRect(); return [Math.round(r.top), f.textContent.includes('Cheese')]; })()")
    check(fh is not None and abs(fh[0] - bar) <= 1 and fh[1], f'wide tables keep their column names under the site header too ({fh})')
    page.evaluate("document.querySelector('main .tablewrap').scrollLeft = 300"); page.wait_for_timeout(150)
    off = page.evaluate("(() => { const w = document.querySelector('main .tablewrap'); const real = w.querySelector('thead tr:nth-child(2) th:nth-child(5)').getBoundingClientRect().left; const copy = document.querySelector('.float-head thead tr:nth-child(2) th:nth-child(5)').getBoundingClientRect().left; return Math.round(real - copy); })()")
    check(abs(off) <= 1, f'the floating header lines up with the columns after scrolling sideways (off by {off}px)')
    page.evaluate("document.querySelector('#app .layout > .content').scrollTop = 0"); page.wait_for_timeout(150)
    dock = page.evaluate("(() => { const f = document.querySelector('.float-foot .ff-scroll'); if (!f) return null; return Math.round(innerHeight - f.getBoundingClientRect().bottom); })()")
    check(dock is not None and 0 <= dock <= 4, f'wide tables have their sideways scrollbar docked at the bottom of the screen ({dock})')
    st = page.evaluate("(() => { const w = document.querySelector('main .tablewrap'); const c = w.querySelector('tbody tr .sticky-col'); return [Math.round(document.querySelector('.float-foot .ff-scroll').getBoundingClientRect().left), Math.round(c.getBoundingClientRect().right)]; })()")
    check(st[0] >= st[1], f'the sideways scrollbar starts after the column that stays put ({st})')
    pg_sc = page.evaluate("[document.documentElement.scrollHeight - innerHeight, Math.round(document.querySelector('#app .layout > .content').getBoundingClientRect().top - document.querySelector('.topbar').getBoundingClientRect().bottom)]")
    check(pg_sc[0] <= 0 and pg_sc[1] == 0, f'only the page area scrolls, so its scrollbar starts under the header ({pg_sc})')
    page.evaluate("document.querySelector('main .tablewrap').scrollLeft = 0"); page.wait_for_timeout(150)
    t = page.locator('.float-foot .ff-thumb').bounding_box()
    page.mouse.move(t['x'] + 10, t['y'] + 5); page.mouse.down(); page.mouse.move(t['x'] + 210, t['y'] + 5, steps=5); page.mouse.up(); page.wait_for_timeout(150)
    sl = page.evaluate("document.querySelector('main .tablewrap').scrollLeft")
    t2 = page.locator('.float-foot .ff-thumb').bounding_box()
    check(sl > 200 and abs(t2['x'] - t['x'] - 200) <= 2, f'dragging the docked scrollbar scrolls the table sideways (table at {sl}px, thumb moved {t2["x"] - t["x"]:.0f}px)')
    shot(page, '36-wide-table-docked-scrollbar')
    page.evaluate("document.querySelector('#app .layout > .content').scrollTop = 0")

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
    back = (TODAY.year - 2026) * 12 + TODAY.month - 7
    for _ in range(back): page.get_by_role('button', name='Previous month').click(); page.wait_for_timeout(60)
    page.wait_for_timeout(150)
    check(page.locator('.monthpick .label').inner_text() == 'Jul 2026', 'month picker goes back to July 2026')
    c = cell(page, 'production|2026-07-14|500001')
    c.click(); c.fill('24*10'); c.press('Enter'); page.wait_for_timeout(300)
    stored = page.evaluate("window.__MOCK_DB__.production.find(r => r.date==='2026-07-14' && r.item_no===500001)")
    check(stored and stored['cases'] == 240, 'typing 24*10 saves 240 cases')
    oz = page.locator('tr:has(input[data-k="production|2026-07-14|500001"]) td.calc').nth(2).inner_text()
    check(oz == '40,320', f'oz recalculates to 40,320 (got {oz})')
    focused = page.evaluate('document.activeElement.dataset.k')
    check(focused == 'production|2026-07-15|500001', f'Enter moves to the next day (focus on {focused})')
    c = cell(page, 'production|2026-07-14|500001'); c.click(); c.fill(''); c.press('Tab'); page.wait_for_timeout(300)
    gone = page.evaluate("!window.__MOCK_DB__.production.some(r => r.date==='2026-07-14' && r.item_no===500001)")
    check(gone, 'clearing a cell deletes the entry')
    c = cell(page, 'production|2026-07-14|500001'); c.click(); c.fill('abc'); c.press('Tab'); page.wait_for_timeout(200)
    check(page.locator('.toast.bad').count() > 0, 'bad entry shows an error and is not saved')
    shot(page, '21-production-july')

    # ---- inventory reacts to a delivery ----
    tab(page, 'Daily Inventory')
    before = page.evaluate("1")
    tab(page, 'New Receipts')
    # ---- New Receipts (the simple way) ----
    check(page.locator('form.delivery').count() == 1 and page.locator('table.t').count() == 0, 'New Receipts is just the delivery form')
    lid_no = next(i['item_no'] for i in inputs['items'] if i['name'] == '7 oz Lid')
    rcpt = lambda no: sum(float(r['qty']) for r in page.evaluate("window.__MOCK_DB__.goods_receipts") if r['item_no'] == no and r['date'] == TODAY.isoformat())
    b_cheese, b_lid = rcpt(100001), rcpt(lid_no)
    check(page.locator('.dl-row', has_text='Cheese').locator('.dl-unit').inner_text() == 'boxes', 'cheese is entered in boxes')
    page.locator('input[data-k="dl|100001"]').fill('12'); page.wait_for_timeout(50)
    check(page.locator('.dl-row', has_text='Cheese').locator('.dl-conv').inner_text() == '= 360 lb', 'typing 12 boxes shows = 360 lb')
    page.locator(f'input[data-k="dl|{lid_no}"]').fill('2'); page.wait_for_timeout(50)
    page.locator('input[data-k="dl|100002"]').fill('abc'); page.wait_for_timeout(50)
    check(page.locator('.dl-bar button').is_disabled() and 'Fix the number' in page.locator('.dl-summary').inner_text(), 'a non-number blocks saving with a plain message')
    page.locator('input[data-k="dl|100002"]').fill(''); page.wait_for_timeout(50)
    shot(page, '58-enter-delivery')
    page.get_by_role('button', name='Save delivery').click(); page.wait_for_timeout(400)
    check(rcpt(100001) - b_cheese == 360 and rcpt(lid_no) - b_lid == 2000, f'saving turns 12 boxes into 360 lb and 2 cases of lids into 2,000 ({rcpt(100001) - b_cheese}, {rcpt(lid_no) - b_lid})')
    check(page.locator('.dl-saved', has_text='12 boxes of Cheese').count() == 1 and page.locator('input[data-k="dl|100001"]').input_value() == '', 'a confirmation lists what was saved and the boxes clear')
    shot(page, '59-delivery-saved')
    page.get_by_role('button', name='Undo this delivery').click(); page.wait_for_timeout(400)
    check(rcpt(100001) == b_cheese and rcpt(lid_no) == b_lid, 'Undo takes the delivery back out')
    tab(page, 'All Receipts')
    c = cell(page, 'goods_receipts|2026-07-20|100001'); c.click(); c.fill('30*100'); c.press('Enter'); page.wait_for_timeout(300)
    stored = page.evaluate("window.__MOCK_DB__.goods_receipts.find(r => r.date==='2026-07-20' && r.item_no===100001)")
    check(stored and stored['qty'] == 3000, 'goods receipt of 30*100 lb cheese saved as 3000')
    tab(page, 'Daily Inventory')
    row = page.locator('tbody tr', has=page.locator('td.sticky-col', has_text='7/20/2026'))
    vals = row.locator('td').all_inner_texts()
    tab(page, 'All Receipts')
    c = cell(page, 'goods_receipts|2026-07-20|100001'); c.click(); c.fill(''); c.press('Enter'); page.wait_for_timeout(300)
    tab(page, 'Daily Inventory')
    vals2 = page.locator('tbody tr', has=page.locator('td.sticky-col', has_text='7/20/2026')).locator('td').all_inner_texts()
    a = float(vals[1].replace(',', '')); b = float(vals2[1].replace(',', ''))
    check(abs((a - b) - 3000) < 0.01, f'cheese inventory on 7/20 moves by the 3,000 lb delivery ({a} vs {b})')

    # ---- sales ----
    tab(page, 'Sales Detail')
    page.get_by_role('button', name='Add sale').click(); page.wait_for_timeout(120)
    check(page.locator('.sidebar form.sale-form').count() == 1 and page.locator('dialog[open]').count() == 0, 'Add sale opens a form in the side bar')
    n0 = page.evaluate('window.__MOCK_DB__.sales.length')
    F = '.sidebar form.sale-form'
    page.fill(f'{F} input[type=date]', '2026-10-26')
    page.fill(f'{F} input[placeholder="e.g. 14664"]', 'T-1')
    page.select_option(f'{F} select', 'Original gallon')
    page.fill(f'{F} input[placeholder=Customer]', 'Test Market')
    page.fill(f'{F} input[placeholder=Cases]', '10')
    page.wait_for_timeout(100)
    price = page.input_value(f'{F} input[placeholder="Per case"]')
    amount = page.input_value(f'{F} input[placeholder="Qty × price"]')
    std = next(p['price'] for p in inputs['standard_prices'] if p['item_no'] == 500003 and p['year'] == 2026)
    check(float(price) == std and abs(float(amount) - 10 * std) < 0.01, f'standard price fills in and amount = qty × price ({price}, {amount})')
    page.click(f'{F} button[type=submit]'); page.wait_for_timeout(300)
    n1 = page.evaluate('window.__MOCK_DB__.sales.length')
    check(n1 == n0 + 1 and page.locator(F).count() == 0, 'adding a sale saves it and closes the form')
    check(page.locator('tbody td', has_text='Test Market').count() == 1, 'new sale appears in the list')
    check(page.locator('tr.selected', has_text='Test Market').count() == 1, 'the new sale is selected')
    shot(page, '22-sales-added')
    page.get_by_role('button', name='Edit sale').click(); page.wait_for_timeout(120)
    page.fill(f'{F} input[placeholder=Customer]', 'Test Market 2'); page.locator(F).get_by_role('button', name='Save').click(); page.wait_for_timeout(300)
    check(page.locator('tbody td', has_text='Test Market 2').count() == 1, 'Edit sale changes the line')
    page.get_by_role('button', name='Edit sale').click(); page.wait_for_timeout(120)
    page.locator(F).get_by_role('button', name='Delete').click()
    page.locator('dialog[open]').get_by_role('button', name='Delete', exact=True).click(); page.wait_for_timeout(300)
    check(page.evaluate('window.__MOCK_DB__.sales.length') == n0, 'deleting a sale removes it')
    check(page.locator('table.xtable .row-actions').count() == 0, 'no edit / delete buttons on the rows')
    amt = page.locator('table.xtable tbody tr').first.locator('td').nth(4)
    check(amt.locator('.cur').count() == 1, 'amounts show the $ at the far left')

    # ---- Sales Detail filters and sorts like an Excel table; totals at the top ----
    if not page.evaluate("document.querySelector('.sidebar').classList.contains('folded')"): page.locator('.side-fold').click(); page.wait_for_timeout(200)
    money = lambda v: round(v, 2)
    latest = max(int(s['date'][:4]) for s in inputs['sales'])
    yr = [s for s in inputs['sales'] if s['date'].startswith(str(latest))]
    page.evaluate("document.querySelector('#app .layout > .content').scrollTop = 400"); page.wait_for_timeout(150)
    gap = page.evaluate("Math.round(innerHeight - document.querySelector('main table.xtable tfoot tr.xt-totals td:nth-child(3)').getBoundingClientRect().bottom)")
    check(abs(gap) <= 1, f'the totals row is pinned to the bottom of the screen ({gap}px from the bottom)')
    shot(page, '35-sales-totals-bottom')
    page.evaluate("document.querySelector('#app .layout > .content').scrollTop = 0")
    tot = lambda: [x.split('\n')[0] if i == 0 else acct(x) for i, x in enumerate(page.locator('tfoot tr.xt-totals td').all_inner_texts())]
    t = tot()
    check(t[0] == (f'{len(yr):,} lines' if len(yr) == len(inputs['sales']) else f'{len(yr):,} of {len(inputs["sales"]):,}') and t[4] == money(sum(s['amount'] or 0 for s in yr)),
          f'it opens on {latest} and the totals add up that year ({t[0]}, {t[4]})')
    cust = sorted({s['customer'] for s in yr if s['customer']})[0]
    page.get_by_role('button', name='Filter and sort Customer').click(); page.wait_for_timeout(80)
    menu = page.locator('.xf-menu')
    menu.get_by_text('(Select all)').click()
    menu.locator('label.xf-item', has=page.locator('.xf-val', has_text=re.compile('^' + re.escape(cust) + '$'))).locator('input').check()
    shot(page, '33-sales-filter-menu')
    menu.get_by_role('button', name='OK').click(); page.wait_for_timeout(150)
    shown = set(page.locator('main table.xtable tbody td:nth-child(6)').all_inner_texts())
    mine = [s for s in yr if s['customer'] == cust]
    t = tot()
    check(shown == {cust} and t[0].startswith(f'{len(mine):,} of') and t[4] == money(sum(s['amount'] or 0 for s in mine)),
          f'filtering Customer to {cust} shows only those lines, and the totals follow ({t[0]}, {t[4]})')
    check(page.get_by_role('button', name='Filter and sort Customer (filtered)').count() == 1, 'the filtered column’s button is highlighted')
    page.get_by_role('button', name='Filter and sort Amount').click(); page.wait_for_timeout(80)
    page.locator('.xf-menu').get_by_role('button', name='Sort largest to smallest').click(); page.wait_for_timeout(150)
    amts = [acct(x) for x in page.locator('main table.xtable tbody td:nth-child(5)').all_inner_texts()]
    check(amts == sorted(amts, reverse=True), 'Amount sorts largest to smallest')
    shot(page, '34-sales-filtered')
    page.locator('.side-fold').click(); page.wait_for_timeout(150)
    page.get_by_role('button', name=re.compile('^Clear filters')).click(); page.wait_for_timeout(150)
    check(tot()[0] == f'{len(inputs["sales"]):,} lines', 'Clear filters shows every line')
    page.locator('main tr.xt-totals').get_by_role('button', name='Hide').click(); page.wait_for_timeout(120)
    check(page.locator('main tr.xt-totals').count() == 0 and page.locator('main').get_by_role('button', name='Show totals').count() == 1, 'the totals row can be hidden, leaving a Show totals tab')
    check(page.evaluate("localStorage.getItem('xt-totals:sales-detail')") == 'off', 'turning totals off is remembered')
    page.locator('main').get_by_role('button', name='Show totals').click(); page.wait_for_timeout(120)
    check(page.locator('main tr.xt-totals').count() == 1, 'and shown again')

    # ---- labor rate: every year set up on its own; all paid time in the rate ----
    st = inputs['settings']
    def want(line_hours=16, sal_fixed=0, a_fringe=0, salary=None, a_rate_f=1):
        # everyone on the line whenever it runs; hourly paid for those hours, salaried their salary
        salary = st['salaried_wage'] if salary is None else salary
        heads = st['salaried_count'] + st['hourly_a_count'] + st['hourly_b_count']
        ha = st['hourly_a_count'] * line_hours * 52; hb = st['hourly_b_count'] * line_hours * 52
        cost = st['salaried_count'] * (salary + sal_fixed) + (ha * st['hourly_a_rate'] + hb * st['hourly_b_rate']) * a_rate_f + st['hourly_a_count'] * a_fringe * 12
        return cost / (heads * line_hours * 52 * 60)
    rate_now = lambda: float(page.locator('.labor-cards .stat.key .value').inner_text().strip('$'))
    tab(page, 'Labor')
    side_w = page.evaluate("Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)")
    check(abs(side_w - 504) <= 3, f'the Labor side bar takes 35% of the width ({side_w}px)')
    ok = page.evaluate("(() => { const box = document.querySelector('.side-inner'); const t = document.querySelector('.sidebar table.side-people'); return !!t && t.scrollWidth <= box.clientWidth && [...t.querySelectorAll('td, th')].every(c => { const r = c.getBoundingClientRect(); return [...c.querySelectorAll('*:not(option)')].every(e => e.getBoundingClientRect().right <= r.right + 1); }); })()")
    check(ok, 'the year’s people fit the left side bar without wrapping or scrolling')
    check(page.locator('main .content table.side-years').count() == 1 and page.locator('.sidebar table.side-years').count() == 0, 'the years table is on the right, like the other tabs')
    check(page.locator('.sidebar .year-head h1').inner_text().startswith('2026'), 'the left side has a header with the year')
    check(page.locator('.sidebar .side-fold').is_visible(), 'the left side bar folds, like the other tabs')
    check(page.locator('.labor-cards').inner_text().count('Production hours a week') == 0, 'production hours are not in the summary cards')
    heads = page.locator('table.side-people thead th').all_inner_texts()
    check(heads[:4] == ['Position', 'Pay', 'Fringe', '#'], f'people columns: Position, Pay, Fringe, # ({heads})')
    check(page.evaluate("getComputedStyle(document.querySelector('table.side-people .pos-input')).textAlign") in ('left', 'start'), 'position names are left aligned')
    pay = page.locator('input[data-k="lp|1|annual_salary"]').input_value()
    check(pay == '$' + '{:,.0f}'.format(st['salaried_wage']), f'pay shows with $ and commas ({pay})')
    check(page.locator('table.side-people input[data-k$="paid_hours_week"]').count() == 0, 'no hours-per-week column')
    yrs = [t[:4] for t in page.locator('table.side-years tbody tr td:first-child').all_inner_texts()]
    import datetime
    check(yrs == [str(y) for y in range(2026, TODAY.year + 2)], f'years run from 2026 to next year ({yrs})')
    shot(page, '37-labor')
    check(abs(rate_now() - want()) < 1e-4, f'all paid time is in the labor rate: the 2-day rate matches the workbook ({rate_now()} vs {want():.4f})')
    check(page.get_by_label('Paid time off the line goes to').count() == 0, 'there is no option to leave paid time out')
    c = cell(page, 'lp|1|annual_fixed'); c.click(); c.fill('20000'); c.press('Tab'); page.wait_for_timeout(250)
    c = cell(page, 'lp|2|monthly_fringe'); c.click(); c.fill('450'); c.press('Tab'); page.wait_for_timeout(250)
    check(abs(rate_now() - want(sal_fixed=20000, a_fringe=450)) < 1e-4, f'annual fixed cost (salaried) and monthly fringe (hourly) are added ({rate_now()})')
    check(page.locator('text=Line efficiency').count() == 0, 'there is no line efficiency setting (100% assumed)')
    c = cell(page, 'ly|2026|labor_line_hours'); c.click(); c.fill('24'); c.press('Tab'); page.wait_for_timeout(250)
    check(abs(rate_now() - want(24, sal_fixed=20000, a_fringe=450)) < 1e-4, f'running the line 24 hours a week puts everyone on it longer ({rate_now()})')
    check(page.evaluate("window.__MOCK_DB__.year_settings.find(y => y.year === 2026).labor_line_hours") == 24, 'production hours a week are saved for the year')
    c = cell(page, 'ly|2026|labor_line_hours'); c.click(); c.fill('16'); c.press('Tab'); page.wait_for_timeout(250)
    check(page.locator('table.recipes-labor').count() == 0, 'labor per recipe is not on the Labor tab')
    rate26 = rate_now()
    tab(page, 'BOMs')
    edit_bom(page, 'RECIPE: Original')
    lab = page.locator('.cb-labor')
    lpr = lab.locator('.stat', has_text='Labor per run').locator('.value').inner_text()
    check(abs(float(lpr.replace('$', '').replace(',', '')) - rate26 * st['minutes_per_batch']) < 0.01, f'the recipe BOM shows its labor: rate x its labor minutes ({lpr})')
    shot(page, '41-recipe-bom-labor')
    page.fill('#cb-minutes', '60'); page.locator('#cb-minutes').press('Tab'); page.wait_for_timeout(150)
    lpr = lab.locator('.stat', has_text='Labor per run').locator('.value').inner_text()
    check(abs(float(lpr.replace('$', '').replace(',', '')) - rate26 * 60) < 0.01, f'changing the BOM’s labor minutes updates its labor ({lpr})')
    page.locator('.bom-editor').get_by_role('button', name='Cancel').click(); page.wait_for_timeout(100)
    check(page.locator('dialog[open]', has_text='Close without saving').count() == 1, 'Cancel with changes asks first')
    page.locator('dialog[open]').get_by_role('button', name='Discard changes').click(); page.wait_for_timeout(150)
    check(page.locator('.bom-editor').count() == 0, 'Cancel closes the editor')
    check(page.evaluate("window.__MOCK_DB__.boms.find(b => b.item_no === 400001).labor_minutes") != 60, 'Cancel does not save')
    tab(page, 'Labor')
    hrs = page.locator('table.whatif tbody tr td:first-child').all_inner_texts()
    check(hrs[0].startswith('16') and hrs[-1].startswith('120') and page.locator('table.whatif tr.current').count() == 1, f'what-if runs up to 120 production hours a week ({hrs})')
    w = page.locator('table.whatif tbody tr').last.locator('td').nth(1).inner_text()
    check(abs(float(w.strip('$')) - want(120, 20000, 450)) < 1e-4, f'what-if: at 120 hours the same people cost less per minute ({w})')
    page.get_by_role('button', name='Details for Hourly (A)').click(); page.wait_for_timeout(150)
    dlg = page.locator('.sidebar form.group-panel')
    check(page.locator('dialog[open]').count() == 0 and dlg.count() == 1, 'position details open in the side bar, not a popup')
    dlg.get_by_label('Notes').fill('Line crew'); page.wait_for_timeout(100)
    shot(page, '38-position-details')
    dlg.get_by_role('button', name='Save').click(); page.wait_for_timeout(300)
    check(page.evaluate("window.__MOCK_DB__.labor_positions.find(p => p.id === 2).notes") == 'Line crew' and page.locator('.sidebar form.group-panel').count() == 0, 'details save notes and close')
    # next year: a forecast from this year + inflation until it has its own people
    nxt = TODAY.year + 1
    this_rate = rate_now()
    check('forecast' in page.locator('table.side-years tbody tr').last.inner_text(), f'{nxt} is marked as a forecast')
    page.get_by_role('button', name=f'Show {nxt}').click(); page.wait_for_timeout(200)
    check(abs(rate_now() - this_rate) < 1e-4, f'{nxt} starts from {nxt - 1}’s people ({rate_now()})')
    check(page.locator('table.side-years tbody tr').last.locator('td').nth(3).inner_text() == '100%', 'an unchanged forecast shows 100% of last year')
    c = cell(page, f'ly|{nxt}|labor_inflation_pct'); c.click(); c.fill('3'); c.press('Tab'); page.wait_for_timeout(250)
    check(abs(rate_now() - this_rate * 1.03) < 1e-4, f'a 3% inflation adjustment raises the {nxt} forecast 3% ({rate_now()})')
    vs_prior = page.locator('table.side-years tbody tr').last.locator('td').nth(3).inner_text()
    check(vs_prior == '103%', f'vs. prior shows the forecast as a share of last year ({vs_prior})')
    st_fc = page.evaluate("(() => { const c = getComputedStyle(document.querySelector('.labor-cards .stat .value')); return [c.fontStyle, c.fontWeight, c.color]; })()")
    check(st_fc[0] == 'italic' and int(st_fc[1]) >= 700 and st_fc[2] == 'rgb(107, 63, 196)', f'forecast numbers are bold purple italics ({st_fc})')
    check(page.locator('table.side-people.is-forecast').count() == 1 and page.locator('table.side-people input[data-k*="headcount"]').first.is_disabled(), 'forecast people are shown read-only')
    shot(page, '39-labor-forecast')
    tab(page, 'Master List')
    col = 5 + (nxt - 2026)
    lab_next = float(page.locator('tr', has_text='Direct Labor').locator('td').nth(col).get_attribute('data-v'))
    check(abs(lab_next - this_rate * 1.03) < 1e-4, f'Standard Cost uses the {nxt} forecast rate ({lab_next})')
    tab(page, 'Labor')
    page.locator('.people-panel').get_by_role('button', name=f'Give {nxt} its own people').click(); page.wait_for_timeout(400)
    rows_next = page.evaluate(f"window.__MOCK_DB__.labor_positions.filter(p => p.year === {nxt})")
    sal_next = next(p for p in rows_next if p['pay_type'] == 'salaried')
    check(len(rows_next) == 3 and abs(sal_next['annual_salary'] - st['salaried_wage'] * 1.03) < 0.01, f'giving {nxt} its own people copies the forecast, inflation included ({sal_next["annual_salary"]})')
    sid = sal_next['id']
    c = cell(page, f'lp|{sid}|annual_salary'); c.click(); c.fill('84000'); c.press('Tab'); page.wait_for_timeout(300)
    r_next = rate_now()
    check(abs(r_next - want(sal_fixed=20000 * 1.03, a_fringe=450 * 1.03, salary=84000, a_rate_f=1.03)) < 1e-4, f'{nxt} has its own pay ({r_next})')
    hid = next(p for p in rows_next if p['name'] == 'Hourly (B)')['id']
    c = cell(page, f'lp|{hid}|name'); c.click(); c.fill('Line lead'); c.press('Tab'); page.wait_for_timeout(250)
    page.get_by_label('How Line lead is paid').select_option('salaried'); page.wait_for_timeout(250)
    pb = page.evaluate(f"window.__MOCK_DB__.labor_positions.find(p => p.id === {hid})")
    check(pb['name'] == 'Line lead' and pb['pay_type'] == 'salaried', f'a position can be renamed and switched to salaried in place ({pb["name"]}, {pb["pay_type"]})')
    page.get_by_label('How Line lead is paid').select_option('hourly'); page.wait_for_timeout(250)
    tab(page, 'Master List')
    lab_this = float(page.locator('tr', has_text='Direct Labor').locator('td').nth(5).get_attribute('data-v'))
    lab_next = float(page.locator('tr', has_text='Direct Labor').locator('td').nth(col).get_attribute('data-v'))
    check(abs(lab_next - r_next) < 1e-4 and abs(lab_this - this_rate) < 1e-4, f'Standard Cost uses each year’s own labor rate ({lab_this}, {lab_next})')
    tab(page, 'Labor')
    page.get_by_role('button', name='Show 2026').click(); page.wait_for_timeout(200)
    # Put the workbook's numbers back for the BOM checks below.
    for k, v in [('lp|1|annual_fixed', ''), ('lp|2|monthly_fringe', '')]:
        c = cell(page, k); c.click(); c.fill(v); c.press('Tab'); page.wait_for_timeout(150)
    check(abs(rate_now() - want()) < 1e-4, 'back to the workbook rate')

    # ---- admin edits a standard cost and recipe cost follows ----
    tab(page, 'Master List')
    rec = page.locator('tr', has_text='RECIPE: Original').locator('td').nth(5).get_attribute('data-v')
    orig = cell(page, 'sc|100001|2026').input_value()
    check(orig.startswith('$') is False and cell(page, 'sc|100001|2026').evaluate("e => getComputedStyle(e.closest('td'), '::before').content") == '"$"', f'entered costs show a $ at the left of the cell ({orig})')
    cells = page.locator('tr', has_text='RECIPE: Original').locator('td').nth(5)
    check(cells.locator('.cur').inner_text() == '$' and cells.inner_text().replace('$', '').strip() == '0.13', f'calculated costs: $ at the left, to the penny or two significant digits ({cells.inner_text()!r})')
    ls = page.locator('tr', has_text='Sodium Benzoate').locator('td').nth(5).locator('input')
    check(ls.input_value() in ('0.14',), f'entered costs show to the penny ({ls.input_value()})')
    check(page.locator('th', has_text='Latest cost').count() == 0, 'no Latest cost column')
    ch = page.locator('tr', has_text='Cheese').first.locator('td'); cb = page.locator('tr', has_text='7 oz Case Box').first.locator('td')
    check([ch.nth(4).locator('input').input_value(), cb.nth(4).locator('input').input_value()] == ['30 lb box', '500 ea case'], 'Master List shows each item’s Receipt')
    want_years = [str(y) for y in range(2026, TODAY.year + 2)]
    heads = [t.split('\n')[0].strip(' ▾') for t in page.locator('table.xtable thead th').all_inner_texts() if t[:2] == '20']
    check(heads == want_years, f'Master List shows 2026 through next year ({heads})')
    check(page.locator('table.xtable tbody tr button', has_text='Edit').count() == 0, 'no Edit buttons on the Master List rows')
    check(page.get_by_role('button', name='Edit item').count() == 0, 'no Edit item button until an item is selected')
    page.locator('table.xtable tbody tr', has_text='Pepper').locator('td').first.click(); page.wait_for_timeout(100)
    check(page.locator('table.xtable tbody tr.selected').count() == 1 and 'Pepper' in page.locator('table.xtable tbody tr.selected').inner_text(), 'clicking an item selects it')
    cls = page.get_by_role('button', name='Edit item').get_attribute('class'); cls2 = page.get_by_role('button', name='Add item').get_attribute('class')
    check(cls == cls2 and page.locator('.item-selected').count() == 0, f'Edit item looks like Add item, with nothing else ({cls})')
    bgs = page.evaluate("""(() => { const r = [...document.querySelectorAll('table.xtable tbody tr')]; const sel = r.find(t => t.classList.contains('selected')); const other = r.find(t => !t.classList.contains('selected') && t.textContent.includes('Cheese'));
      const bg = (e) => getComputedStyle(e).backgroundColor; const rec = r.find(t => t.textContent.includes('RECIPE: Original'));
      return [bg(sel.querySelector('td')), bg(other.querySelector('td.cell')), bg(other.querySelector('td.cell input')), bg(rec.querySelectorAll('td')[5])]; })()""")
    check(bgs[0] != 'rgb(255, 244, 194)' and 'rgb(2' in bgs[0] and bgs[1] == 'rgb(255, 255, 255)' and bgs[3] in ('rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)') and bgs[2] in ('rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)'), f'selected row is blue; typed-in and calculated cells are white ({bgs})')
    page.get_by_role('button', name='Edit item').click(); page.wait_for_timeout(150)
    check(page.locator('dialog[open]').count() == 0 and page.locator('.sidebar .item-form .tb-title').inner_text() == 'Edit Pepper', 'Edit item opens a form in the side bar, not a popup')
    w = page.locator('.sidebar').evaluate("e => Math.round(e.getBoundingClientRect().width)")
    check(w == 300, f'the side bar widens for the form ({w}px)')
    shot(page, '12-item-form')
    page.locator('.item-form').get_by_role('button', name='Cancel').click(); page.wait_for_timeout(100); shot(page, '12b-selected'); page.get_by_role('button', name='Edit item').click(); page.wait_for_timeout(100)
    page.fill('#item-receipt', '88 cups bags'); page.wait_for_timeout(50)
    page.fill('#item-pack', '1 c'); page.locator('.item-form').get_by_role('button', name='Save').click(); page.wait_for_timeout(250)
    pep = page.evaluate("window.__MOCK_DB__.items.find(i => i.name === 'Pepper')")
    check(pep['pack_note'] == '1 c' and pep['receiving_unit'] == 'bag' and pep['units_per_receiving'] == 88 and page.locator('.item-form').count() == 0, 'saving the item saves its receiving unit and closes the form')
    check(page.locator('.sidebar').evaluate("e => Math.round(e.getBoundingClientRect().width)") == 170, 'the side bar goes back to narrow')
    page.get_by_role('button', name='Add item').click(); page.wait_for_timeout(150)
    page.select_option('#item-type', 'Indirect Cost'); page.wait_for_timeout(50)
    check(page.locator('#item-no').input_value() == '300003', f'Add item suggests the next indirect number ({page.locator("#item-no").input_value()})')
    page.fill('#item-name', 'Marketing'); page.fill('#item-unit', 'case')
    page.locator('.item-form').get_by_role('button', name='Add').click(); page.wait_for_timeout(250)
    mk = page.evaluate("window.__MOCK_DB__.items.find(i => i.name === 'Marketing')")
    check(mk and mk['item_no'] == 300003 and mk['type'] == 'Indirect Cost', 'Add item saves the new item')
    check(page.locator('table.xtable tbody tr', has_text='Marketing').locator('input').count() >= 1, 'an indirect cost like Marketing has its cost typed in')
    edit_btn = page.get_by_role('button', name='Edit item'); edit_btn.click(); page.wait_for_timeout(150)
    page.locator('.item-form').get_by_role('button', name='Delete item').click(); page.wait_for_timeout(100)
    page.locator('dialog[open]').get_by_role('button', name='Delete').click(); page.wait_for_timeout(250)
    check(page.evaluate("window.__MOCK_DB__.items.some(i => i.name === 'Marketing')") is False, 'an unused item can be deleted')
    tw = page.evaluate("(() => { const ths = [...document.querySelectorAll('main table.xtable thead th')]; const y = ths.find(t => t.textContent.trim().startsWith('2026')); const n = ths.find(t => t.textContent.trim().startsWith('Item') && !t.textContent.includes('#')); return [Math.round(y.getBoundingClientRect().width), Math.round(n.getBoundingClientRect().width)]; })()")
    check(tw[0] < 140 and tw[1] > tw[0], f'year columns keep their natural width; the extra room goes to the item names ({tw})')
    page.locator('table.xtable tbody tr', has_text='Pepper').locator('td').first.click(); page.wait_for_timeout(100)
    page.locator('table.xtable tbody tr', has_text='Pepper').locator('td').first.click(); page.wait_for_timeout(100)
    check(page.get_by_role('button', name='Edit item').count() == 0, 'clicking the selected item again unselects it')
    for tb, sel in [('BOMs', '.sidebar label.field select'), ('Dashboard', 'label.field select'), ('By Customer', 'label.field select')]:
        tab(page, tb)
        opts = page.locator(sel).first.locator('option').all_inner_texts()
        check(opts == want_years, f'{tb} offers 2026 through next year ({opts})')
    tab(page, 'Master List')
    check(page.locator('text=Type in the yellow').count() == 0, 'no “Type in the yellow cells” note')
    check(page.locator('.sidebar').evaluate("e => Math.round(e.getBoundingClientRect().width)") == 170, 'the Master List side bar is narrower (170px)')
    nos = page.locator('table.t tbody tr td:nth-child(1)').all_inner_texts()
    check(all(len(n) == 6 for n in nos) and page.locator('tr', has_text='Cheese').locator('td').nth(0).inner_text() == '100001' and page.locator('tr', has_text='Original gallon').locator('td').nth(0).inner_text() == '500003', f'item numbers are 6 digits by type ({nos[:3]})')
    c = cell(page, 'sc|100001|2026'); c.click(); orig = c.input_value(); c.fill(str(float(orig) + 1)); c.press('Tab'); page.wait_for_timeout(300)
    rec2 = page.locator('tr', has_text='RECIPE: Original').locator('td').nth(5).get_attribute('data-v')
    check(rec != rec2, f'recipe cost recalculates when cheese cost changes ({rec} -> {rec2})')
    c = cell(page, 'sc|100001|2026'); c.click(); c.fill(orig); c.press('Tab'); page.wait_for_timeout(300)
    check(page.locator('tr', has_text='RECIPE: Original').locator('td').nth(5).get_attribute('data-v') == rec, 'restoring cheese cost restores recipe cost')
    check(not errors, 'no browser errors during edits' + (f': {errors[:3]}' if errors else ''))

    # ---- sales summaries ----
    tab(page, 'By Customer')
    total = acct(page.locator('table.t tfoot td').nth(-3).inner_text())
    want = round(sum(s['amount'] or 0 for s in inputs['sales'] if s['date'].startswith('2026')), 2)
    check(total == want, f'By Customer total matches 2026 sales ({total} vs {want})')
    custs = {s['customer'] for s in inputs['sales'] if s['date'].startswith('2026')}
    check(page.locator('table.t tbody tr').count() == len(custs), f'one row per customer ({len(custs)})')
    page.get_by_role('button', name='Cases').click(); page.wait_for_timeout(100)
    cases = page.locator('table.t tfoot td').nth(-3).inner_text()
    want_cases = '{:,.0f}'.format(sum(s['quantity'] or 0 for s in inputs['sales'] if s['date'].startswith('2026') and s['item_no']))
    check(cases == want_cases, f'cases total ({cases} vs {want_cases})')
    shot(page, '29-sales-by-customer')
    tab(page, 'By Product')
    prods = {s['product'] for s in inputs['sales'] if s['date'].startswith('2026')}
    check(page.locator('table.t tbody tr').count() == len(prods), f'one row per product ({len(prods)})')

    # ---- Sales Detail: the workbook is the baseline; load the QuickBooks report onto it ----
    QB = ROOT / 'tests/fixtures/qb-sales-detail.xlsx'
    if QB.exists():
        tab(page, 'Sales Detail')
        base = page.evaluate('window.__MOCK_DB__.sales.length')
        page.set_input_files('#qb-file', str(QB)); page.wait_for_selector('.import-panel h3', timeout=10000)
        vals = page.locator('.import-panel .stat .value').all_inner_texts()
        check(vals == ['313', '19', '293', '1'], f'preview: 313 lines, 19 $0 left out, 293 already in Sales Detail, 1 new ({vals})')
        check(page.locator('.confirm-names').count() == 0, 'no names to confirm: every QuickBooks name is on the saved list')
        shot(page, '30-sales-detail-preview')
        page.get_by_role('button', name='Add 1 line').click(); page.wait_for_timeout(400)
        new = page.evaluate('window.__MOCK_DB__.sales.filter(s => s.import_id)')
        check(len(new) == 1 and new[0]['amount'] < 0 and new[0]['txn_type'] == 'Credit Memo', 'the one missing line (a credit memo) is added')
        newcust = new[0]['customer']
        check(page.evaluate('window.__MOCK_DB__.sales.length') == base + 1, 'Sales Detail grows by one line')
        page.set_input_files('#qb-file', str(QB)); page.wait_for_selector('.import-panel h3', timeout=10000)
        vals = page.locator('.import-panel .stat .value').all_inner_texts()
        check(vals[2:] == ['294', '0'] and page.get_by_text('Everything in this report is already in Sales Detail').is_visible(), f'loading it again adds nothing ({vals})')
        page.get_by_role('button', name='Cancel').click(); page.wait_for_timeout(100)
        page.get_by_role('button', name=re.compile('^Loaded reports')).click(); page.wait_for_timeout(80)
        page.get_by_role('button', name='Undo', exact=True).click(); page.get_by_role('button', name='Undo load').click(); page.wait_for_timeout(300)
        check(page.evaluate('window.__MOCK_DB__.sales.length') == base, 'undoing the load removes the line it added')
        # A customer QuickBooks name not on the saved list is offered for confirmation.
        page.evaluate("window.__STANS_FORGET__ = true")
        page.evaluate("""(() => { const m = window.__MOCK_DB__.qb_name_map; const i = m.findIndex(x => x.kind === 'customer' && x.name === %s); m.splice(i, 1); })()""" % json.dumps(newcust))
        page.locator('.gear').click(); page.get_by_role('menuitem', name='Refresh data').click(); page.wait_for_timeout(500)
        page.set_input_files('#qb-file', str(QB)); page.wait_for_selector('.import-panel h3', timeout=10000)
        check(page.locator('.confirm-names tbody tr').count() == 1, 'an unknown QuickBooks customer is listed to confirm')
        inp = page.locator('.confirm-names input'); check(inp.input_value() == newcust, 'suggested name matches an existing customer')
        shot(page, '31-sales-detail-confirm')
        page.get_by_role('button', name='Cancel').click()
        bad = ROOT / 'tests/fixtures/not-a-report.csv'; bad.write_text('Name,Phone\nBob,555\n')
        page.set_input_files('#qb-file', str(bad)); page.wait_for_timeout(300)
        check(page.locator('.toast.bad', has_text='Transaction date').count() > 0, 'a file that is not the report is refused with a clear message')
        bad.unlink()

    # ---- Planning ----
    tab(page, 'Planning/Production')
    check(page.get_by_role('tab', name='Demand Plan').count() == 0 and page.get_by_role('tab', name='Purchase Plan').count() == 0 and page.get_by_role('tab', name='Planning Dashboard').count() == 0, 'old planning tabs are gone')
    check(page.locator('.page-intro li').count() == 4 and page.locator('table.pd-prod .band-label').count() == 2, 'Production explains how to use it, with labelled groups of weeks')
    pw = page.evaluate("[Math.round(document.querySelector('table.pd-prod').getBoundingClientRect().width), Math.round(document.querySelector('#app .layout > .content').clientWidth)]")
    check(pw[0] >= pw[1] - 60, f'the Production table is the full width of the page ({pw})')
    check(page.locator('.pd-half h2').count() == 0 and page.locator('table.pd-status').count() == 0 and page.locator('table.pd-prod', has_text='Total').count() == 0, 'Production shows only the production grid, no heading or totals')
    prow = page.locator('table.pd-prod tbody tr').first
    check(prow.locator('td.cell input').count() == 6 and prow.locator('td.pd-actual').count() == 6 and prow.locator('td.pd-avg').count() == 0 and page.locator('table.pd-prod th', has_text='Average').count() == 0, 'production: 6 actual weeks and 6 weeks typed in, no Average column')
    check(prow.locator('td').first.evaluate("e => getComputedStyle(e).position") == 'sticky', 'the product name stays put when scrolling sideways')
    ph = prow.locator('td.cell input').first.get_attribute('placeholder')
    check(ph not in (None, '', '0') and prow.locator('td.cell.suggested').count() == 6, f'blank weeks show the average demand, lighter ({ph})')
    key = prow.locator('td.cell input').nth(1).get_attribute('data-k'); _, item_no, week = key.split('|')
    shot(page, '50-production')
    tab(page, 'Purchases')
    mats_n = len([i for i in inputs['items'] if i['type'] in ('Raw Material', 'Component')])
    st_rows = page.locator('table.pd-status tbody tr')
    classes = [c.split()[0] for c in st_rows.evaluate_all("rs => rs.map(r => r.className)")]
    order = ['st-red', 'st-orange', 'st-yellow', 'st-green']
    check(st_rows.count() == mats_n and all(c in order for c in classes) and classes == sorted(classes, key=order.index), f'every material and packaging item is a colored row, worst first ({st_rows.count()}: {sorted(set(classes))})')
    check(page.locator('.pd-half h2').count() == 0, 'no Purchase Planning card heading')
    red_bg = page.locator('table.pd-status tbody tr.st-red td').first.evaluate("e => [getComputedStyle(e).backgroundColor, getComputedStyle(e).fontWeight]")
    check(red_bg[0] == 'rgb(251, 213, 210)' and int(red_bg[1]) >= 700, f'rows are pastel with bold text ({red_bg})')
    how = page.locator('table.pd-status tbody tr', has_text='Cheese').first.locator('td').nth(4).inner_text()
    import re as _re
    check(how == '' or _re.fullmatch(r'[\d,]+ box(es)?', how) is not None, f'cheese is ordered in whole 30 lb boxes ({how})')
    check(page.locator('.sidebar').is_hidden() and page.locator('.table-actions', has_text='Download for Excel').count() == 1, 'Purchasing has no left bar; Download for Excel is above the table')
    page.locator('table.pd-status tbody tr', has_text='7 oz Container').first.click(); page.wait_for_timeout(150)
    before_side = page.locator('tr.pd-detail').inner_text()
    check('Safety stock' in before_side and page.locator('tr.pd-detail').count() == 1, 'clicking an item opens its orders under it')
    tab(page, 'Planning/Production')
    c = cell(page, key); c.click(); c.fill('2000'); c.press('Tab'); page.wait_for_timeout(300)
    check(page.evaluate(f"window.__MOCK_DB__.production_plan.find(f => f.item_no === {item_no} && f.week === '{week}').cases") == 2000, 'typed production is saved for that week')
    tab(page, 'Purchases')
    after_side = page.locator('tr.pd-detail').inner_text()
    check(before_side != after_side, 'typed production changes what to buy')
    shot(page, '51-purchasing')
    tab(page, 'Planning/Production')
    c = cell(page, key); c.click(); c.fill(''); c.press('Tab'); page.wait_for_timeout(300)
    check(page.evaluate(f"window.__MOCK_DB__.production_plan.filter(f => f.item_no === {item_no}).length") == 0, 'clearing it goes back to the average')
    tab(page, 'Purchases')
    page.locator('table.pd-status tbody tr', has_text='Cheese').first.click(); page.wait_for_timeout(150)
    check('14 days' in page.locator('tr.pd-detail').inner_text(), 'every material has a two-week lead time')
    tab(page, 'Safety Stocks')
    check(page.locator('table.xtable thead', has_text='Safety stock').count() == 1 and page.locator('.sidebar').is_hidden() and page.locator('.table-actions', has_text='Download for Excel').count() == 1, 'safety stocks on their own tab, no left bar, download above the table')
    shot(page, '62-safety-stocks')
    cheese_no = next(i['item_no'] for i in inputs['items'] if i['name'] == 'Cheese')
    heads = page.locator('table.ss-table thead th').all_inner_texts()
    check([x.split('\n')[0].strip() for x in heads][:5] == ['Item', 'Min Order', 'Demand', 'Lead time', 'Safety stock'], f'safety stock columns ({heads})')
    check(page.locator('table.ss-table tbody tr', has_text='Cheese').locator('td').nth(1).locator('input').input_value().endswith(' lb'), 'min order shows the unit')
    page.locator('table.ss-table tbody tr', has_text='Cheese').locator('.note-btn').click(); page.wait_for_timeout(150)
    check(page.locator('.notepad', has_text='Box of 30 lb').count() == 1, 'the (i) opens a note pad with what it comes in')
    page.locator('.notepad textarea').fill('Call Sysco on Mondays'); page.locator('.notepad .btn.primary').click(); page.wait_for_timeout(300)
    check(page.evaluate(f"window.__MOCK_DB__.purchase_settings.find(s => s.item_no === {cheese_no}).notes") == 'Call Sysco on Mondays' and page.locator('.notepad').count() == 0, 'notes are saved')
    check(page.locator('table.ss-table tbody tr', has_text='Cheese').locator('.note-btn.has-note').count() == 1, 'an item with notes shows it')
    c = cell(page, f'ps|{cheese_no}|lead_days'); c.click(); c.fill('21'); c.press('Tab'); page.wait_for_timeout(250)
    check(page.evaluate(f"window.__MOCK_DB__.purchase_settings.find(s => s.item_no === {cheese_no}).lead_days") == 21, 'lead time can be changed per material')
    tab(page, 'Purchases')
    check('21 days' in page.locator('tr.pd-detail').inner_text(), 'the plan uses the new lead time')
    tab(page, 'Safety Stocks')
    c = cell(page, f'ps|{cheese_no}|lead_days'); c.click(); c.fill(''); c.press('Tab'); page.wait_for_timeout(250)
    tab(page, 'Dashboard')
    check(page.locator('.note.warn', has_text='Below safety stock or to order this week').count() == 1, 'the dashboard lists what to order now')

    # ---- Consumption ----
    tab(page, 'Consumption')
    cheese_row = page.locator('table.xtable tbody tr', has_text='Cheese').first
    jul = cheese_row.locator('td').nth(3 + 6).inner_text()
    check(jul not in ('', '0'), f'standard usage by month (Cheese, July {jul})')
    page.get_by_role('button', name='Dollars').click(); page.wait_for_timeout(150)
    check(cheese_row.locator('td').nth(3 + 6).locator('.cur').count() == 1, 'usage in dollars, accounting style')
    page.get_by_role('button', name='Count to count').click(); page.wait_for_timeout(150)
    n_cc = page.locator('table.xtable tbody tr').count()
    check(n_cc > 0 and page.locator('table.xtable thead', has_text='Actual used').count() == 1, f'count-to-count actual vs standard usage ({n_cc} periods)')
    shot(page, '53-count-to-count')
    page.get_by_role('button', name='Daily').click(); page.wait_for_timeout(150)
    check(page.locator('h2', has_text='Used per case produced').count() == 1, 'daily usage and per-case usage are on Consumption')
    page.get_by_role('button', name='By month').click(); page.wait_for_timeout(100)
    page.get_by_role('button', name='Quantity').click(); page.wait_for_timeout(100)

    # ---- Count sheet ----
    tab(page, 'New Counts')
    check(page.locator('table.count-sheet').count() == 1 and page.get_by_role('button', name='Check counts').count() == 0, 'New Counts is just the count sheet')
    cdate = sorted({c['date'] for c in inputs['cycle_counts']})[-1]
    page.locator('.sidebar input[type=date]').fill(cdate); page.locator('.sidebar input[type=date]').dispatch_event('change'); page.wait_for_timeout(200)
    check(page.locator('table.count-sheet thead', has_text='Expected').count() == 0, 'counting is blind: no expected numbers while counting')
    shot(page, '55a-count-blind')
    crow = page.locator('table.count-sheet tbody tr', has_text='Cheese').first
    got = cell(page, f'csf|{cheese_no}').input_value()
    check(got != '', f'New Counts shows what was counted on {cdate} ({got} boxes)')
    lj = str(next(i['item_no'] for i in inputs['items'] if i['name'] == 'Lemon Juice'))
    check(crow.locator('.cnt-u').first.inner_text() == 'full boxes' and 'lb loose' in crow.inner_text(), 'cheese is counted in full boxes plus loose lb')
    f_ = cell(page, f'csf|{cheese_no}'); l_ = cell(page, f'csl|{cheese_no}'); keep = (f_.input_value(), l_.input_value())
    f_.fill('12'); l_.fill('15'); l_.press('Tab'); page.wait_for_timeout(300)
    check(page.evaluate(f"window.__MOCK_DB__.cycle_counts.find(c => c.item_no === {cheese_no} && c.date === '{cdate}').qty") == 375, '12 boxes + 15 lb loose is saved as 375 lb')
    f_ = cell(page, f'csf|{cheese_no}'); l_ = cell(page, f'csl|{cheese_no}'); f_.fill(keep[0]); l_.fill(keep[1]); l_.press('Tab'); page.wait_for_timeout(300)
    tcell = cell(page, 'csf|' + lj); tcell.click(); tcell.fill('1'); tcell.press('Tab'); page.wait_for_timeout(250)
    tab(page, 'All Counts')
    page.get_by_role('button', name='Check a day').click(); page.wait_for_timeout(150)
    page.locator('.sidebar select').select_option(cdate); page.wait_for_timeout(150)
    chk = page.locator('table.count-check tbody tr', has_text='Cheese').first
    check(chk.locator('td').nth(2).inner_text() not in ('', '—') and 'boxes' in chk.locator('td').nth(1).inner_text(), f'Check a day shows counted (in boxes) next to expected ({chk.inner_text()!r})')
    check(page.locator('table.count-check tbody tr.flagged', has_text='Lemon Juice').count() == 1, 'a count far from expected is flagged')
    shot(page, '55-count-sheet')
    page.get_by_role('button', name='Month', exact=True).click(); page.wait_for_timeout(150)
    check(page.locator('table.t td.cell input').count() > 0, 'All Counts has the month grid')
    tab(page, 'New Counts')
    tcell = cell(page, 'csf|' + lj); tcell.click(); tcell.fill(''); tcell.press('Tab'); page.wait_for_timeout(250)

    # ---- Production lots ----
    tab(page, 'Production')
    page.get_by_role('button', name='Lots', exact=True).click(); page.wait_for_timeout(200)
    nl = page.locator('table.xtable tbody tr').count()
    want_lots = len({(p['date'], p['item_no']) for p in inputs['production'] if p['cases']})
    check(nl == want_lots, f'one lot per product per production day ({nl} vs {want_lots})')
    page.locator('table.xtable tbody tr').nth(5).locator('td').first.click(); page.wait_for_timeout(150)
    code = page.locator('table.xtable tbody tr.selected td').first.inner_text()
    check(re.match(r'^\d{6}-\d{6}$', code) and f'Lot {code}' in page.locator('.side-detail').inner_text(), f'selecting a lot shows who it shipped to ({code})')
    shot(page, '57-lots')
    page.get_by_role('button', name='Daily', exact=True).click(); page.wait_for_timeout(100)

    # ---- BOMs tree ----
    tab(page, 'BOMs')
    while page.locator('table.tree-table button.twisty[aria-expanded=true]').count():
        page.locator('table.tree-table button.twisty[aria-expanded=true]').first.click(); page.wait_for_timeout(60)
    rows = page.locator('table.tree-table tbody tr')
    tops = rows.locator('.tree-name').all_inner_texts()
    check(rows.count() == 8 and 'RECIPE: Original' in tops and 'RECIPE: Jalapeños' in tops, f'BOMs lists all 8 BOMs at top level, recipes included ({rows.count()} rows)')
    check(tops.index('RECIPE: Original') > tops.index('Jalapeños gallon'), 'products are listed before recipes')
    used = page.locator('tr.d0', has=page.locator('.tree-name', has_text='RECIPE: Original')).locator('td.used-in').inner_text()
    check(used == '3 BOMs', f'recipe shows where it is used ({used})')
    page.locator('tr', has=page.locator('.tree-name', has_text='Original 7 oz.')).first.click(); page.wait_for_timeout(120)
    check(rows.count() == 8 + 6, f'clicking a product opens its next level ({rows.count() - 8} lines)')
    recipe_row = page.locator('tr.d1', has=page.locator('.tree-name', has_text='RECIPE: Original'))
    unit = float(recipe_row.locator('td').nth(7).inner_text().replace('$', '')); line = float(recipe_row.locator('td').nth(8).inner_text().replace('$', '').replace(',', ''))
    check(abs(168 * unit - line) < 0.01, f'recipe line cost = 168 oz x unit cost ({line})')
    recipe_row.locator('button.twisty').click(); page.wait_for_timeout(120)
    check(page.locator('tr.d2').count() == 10, f'opening the recipe shows its 10 ingredients at level 2 ({page.locator("tr.d2").count()})')
    check(page.locator('tr.d2 .guide.tee').count() == 9 and page.locator('tr.d2 .guide.elbow').count() == 1, 'tree lines: 9 branches and one last-elbow at level 2')
    shot(page, '26-boms-tree')
    check(page.get_by_role('button', name='Open all').count() == 0 and page.get_by_role('button', name='Close all').count() == 0, 'no Open all / Close all buttons')
    page.locator('tr', has=page.locator('.tree-name', has_text='Original 7 oz.')).first.click(); page.wait_for_timeout(120)
    check(rows.count() == 8, 'clicking an open product closes it again')

    # ---- BOM editor lives in the BOMs tab's side bar ----
    tab(page, 'BOMs')
    check(page.locator('.bom-editor').count() == 0, 'the BOM editor is hidden until New BOM or Edit is clicked')
    check(page.locator('.sidebar').evaluate("e => Math.round(e.getBoundingClientRect().width)") == 250, 'the side bar starts 250px wide')
    page.get_by_role('button', name='New BOM').click(); page.wait_for_timeout(100)
    check(page.locator('.sidebar .bom-editor').is_visible() and page.locator('.cb-warning').count() == 0, 'New BOM opens the editor in the side bar (no edit warning)')
    check(page.get_by_role('button', name='New BOM').count() == 0, 'the New BOM button hides while the editor is open')
    fit = page.evaluate("""(() => { const s = document.querySelector('.side-inner'); return [...s.querySelectorAll('.bom-editor *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > s.getBoundingClientRect().right + 1).length; })()""")
    check(fit == 0, f'BOM editor fits the side bar width ({fit} overflowing)')
    page.get_by_role('button', name='Cancel').click(); page.wait_for_timeout(100)
    check(page.locator('.bom-editor').count() == 0, 'Cancel on an untouched new BOM closes it')
    check(page.locator('.bom-year-head h2').inner_text() == '2026 BOMs', 'the BOMs show which year they are for')
    check(page.locator('table.tree-table button', has_text='Edit').count() == 0, 'no Edit buttons on the rows')
    edit_bom(page, 'Original 7 oz.')
    check(page.locator('tr.d0.selected .tree-name').first.inner_text().startswith('Original 7 oz.'), 'clicking a BOM selects it')
    check(page.evaluate("location.hash") == '#bom', 'Edit BOM stays on the BOMs tab')
    check(page.locator('.bom-editor .tb-title', has_text='Editing 2026').count() == 1, 'Edit BOM loads the BOM into the editor')
    check(page.locator('.cb-warning', has_text='can break things').is_visible(), 'editing the current year warns that it could break things')
    shot(page, 'bom-editor')
    page.get_by_role('button', name='Cancel').click(); page.wait_for_timeout(100)
    page.get_by_role('button', name='New BOM').click(); page.wait_for_timeout(60)
    # ---- a sub-recipe nested inside a recipe inside a product ----
    cost_before = page.evaluate("1")
    page.fill('#cb-name', 'Spice Mix'); page.locator('#cb-name').press('Tab')
    page.select_option('#cb-type', 'Recipe'); page.wait_for_timeout(80)
    page.fill('#cb-yield', '10'); page.locator('#cb-yield').press('Tab'); page.wait_for_timeout(60)
    page.fill('#cb-yield-unit', 'c'); page.locator('#cb-yield-unit').press('Tab'); page.wait_for_timeout(60)
    page.fill('#cb-unit', 'c'); page.locator('#cb-unit').press('Tab'); page.wait_for_timeout(60)
    sel = page.locator('table.cb-lines tbody tr').nth(0).locator('select'); sel.select_option(label='Pepper'); page.wait_for_timeout(80)
    q = page.locator('table.cb-lines tbody tr').nth(0).locator('input[type=text]'); q.fill('4'); q.press('Tab'); page.wait_for_timeout(80)
    sel = page.locator('table.cb-lines tbody tr').nth(1).locator('select'); sel.select_option(label='Brown Sugar'); page.wait_for_timeout(80)
    q = page.locator('table.cb-lines tbody tr').nth(1).locator('input[type=text]'); q.fill('6'); q.press('Tab'); page.wait_for_timeout(80)
    total = page.locator('.cb-total').inner_text()
    want_mix = (4 * 1.64 + 6 * 0.5) / 10
    check(abs(float(total.split()[0].replace('$', '')) - want_mix) < 0.0001, f'live cost per cup of Spice Mix ({total})')
    shot(page, '27-create-bom')
    page.get_by_role('button', name='Save BOM').click(); page.wait_for_timeout(300)
    check(page.locator('.bom-editor').count() == 0, 'saving a new BOM closes the editor')
    mix = page.evaluate("window.__MOCK_DB__.items.find(i => i.name === 'Spice Mix')")
    check(mix is not None and page.evaluate(f"window.__MOCK_DB__.bom_lines.filter(l => l.parent_item_no === {mix['item_no']}).length") == 2, 'saving creates the item, its BOM and 2 lines')
    # Put 2 c. of Spice Mix into the Original recipe.
    edit_bom(page, 'RECIPE: Original')
    check(page.locator('.cb-warning', has_text='current year').is_visible(), 'editing a current-year BOM shows the warning')
    check(page.locator('#cb-item').count() == 0, 'editing does not offer to switch items')
    n_lines = page.locator('table.cb-lines tbody tr').count()
    check(n_lines == 10, f'editing an existing BOM loads its lines ({n_lines})')
    page.get_by_role('button', name='+ Add line').click(); page.wait_for_timeout(60)
    last = page.locator('table.cb-lines tbody tr').last
    last.locator('select').select_option(label=[o for o in last.locator('select option').all_inner_texts() if o.startswith('Spice Mix')][0]); page.wait_for_timeout(80)
    last = page.locator('table.cb-lines tbody tr').nth(10); q = last.locator('input[type=text]'); q.fill('2'); q.press('Tab'); page.wait_for_timeout(80)
    page.get_by_role('button', name='Save changes').click(); page.wait_for_timeout(300)
    # Loop protection: Spice Mix can no longer contain Original or any product.
    edit_bom(page, 'Spice Mix')
    opt = page.locator('table.cb-lines tbody tr').last.locator('option', has_text='RECIPE: Original')
    check(opt.is_disabled() and 'contains this item' in opt.inner_text(), 'items that contain this BOM are blocked (no loops)')
    # ---- BOMs by year: changing next year leaves this year alone ----
    tab(page, 'BOMs')
    page.locator('.bom-editor').get_by_role('button', name='Cancel').click(); page.wait_for_timeout(100)
    check(not page.locator('.sidebar label.field', has_text='Year').locator('select').is_disabled(), 'the year can be changed once the editor is closed')
    page.locator('.sidebar label.field', has_text='Year').locator('select').select_option('2027'); page.wait_for_timeout(150)
    check(page.locator('.bom-year-head h2').inner_text() == '2027 BOMs' and 'Same as 2026' in page.locator('.bom-year-head').inner_text(), 'a future year shows the BOMs carried over from 2026')
    cost26 = page.evaluate("1")
    edit_bom(page, 'Original 7 oz.')
    check(page.locator('.cb-warning').count() == 0, 'editing a future year has no warning')
    check(page.locator('.cb-future', has_text='copy of the 2026 BOM').is_visible(), 'a future-year edit starts as a copy of 2026')
    rows_ = page.locator('table.cb-lines tbody tr')
    box = [i for i in range(rows_.count()) if rows_.nth(i).locator('select option:checked').inner_text() == '7 oz Case Box'][0]
    q = rows_.nth(box).locator('input[type=text]'); q.fill('2'); q.press('Tab'); page.wait_for_timeout(100)
    page.get_by_role('button', name='Save changes').click(); page.wait_for_timeout(300)
    check(page.locator('.bom-editor').count() == 0, 'saving an edit closes the editor')
    v27 = page.evaluate("window.__MOCK_DB__.bom_lines.filter(l => l.parent_item_no === 500001 && l.year === 2027).length")
    v26 = page.evaluate("window.__MOCK_DB__.bom_lines.filter(l => l.parent_item_no === 500001 && l.year === 2026).find(l => l.item_no === window.__MOCK_DB__.items.find(i => i.name === '7 oz Case Box').item_no).qty")
    check(v27 >= 6 and v26 == 1, f'the 2027 change is saved as its own BOM; 2026 keeps 1 box ({v27} lines, 2026 qty {v26})')
    def box_qty():
        top = page.locator('tr.d0', has=page.locator('.tree-name', has_text='Original 7 oz.'))
        if top.locator('button.twisty').get_attribute('aria-expanded') == 'false': top.locator('button.twisty').click(); page.wait_for_timeout(100)
        return page.locator('tr.d1', has=page.locator('.tree-name', has_text='7 oz Case Box')).first.locator('td').nth(4).inner_text()
    q27 = box_qty()
    page.locator('.sidebar label.field', has_text='Year').locator('select').select_option('2026'); page.wait_for_timeout(150)
    q26 = box_qty()
    check(q27.startswith('2') and q26.startswith('1'), f'the tree shows 2 case boxes in 2027 and 1 in 2026 ({q27}, {q26})')
    page.locator('.sidebar label.field', has_text='Year').locator('select').select_option('2027'); page.wait_for_timeout(150)
    check('1 of 9 carried' not in page.locator('.bom-year-head').inner_text() and 'carried over' in page.locator('.bom-year-head').inner_text(), 'the year heading says how many BOMs are carried over')
    edit_bom(page, 'Original 7 oz.')
    check(page.locator('.cb-future', has_text='Changes apply from 2027').is_visible() and page.get_by_role('button', name='Delete 2027 BOM').count() == 1, 'a year with its own BOM can delete just that year')
    page.get_by_role('button', name='Delete 2027 BOM').click(); page.wait_for_timeout(100)
    page.locator('dialog[open]').get_by_role('button', name='Delete').click(); page.wait_for_timeout(300)
    check(page.evaluate("window.__MOCK_DB__.boms.filter(b => b.item_no === 500001).length") == 1, 'deleting the 2027 BOM goes back to 2026’s')
    page.locator('.sidebar label.field', has_text='Year').locator('select').select_option('2026'); page.wait_for_timeout(150)
    # The tree now goes three levels deep under a product.
    tab(page, 'BOMs')
    for _ in range(12):  # open the Original products, then the recipe and Spice Mix inside each
        closed = page.locator('table.tree-table tr', has=page.locator('.tree-name', has_text=re.compile(r'^(Original|RECIPE: Original|Spice Mix)'))).locator('button.twisty[aria-expanded=false]')
        if not closed.count(): break
        closed.first.click(); page.wait_for_timeout(60)
    check(page.locator('tr.d3', has=page.locator('.tree-name', has_text='Pepper')).count() >= 3, 'Spice Mix ingredients show at level 3 under each Original product')
    top_names = page.locator('table.tree-table tr.d0 .tree-name').all_inner_texts()
    check('Spice Mix' in top_names, 'Spice Mix also has its own top-level row')
    used = page.locator('tr.d0', has=page.locator('.tree-name', has_text='Spice Mix')).locator('td.used-in').inner_text()
    check(used == 'RECIPE: Original', f'Spice Mix shows it is used in RECIPE: Original ({used})')
    case = page.locator('tr.d0', has=page.locator('.tree-name', has_text='Original 7 oz.'))
    got = float(case.locator('td').nth(7).inner_text().replace('$', ''))
    want = 28.947849217391 + 168 * 2 * want_mix / 3220
    check(abs(got - want) < 0.006, f'Original 7 oz case cost includes the Spice Mix ({got:.4f} vs {want:.4f})')
    shot(page, '28-boms-three-levels')

    # ---- Change history, downloads, missing standards ----
    tab(page, 'Change history')
    hist = page.locator('table.xtable tbody tr')
    check(hist.count() == 2 and 'cost: 1.9 → 1.937' in hist.first.inner_text() and 'Cheese' in hist.first.inner_text(), f'change history shows who changed what ({hist.first.inner_text()!r})')
    tab(page, 'Master List')
    with page.expect_download() as dl: page.get_by_role('button', name='⤓ Download for Excel').click()
    path = dl.value.path(); csv = open(path, encoding='utf-8-sig').read().splitlines()
    check(csv[0].startswith('Item #,Item,Type,Base unit,Receipt') and len(csv) == 1 + page.evaluate('window.__MOCK_DB__.items.length') and any(',Cheese,' in l and '30 lb box' in l and ',1.937' in l for l in csv), f'Master List downloads for Excel ({len(csv)} lines)')
    nxt_y = TODAY.year + 1
    check(page.locator('.note.warn.missing-costs').count() == 0, 'the next-year standards warning only shows in December')
    check(page.locator('table.xtable thead', has_text='Scenario').count() == 0, 'no scenario label under the years')
    heads = [x.split('\n')[0].strip() for x in page.locator('table.xtable thead th').all_inner_texts()]
    check(heads[:5] == ['Item #', 'Item', 'Type', 'Base unit', 'Receipt'], f'Master List columns ({heads[:6]})')
    rc = page.locator('[data-k="rc|100002"]')
    check(rc.input_value() == '420 lb drum', f'Receipt reads like "420 lb drum" ({rc.input_value()})')
    rc.fill('400 lbs drums'); rc.press('Enter'); page.wait_for_timeout(250)
    mayo = page.evaluate("window.__MOCK_DB__.items.find(i => i.item_no === 100002)")
    check(mayo['receiving_unit'] == 'drum' and mayo['units_per_receiving'] == 400, 'Receipt can be typed in the table')
    rc = page.locator('[data-k="rc|100002"]'); rc.fill('400 cups drum'); rc.press('Enter'); page.wait_for_timeout(250)
    check(page.locator('.toast.bad', has_text='counted in lb').count() >= 1 and page.evaluate("window.__MOCK_DB__.items.find(i => i.item_no === 100002).units_per_receiving") == 400, 'a Receipt in the wrong unit is refused')
    rc = page.locator('[data-k="rc|100002"]'); rc.fill('420 lb drum'); rc.press('Enter'); page.wait_for_timeout(250)
    sb = page.locator('.side-inner .btn.download').evaluate("e => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().right <= e.closest('.sidebar').getBoundingClientRect().right")
    check(sb, 'Download for Excel fits in the side bar')
    tab(page, 'Standard Price')
    check(page.locator('.note.warn.missing-prices', has_text=str(nxt_y)).count() == 1, f'Standard Price warns that {nxt_y} prices are missing')

    # ---- Accounting with amounts ----
    tab(page, 'Journals')
    back = (TODAY.year - 2026) * 12 + TODAY.month - 7
    for _ in range(back): page.get_by_role('button', name='Previous month').click(); page.wait_for_timeout(60)
    page.wait_for_timeout(150)
    check('Jul 2026' in page.locator('.bom-year-head').inner_text(), 'Journals go back to July 2026')
    jul_sales = round(sum(s['amount'] or 0 for s in inputs['sales'] if s['date'].startswith('2026-07')), 2)
    rev = page.locator('table.journal tr', has_text='Cr. Sales Revenue').locator('td').nth(3).inner_text()
    check(acct(rev) == jul_sales, f'July revenue posts from Sales Detail ({rev} vs {jul_sales})')
    bal = page.locator('table.journal tr.entry-total').all_inner_texts()
    check(bal and all('Balanced' in b for b in bal), f'every entry balances ({len(bal)} entries)')
    check(page.locator('table.journal tr', has_text='Dr. Inventory: Finished Goods').count() >= 1, 'production posts to finished goods inventory')
    shot(page, '27-journals')
    tab(page, 'T-Accounts')
    check(page.locator('.tacct').count() == 11, f'T-Accounts shows 11 accounts ({page.locator(".tacct").count()})')
    revcard = page.locator('.tacct', has_text='Sales Revenue')
    check(acct(revcard.locator('.tfoot span').last.inner_text()) == jul_sales, 'T-account totals follow the journal (July revenue)')
    page.get_by_role('button', name='Year to date').click(); page.wait_for_timeout(200)
    ytd = round(sum(s['amount'] or 0 for s in inputs['sales'] if '2026-01' <= s['date'][:7] <= '2026-07'), 2)
    check(acct(revcard.locator('.tfoot span').last.inner_text()) == ytd, f'year to date adds up the months ({ytd})')
    shot(page, '27-taccounts')
    page.get_by_role('button', name='Month', exact=True).click()

    # ---- sign out ----
    page.locator('.gear').click(); page.get_by_role('menuitem', name='Sign out').click(); page.wait_for_selector('form input[type=email]')
    check(True, 'sign out returns to sign-in')
    ctx.close()

    # ---- staff view ----
    ctx, page, errors = open_app(browser, role='staff')
    page.route('**/config.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=(
        'window.STANS_CONFIG={supabaseUrl:"https://test.supabase.co",supabaseKey:"k"};'
        f'window.__MOCK_DB__={json.dumps(dict(mock_db(), profiles=[dict(user_id="u1", email="owner@stans.test", role="staff")]))};'
        'window.__MOCK_ROLE__="staff";window.__MOCK_SIGNED_IN__=true;')))
    page.goto(BASE + '/#costs'); page.wait_for_selector('.groups .group')
    page.locator('.gear').click(); page.wait_for_timeout(80)
    check(page.locator('.gear-menu a', has_text='Users').count() == 0, 'staff does not see Users in the gear menu')
    page.keyboard.press('Escape')
    check(cell(page, 'sc|100001|2026').is_disabled(), 'staff cannot edit standard costs')
    tab(page, 'Production')
    check(not cell(page, f'production|{TODAY.isoformat()[:8]}01|500001').is_disabled(), 'staff can enter production')
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
    for i, t in enumerate(['New Receipts', 'New Counts', 'Purchases', 'Planning/Production', 'Sales Detail']):
        tab(page, t); page.wait_for_timeout(150)
        ov = page.evaluate('Math.max(document.documentElement.scrollWidth - window.innerWidth, document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth)')
        check(ov <= 0, f'{t}: no sideways page scroll on a phone ({ov}px)')
        shot(page, f'25{chr(98 + i)}-phone-{t.lower().replace(" ", "-")}')
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
