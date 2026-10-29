"""Item numbers: six digits, the first digit says the type.

  1xxxxx Raw Material   2xxxxx Component   3xxxxx Indirect Cost (labor, overhead, marketing, ...)
  4xxxxx Recipe         5xxxxx Finished Good

The workbook still uses the old five-digit numbers; renumber() maps a workbook
export onto the new numbers (each type in old-number order), the same way
supabase/schema.sql renumbers a database.
"""
import copy

PREFIX = {'Raw Material': 1, 'Component': 2, 'Indirect Cost': 3, 'Recipe': 4, 'Finished Good': 5}
ITEM_KEYS = ('item_no', 'recipe_item_no', 'fg_item_no', 'parent_item_no')


def mapping(items):
    out, used = {}, {}
    for it in sorted(items, key=lambda i: i['item_no']):
        if it['item_no'] >= 100000: continue
        p = PREFIX[it['type']]
        top = max([i['item_no'] for i in items if i['item_no'] // 100000 == p] + [p * 100000])
        used[p] = max(used.get(p, top), top) + 1
        out[it['item_no']] = used[p]
    return out


def renumber(data):
    data = copy.deepcopy(data)
    m = mapping(data['items'])
    for rows in data.values():
        if not isinstance(rows, list): continue
        for r in rows:
            if not isinstance(r, dict): continue
            for k in ITEM_KEYS:
                if r.get(k) in m: r[k] = m[r[k]]
    return data
