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
    for t in ('recipes', 'recipe_lines', 'fg_lines'): db.pop(t, None)
    db['boms'] = [dict(item_no=r['item_no'], yield_qty=r['batch_size'], yield_unit='oz', labor_minutes=inputs['settings']['minutes_per_batch']) for r in inputs['recipes']]
    db['boms'] += [dict(item_no=f, yield_qty=1, yield_unit='case') for f in dict.fromkeys(l['fg_item_no'] for l in inputs['fg_lines'])]
    db['bom_lines'] = [dict(parent_item_no=l['recipe_item_no'], item_no=l['item_no'], qty=l['qty'], uses_batch_minutes=l['uses_batch_minutes'], sort=l['sort']) for l in inputs['recipe_lines']]
    db['bom_lines'] += [dict(parent_item_no=l['fg_item_no'], item_no=l['item_no'], qty=l['qty'], uses_batch_minutes=False, sort=l['sort']) for l in inputs['fg_lines']]
    db['bom_lines'] = [dict(l, id=i + 1) for i, l in enumerate(db['bom_lines'])]
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
    'Inventory': ['Production', 'Goods Receipt', 'Cycle Counts', 'Daily Inventory', 'Purchase Demand'],
    'Sales': ['Sales Detail', 'By Customer', 'By Product', 'Standard Price'],
    'Standards': ['Standard Cost', 'BOMs', 'Labor'],
    'Accounting': ['Journals', 'T-Accounts'],
}
ALL_TABS = [t for ts in GROUPS.values() for t in ts] + ['Users']

def edit_bom(page, name):
    row = page.locator('table.tree-table tr.d0', has=page.locator('.tree-name', has_text=name)).first
    row.get_by_role('button', name='Edit').click(); page.wait_for_timeout(150)


