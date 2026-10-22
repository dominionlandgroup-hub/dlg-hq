#!/usr/bin/env python3
"""Refresh the Builder Hub's Mecklenburg targets (targets_meck.json) with fresh
Charlotte code-enforcement cases and the county delinquent-tax list.

usage: python3 merge_meck.py targets_meck.json [--code dlg_charlotte_code_cases.json] [--tax dlg_meck_tax.json] -o out.json

code json: {"ce": {pin: [housing, nuisance, zoning, open, vacantNote, lastYYYYMM]}, "px": {pin: [owner,first,last,mail,mcity,mstate,mzip,site,scity,szip,acres,improvval,landval,use,saledate,lat,lon]}}
tax json:  {"tx": {siteaddress: amount}, "pt": {pin: [amount,owner,first,last,mail,mcity,mstate,mzip,site,acres,improvval,landval,use,saledate,lat,lon]}}
Both are produced by the browser snippets in this folder (see README.md).
"""
import json, re, sys, time, bisect, argparse

ap = argparse.ArgumentParser(); ap.add_argument('targets'); ap.add_argument('--code'); ap.add_argument('--tax'); ap.add_argument('-o', required=True)
A = ap.parse_args()
d = json.load(open(A.targets)); k = d['k']
for f, dv in (('tax', 0), ('code', 0), ('vac', False), ('cases', 0)):
    if f not in k: k.append(f); [r.append(dv) for r in d['r']]
I = {n: i for i, n in enumerate(k)}
RES = re.compile(r'RESID|SINGLE|SFR|DWELL|MOBILE|MANUF|MODULAR|TOWN|DUPLEX|TRIPLEX|VACANT', re.I)
BAD = re.compile(r'COMMERC|INDUST|OFFICE|RETAIL|EXEMPT|CHURCH|RELIG|GOV|SCHOOL|CONDO|APART|MULTI', re.I)
GOVOWN = re.compile(r'CITY OF|COUNTY|STATE OF|HOUSING AUTH|CHURCH|MINIST|UNITED STATES|BOARD OF|HOMEOWNERS|HOA|ASSOC', re.I)
ENT = re.compile(r'\b(LLC|INC|CORP|CO|LP|LTD|TRUST|PROPERTIES|HOLDINGS|INVEST|GROUP|PARTNERS|BANK)\b', re.I)
EST = re.compile(r'\bEST(ATE)?\b|HEIRS|DECEASED|\bDEC\b', re.I)
CITY = re.compile(r'\s+(Charlotte|Matthews|Mint Hill|Huntersville|Cornelius|Davidson|Pineville|Mecklenburg|Stallings)?\s*Nc$', re.I)
norm = lambda s: re.sub(r'[^A-Z0-9]', '', (s or '').upper())
title = lambda s: ' '.join(w.capitalize() for w in (s or '').split())
now = time.time() * 1000
rows = {str(r[I['pin']]).zfill(8): r for r in d['r']}

def new_row(pin, own, fn, ln, mail, mc, ms, mz, site, ac, impv, landv, sale, la, lo):
    held = round((now - sale) / 3.156e10, 1) if sale and time.gmtime(sale / 1000).tm_year >= 1950 else None
    site = CITY.sub('', title(site)).strip(); mail = re.sub(r'\s+\d{5}(-\d{4})?$', '', mail or '')
    oos = (ms or 'NC').upper() != 'NC'; absentee = norm(mail) != norm(site)
    estate = bool(EST.search(own or '')); entity = bool(ENT.search(own or '')) and not estate; person = not entity and not estate
    nm = (title(fn) + ' ' + title(ln)).strip() if person and (fn or ln) else title(own)
    f1 = title(fn).split(' ')[0] if person and fn else ''
    v = dict(pin=pin, kind='Teardown' if (impv or 0) > 0 else 'Vacant', owner=own or '', m1=mail, m2='', m3=f"{mc or ''} {ms or ''} {str(mz or '')[:5]}".strip(),
             site=site, city='Charlotte', zip='', ac=round(ac, 3) if ac else None, land=landv or 0, bldg=impv or 0, yb=None, sqft=None, held=held,
             absentee=absentee, oos=oos, estate=estate, entity=entity, score=0, mail=False, nm=nm, gr=f1 or 'Property Owner', act='Mail', why='', mk='',
             rb=1 if (held is not None and held < 2) else 0, bf='', fn=f1, ln=title(ln) if person else '', mn=nm, ma=mail, mc=mc or '', ms=ms or '',
             mz=str(mz or '')[:5], la=la, lo=lo, tax=0, code=0, vac=False, cases=0)
    r = [None] * len(k)
    for kk, vv in v.items(): r[I[kk]] = vv
    d['r'].append(r); rows[pin] = r; return r

ok = lambda own, use, site: site and RES.search(use or '') and not BAD.search(use or '') and not GOVOWN.search(own or '')
stats = {}
if A.code:
    c = json.load(open(A.code)); ce, px = c['ce'], c['px']
    for r in d['r']: r[I['code']] = 0; r[I['vac']] = False; r[I['cases']] = 0
    added = 0
    for pin, a in px.items():
        pin = str(pin).zfill(8)
        if pin in rows: continue
        own, fn, ln, mail, mc, ms, mz, site, sc, sz, ac, impv, landv, use, sale, la, lo = a
        if not ok(own, use, site): continue
        new_row(pin, own, fn, ln, mail, mc, ms, mz, site, ac, impv, landv, sale, la, lo); added += 1
    for pin, x in ce.items():
        r = rows.get(str(pin).zfill(8))
        if r: h, n, z, o, v, last = x; r[I['code']] = 2 if (h > 0 or o) else 1; r[I['vac']] = bool(v); r[I['cases']] = h + n + z
    stats['code_rows_added'] = added
if A.tax:
    t = json.load(open(A.tax)); pt = t['pt']
    for r in d['r']: r[I['tax']] = 0
    added = 0
    for pin, a in pt.items():
        pin = str(pin).zfill(8); amt, own, fn, ln, mail, mc, ms, mz, site, ac, impv, landv, use, sale, la, lo = a
        r = rows.get(pin)
        if not r:
            if not ok(own, use, site): continue
            r = new_row(pin, own, fn, ln, mail, mc, ms, mz, site, ac, impv, landv, sale, la, lo); added += 1
        r[I['tax']] = round(amt or 1, 2)
    stats['tax_rows_added'] = added
# zip for rows without one: nearest row that has a 28xxx zip
pts = sorted((r[I['la']], r[I['lo']], r[I['zip']]) for r in d['r'] if r[I['la']] and re.fullmatch(r'28\d{3}', str(r[I['zip']] or '')))
las = [p[0] for p in pts]
for r in d['r']:
    if not re.fullmatch(r'28\d{3}', str(r[I['zip']] or '')) and r[I['la']]:
        la, lo = r[I['la']], r[I['lo']]; i0 = bisect.bisect_left(las, la - 0.05); i1 = bisect.bisect_right(las, la + 0.05)
        if i1 > i0: r[I['zip']] = min(((p[0] - la) ** 2 + (p[1] - lo) ** 2, p[2]) for p in pts[i0:i1])[1]
# score
for r in d['r']:
    sc = (10 if r[I['estate']] else 0) + (15 if r[I['code']] == 2 else 6 if r[I['code']] else 0) + (10 if r[I['vac']] else 0) + (15 if r[I['tax']] else 0) \
         + (8 if r[I['oos']] else 0) + (4 if r[I['absentee']] else 0) + min(10, int((r[I['held']] or 0) // 5))
    r[I['score']] = max(r[I['score']] or 0, sc)
stats.update(total=len(d['r']), code=sum(1 for r in d['r'] if r[I['code']]), open_or_housing=sum(1 for r in d['r'] if r[I['code']] == 2),
             vacant_note=sum(1 for r in d['r'] if r[I['vac']]), taxes_owed=sum(1 for r in d['r'] if r[I['tax']]))
json.dump(d, open(A.o, 'w'), separators=(',', ':'))
print(json.dumps(stats))