def tab(page, label):
    if label == 'Users':
        page.locator('.gear').click(); page.locator('.gear-menu a', has_text='Users').click()
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
    check(groups == ['Dashboard', 'Accounting', 'Sales', 'Inventory', 'Standards'], 'five sections across the top, in order')
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
    check(page.locator('.about-slot summary[aria-label="About Labor Rate"]').is_visible(), 'returning to a group reopens the last tab used there')
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
    js_vert = """[...document.querySelectorAll('main *')].filter(e => { if (e.closest('.side-inner')) return false; const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1; }).length"""
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
    page.evaluate('window.scrollTo(0, 1500)'); page.wait_for_timeout(150)
    top = page.evaluate("Math.round(document.querySelector('main .tablewrap thead th').getBoundingClientRect().top)")
    bar = page.evaluate("Math.round(document.querySelector('.topbar').getBoundingClientRect().height)")
    check(abs(top - bar) <= 1, f'Sales Detail column headings stay pinned under the site header ({top} vs {bar})')
    shot(page, '32-sales-scrolled')
    page.evaluate('window.scrollTo(0, 0)')
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
    page.evaluate('window.scrollTo(0, 700)'); page.wait_for_timeout(200)
    fh = page.evaluate("(() => { const f = document.querySelector('.float-head'); if (!f) return null; const r = f.getBoundingClientRect(); return [Math.round(r.top), f.textContent.includes('Cheese')]; })()")
    check(fh is not None and abs(fh[0] - bar) <= 1 and fh[1], f'wide tables keep their column names under the site header too ({fh})')
    page.evaluate("document.querySelector('main .tablewrap').scrollLeft = 300"); page.wait_for_timeout(150)
    off = page.evaluate("(() => { const w = document.querySelector('main .tablewrap'); const real = w.querySelector('thead tr:nth-child(2) th:nth-child(5)').getBoundingClientRect().left; const copy = document.querySelector('.float-head thead tr:nth-child(2) th:nth-child(5)').getBoundingClientRect().left; return Math.round(real - copy); })()")
    check(abs(off) <= 1, f'the floating header lines up with the columns after scrolling sideways (off by {off}px)')
    page.evaluate('window.scrollTo(0, 0)'); page.wait_for_timeout(150)
    dock = page.evaluate("(() => { const f = document.querySelector('.float-foot .ff-scroll'); if (!f) return null; return Math.round(innerHeight - f.getBoundingClientRect().bottom); })()")
    check(dock is not None and 0 <= dock <= 4, f'wide tables have their sideways scrollbar docked at the bottom of the screen ({dock})')
    page.evaluate("document.querySelector('main .tablewrap').scrollLeft = 0"); page.wait_for_timeout(150)
    t = page.locator('.float-foot .ff-thumb').bounding_box()
    page.mouse.move(t['x'] + 10, t['y'] + 5); page.mouse.down(); page.mouse.move(t['x'] + 210, t['y'] + 5, steps=5); page.mouse.up(); page.wait_for_timeout(150)
    sl = page.evaluate("document.querySelector('main .tablewrap').scrollLeft")
    t2 = page.locator('.float-foot .ff-thumb').bounding_box()
    check(sl > 200 and abs(t2['x'] - t['x'] - 200) <= 2, f'dragging the docked scrollbar scrolls the table sideways (table at {sl}px, thumb moved {t2["x"] - t["x"]:.0f}px)')
    shot(page, '36-wide-table-docked-scrollbar')
    page.evaluate('window.scrollTo(0, 0)')

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
    tab(page, 'Sales Detail')
    page.get_by_role('button', name='+ Add a line by hand').click(); page.wait_for_timeout(80)
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
    page.locator('tr', has_text='Test Market').get_by_role('button', name='Delete Original gallon line for Test Market').click()
    page.get_by_role('button', name='Delete', exact=True).last.click(); page.wait_for_timeout(300)
    check(page.evaluate('window.__MOCK_DB__.sales.length') == n0, 'deleting a sale removes it')

    # ---- Sales Detail filters and sorts like an Excel table; totals at the top ----
    if not page.evaluate("document.querySelector('.sidebar').classList.contains('folded')"): page.locator('.side-fold').click(); page.wait_for_timeout(200)
    money = lambda v: '-$' + '{:,.2f}'.format(-v) if v < 0 else '${:,.2f}'.format(v)
    latest = max(int(s['date'][:4]) for s in inputs['sales'])
    yr = [s for s in inputs['sales'] if s['date'].startswith(str(latest))]
    page.evaluate('window.scrollTo(0, 400)'); page.wait_for_timeout(150)
    gap = page.evaluate("Math.round(innerHeight - document.querySelector('main table.xtable tfoot tr.xt-totals td:nth-child(3)').getBoundingClientRect().bottom)")
    check(abs(gap) <= 1, f'the totals row is pinned to the bottom of the screen ({gap}px from the bottom)')
    shot(page, '35-sales-totals-bottom')
    page.evaluate('window.scrollTo(0, 0)')
    tot = lambda: page.locator('tfoot tr.xt-totals td').all_inner_texts()
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
    amts = [float(x.replace('$', '').replace(',', '')) for x in page.locator('main table.xtable tbody td:nth-child(5)').all_inner_texts()]
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
    check(yrs == [str(y) for y in range(2026, datetime.date.today().year + 2)], f'years run from 2026 to next year ({yrs})')
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
    check(page.evaluate("window.__MOCK_DB__.boms.find(b => b.item_no === 10021).labor_minutes") != 60, 'Cancel does not save')
    tab(page, 'Labor')
    hrs = page.locator('table.whatif tbody tr td:first-child').all_inner_texts()
    check(hrs[0].startswith('16') and hrs[-1].startswith('120') and page.locator('table.whatif tr.current').count() == 1, f'what-if runs up to 120 production hours a week ({hrs})')
    w = page.locator('table.whatif tbody tr').last.locator('td').nth(1).inner_text()
    check(abs(float(w.strip('$')) - want(120, 20000, 450)) < 1e-4, f'what-if: at 120 hours the same people cost less per minute ({w})')
    page.get_by_role('button', name='Details for Hourly (A)').click(); page.wait_for_timeout(150)
    dlg = page.locator('dialog.group-dialog')
    dlg.get_by_label('Notes').fill('Line crew'); page.wait_for_timeout(100)
    shot(page, '38-position-details')
    dlg.get_by_role('button', name='Save').click(); page.wait_for_timeout(300)
    check(page.evaluate("window.__MOCK_DB__.labor_positions.find(p => p.id === 2).notes") == 'Line crew', 'details save notes')
    # next year: a forecast from this year + inflation until it has its own people
    nxt = datetime.date.today().year + 1
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
    tab(page, 'Standard Cost')
    col = 5 + (nxt - 2026)
    lab_next = float(page.locator('tr', has_text='Direct Labor').locator('td').nth(col).inner_text().strip('$'))
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
    tab(page, 'Standard Cost')
    lab_this = float(page.locator('tr', has_text='Direct Labor').locator('td').nth(5).inner_text().strip('$'))
    lab_next = float(page.locator('tr', has_text='Direct Labor').locator('td').nth(col).inner_text().strip('$'))
    check(abs(lab_next - r_next) < 1e-4 and abs(lab_this - this_rate) < 1e-4, f'Standard Cost uses each year’s own labor rate ({lab_this}, {lab_next})')
    tab(page, 'Labor')
    page.get_by_role('button', name='Show 2026').click(); page.wait_for_timeout(200)
    # Put the workbook's numbers back for the BOM checks below.
    for k, v in [('lp|1|annual_fixed', ''), ('lp|2|monthly_fringe', '')]:
        c = cell(page, k); c.click(); c.fill(v); c.press('Tab'); page.wait_for_timeout(150)
    check(abs(rate_now() - want()) < 1e-4, 'back to the workbook rate')

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

    # ---- sales summaries ----
    tab(page, 'By Customer')
    total = page.locator('table.t tfoot td').nth(-3).inner_text()
    want = '${:,.0f}'.format(sum(s['amount'] or 0 for s in inputs['sales'] if s['date'].startswith('2026')))
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

    # ---- BOMs tree ----
    tab(page, 'BOMs')
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
    page.locator('.side-fold').click(); page.wait_for_timeout(80)
    edit_bom(page, 'Original 7 oz.')
    check(page.evaluate("location.hash") == '#bom', 'Edit stays on the BOMs tab')
    check('folded' not in page.locator('.sidebar').get_attribute('class'), 'Edit unfolds the side bar')
    check(page.locator('.bom-editor .tb-title', has_text='Editing').count() == 1, 'Edit loads the BOM into the editor')
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
    check(page.locator('.cb-warning', has_text='only when setting up a new year or a new BOM').is_visible(), 'editing a BOM shows the history warning')
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

    tab(page, 'T-Accounts')
    check(page.locator('.tacct').count() == 11, f'T-Accounts shows 11 accounts ({page.locator(".tacct").count()})')
    shot(page, '27-taccounts')

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
