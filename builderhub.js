// DLG HQ - Targets and Deal matcher (ported from the old DLG Builder Hub page, Nov 2026).
// Mecklenburg and Gaston only. Owner target lists live in the private hub_targets table; parcel, comp and builder-permit data are static files in data/hub/ (same files the Hub used).
// Targets: vacant lots, split parcels (3+ lots) and infill lots (comps + sewer/septic) to mail or call. Read-only, no leads.
// Deal matcher: type an APN (or zip + acres) and see what builders paid nearby, a suggested offer, builders building close by,
// and whose buy box fits. Buy boxes come only from DLG HQ's buyers table. Nothing is written anywhere.
(function () {
  const DATA_V = 1;
  const PAGE = 50;
  const MARKETS = {
    meck: { name: 'Mecklenburg', county: 'Mecklenburg', file: 'Mecklenburg',
      note: 'Split parcels: vacant parcels that cut into 3+ lots by right on the existing road (frontage, flood, creek buffers, slope, public road and setbacks checked), owned by people, churches, heirs or family trusts. Full detail in Split Finder. Vacant lots: Mecklenburg tax records, only in neighborhoods where infill builders are pulling permits (owners with more than 5 lots left out). Infill lots: passed every check and have lot comps nearby. Zip is the neighborhood\'s main zip.',
      salesNote: 'Builder prices are what the builder\'s LLC paid for the lot (county deed records) before its permit. Market sales are lots sold as vacant in the last 24 months; same-day bulk purchases are split per lot.' },
    gas: { name: 'Gaston', county: 'Gaston', file: 'Gaston',
      note: 'Split parcels: vacant parcels that cut into 3+ lots by right on the existing road (frontage, flood, creek buffers, slope, public road and setbacks checked), owned by people, churches, heirs or family trusts. Most Gaston ones are septic areas. Full detail in Split Finder. Vacant lots: Gaston parcel records in zips where infill builders are active (owners with more than 5 lots left out). Infill lots: passed every check and have lot comps nearby.',
      salesNote: 'Builders are the LLCs that owned new homes (built since 2023), so it catches builders even after they sold. Production and build-to-rent groups are filtered out. Lot prices are the recorded sale while the builder still owned it.' },
  };
  const KINDS = [['Vacant', 'Vacant lots'], ['Split', 'Split parcels (3+ lots)'], ['Sewer', 'Infill lots (comps + sewer/septic)']];
  const SORTS = [['high', 'Highest-end areas first'], ['quick', 'Quick ones first'], ['score', 'Best prospects first'], ['land', 'Land value, high to low'], ['held', 'Owned longest'], ['ac', 'Largest lot'], ['comp', 'Flat lots first, then closest comps']];
  const CHECKS = [['abs', 'Absentee owner'], ['oos', 'Out of state'], ['est', 'Heirs / estate'], ['ind', 'Individuals only'], ['old', 'Owned 10+ years']];
  const OCP = { meck: 'MEC', gas: 'GAS' };

  const st = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
  const ss = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };
  const BH = window.BH = { mkt: MARKETS[st('dlg_hub_mkt', 'meck')] ? st('dlg_hub_mkt', 'meck') : 'meck', data: {}, kind: 'Split', page: 0, rows: [], f: {}, buyers: null };

  const css = `.bh .bar{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:flex-end}.bh .bar label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted);flex:0 1 auto}
.bh .bar select,.bh .bar input{width:auto;max-width:100%}.bh .bar input[type=search]{min-width:200px}
.bh .seg{display:flex;flex-wrap:wrap;gap:6px}.bh .ck{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px}.bh .ck label{display:flex;gap:6px;align-items:center;font-size:13px}.bh .ck input{width:auto}
.bh .tw{overflow-x:auto}.bh table.tt{min-width:980px;font-size:13px}.bh table.tt td.n,.bh table.tt th.n{text-align:right}
.bh .ml{color:var(--muted);font-size:12px}.bh .pin{white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
.bh .fl{display:inline-block;font-size:11px;padding:2px 7px;border-radius:999px;background:#f1eff5;color:#4a4458;margin:0 4px 4px 0;font-weight:600}
.bh .fl.good{background:#e6f4ec;color:#1a7a48}.bh .fl.hot{background:#fdeee6;color:#a3400f}
.bh .pg{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:10px}
.bh .boxes{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:10px 0}.bh .boxes>div{background:#faf9fc;border:1px solid var(--line);border-radius:10px;padding:10px}
.bh .boxes .k{font-size:12px;color:var(--muted)}.bh .boxes .v{font-size:20px;font-weight:700}.bh .boxes .v.big{color:var(--brand);font-size:24px}
.bh .mg{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:14px}.bh .mg>.card{margin:0}
.bh .who{border-top:1px solid var(--line);padding:9px 0;display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap}.bh .who:first-of-type{border-top:0}
.bh .who .r{text-align:right;font-size:13px}.bh .fit{font-size:12px;color:#1a7a48;font-weight:600}.bh .warn{font-size:12px;color:#a3400f;font-weight:600}
.bh .mapwrap{position:relative;max-width:420px;margin:0 auto;--pine:#2f6b3a;--flag:#b3261e;--warn:#c98a00}.bh .zmap{display:block;touch-action:none;cursor:grab;border-radius:8px}
.bh .mapbtns{position:absolute;top:6px;right:6px;display:flex;gap:4px}.bh .mapbtns .btn{padding:3px 8px;font-size:12px}
@media(max-width:900px){.bh .mg{grid-template-columns:1fr}}`;
  const addCss = () => { if (document.getElementById('bh-css')) return; const s = document.createElement('style'); s.id = 'bh-css'; s.textContent = css; document.head.appendChild(s); };

  const E = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money0 = n => n ? '$' + Math.round(n).toLocaleString() : '—';
  const med = a => { if (!a.length) return null; a = [...a].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const npin = v => String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const low = s => String(s || '').trim().toLowerCase();
  const tcase = s => /[a-z]/.test(String(s || '')) ? String(s || '') : String(s || '').toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase());
  const miles = (a, b, c, d) => { const R = 3958.8, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r, h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const fmtMi = d => d == null ? '—' : d < 0.1 ? Math.round(d * 5280 / 10) * 10 + ' ft' : d.toFixed(d < 10 ? 2 : 1) + ' mi';
  const gmap = (la, lo) => `https://www.google.com/maps/search/?api=1&query=${la},${lo}`;
  const coKey = s => low(s).replace(/\b(llc|inc|corp|co|company|the|homes|builders|group|construction)\b/g, '').replace(/[^a-z0-9]/g, '');
  const arr = v => Array.isArray(v) ? v : String(v || '').split(/[,;\n\/]+/).map(x => x.trim()).filter(Boolean);
  const cty = s => low(s).replace(/\s+county$/, '').replace(/\s+co\.?$/, '').trim();
  const msg = (html) => `<div class="card muted">${html}</div>`;

  // ---------- data ----------
  async function getJSON(name) { const r = await fetch(`data/hub/${name}_${BH.mkt}.json?v=${DATA_V}`); if (!r.ok) throw new Error(name); return r.json(); }
  function D() { return BH.data[BH.mkt] || (BH.data[BH.mkt] = {}); }
  async function base() { const d = D(); if (!d.Z) { const [Z, CP, B] = await Promise.all([getJSON('zones'), getJSON('comps'), getJSON('builders')]); Object.assign(d, { Z, CP, B }); } return d; }
  async function targets() { const d = await base(); if (!d.T) { const { data: tr, error: te } = await sb.from('hub_targets').select('data').eq('key', 'targets_' + BH.mkt).single(); if (te) throw new Error('targets: ' + te.message); const j = tr.data; d.T = j.r.map(r => Object.fromEntries(j.k.map((k, i) => [k, r[i]]))); } return d; }
  async function pins() { const d = D(); if (!d.P) { d.P = await getJSON('pins'); d.PI = new Map(Object.keys(d.P).map(k => [npin(k), k])); } return d; }
  async function bpts() { const d = D(); if (!d.BP) { try { d.BP = await getJSON('bpts'); } catch (e) { d.BP = {}; } } return d; }
  async function loadBuyers() { const all = []; for (let f = 0; ; f += 1000) { const r = await sb.from('buyers').select('*').order('name').range(f, f + 999); if (r.error) throw r.error; all.push(...(r.data || [])); if (!r.data || r.data.length < 1000) break; } return (BH.buyers = all); }
  const bName = id => { const d = D(); const b = (d.B || []).find(x => x.id === id); return b ? b.name : ((d.Z && d.Z.__names && d.Z.__names[id]) || id); };

  function marketSel(id) { return `<label>Market<select id="${id}">${Object.entries(MARKETS).map(([k, m]) => `<option value="${k}" ${k === BH.mkt ? 'selected' : ''}>${m.name}</option>`).join('')}</select></label>`; }
  function setMarket(m, redraw) { BH.mkt = m; ss('dlg_hub_mkt', m); BH.page = 0; BH.f.zip = ''; BH.f.q = ''; redraw(); }

  // ---------- Targets ----------
  const zipMed = t => { if (t.kind !== 'Vacant') return null; const e = D().Z && D().Z[t.zip]; return e ? (e.lotMed || null) : null; };
  const offerFor = t => { const m = zipMed(t); return m ? Math.round(m * 0.7 / 500) * 500 : null; };
  const isAddr = t => !!t.why && /address/i.test(t.why);
  const isDeep = t => !!(t.estate || t.entity || /\b(ESTATE|EST|HEIRS?|DECEASED|DECD|TRUST|TRUSTEE|TR|LIFE EST)\b/i.test((t.owner || '') + ' ' + (t.nm || '')) || (t.held || 0) >= 40);
  const speedTag = t => isDeep(t) ? '<span class="fl" title="Likely deceased owner, estate, trust or 40+ years owned: plan 20-30 minutes">Deep dive</span>' : '<span class="fl good" title="Living owner, plain name: about 5 minutes">Quick</span>';
  const KC = k => k === 'Vacant' ? 'V' : k === 'Split' ? 'S' : 'W';

  function why(t) {
    const f = [], fl = (c, x, ti) => f.push(`<span class="fl ${c}"${ti ? ` title="${E(ti)}"` : ''}>${E(x)}</span>`);
    if (t.kind === 'Sewer') { const u = t.sewer || ''; fl(/^Utility/.test(u) ? '' : 'good', u.replace(/ \(MLS: .*$/, ''), u); const fs = String(t.flags || '').split('; '); fl('', fs[0], 'Nearest sales: ' + (t.near || '')); fs.slice(1).filter(Boolean).forEach(x => fl('hot', x)); if (t.zoning) fl('', t.zoning + (t.frontage ? ' · ' + t.frontage + ' ft road' : '')); }
    if (t.kind === 'Split') { fl('good', (t.grade || '') + ' · ' + (t.lots || '?') + ' lots'); /^Likely/.test(t.sewer || '') ? fl('good', 'Sewer likely') : fl('', 'Septic area'); String(t.flags || '').split('; ').filter(Boolean).forEach(x => fl('hot', x)); if (t.sub) fl('', 'Platted lot'); }
    if (t.tax > 0) fl('hot', 'Taxes owed' + (t.tax > 1 ? ' ' + money0(t.tax) : ''));
    if (t.code > 0) fl('hot', (t.code > 1 ? 'Open / housing code case' : 'Code case') + (t.cases > 1 ? ' (' + t.cases + ' since 2023)' : ''));
    if (t.vac) fl('hot', 'Vacant (city inspector)');
    if (t.why) fl('hot', 'Skip trace: ' + t.why);
    if (t.estate) fl('hot', 'Heirs / estate');
    if (t.oos) fl('hot', 'Out of state'); else if (t.absentee) fl('', 'Absentee');
    if ((t.held || 0) >= 20) fl('', 'Owned ' + Math.round(t.held) + ' yrs'); else if ((t.held || 0) >= 10) fl('', 'Owned 10+ yrs');
    if (t.entity) fl('', 'Company owner');
    return f.join('');
  }

  function filt() {
    const d = D(), z = BH.f.zip || '', q = low(BH.f.q), c = BH.f;
    const L = d.T.filter(t => t.kind === BH.kind && (!z || t.zip === z) && (!c.ind || !t.entity) && (!c.abs || t.absentee) && (!c.oos || t.oos) && (!c.est || t.estate) && (!c.old || (t.held || 0) >= 10)
      && !t.rb && !t.bf && !isAddr(t)
      && (!q || (t.owner + ' ' + (t.nm || '') + ' ' + t.site + ' ' + t.city + ' ' + t.pin + ' ' + OCP[BH.mkt] + KC(t.kind) + npin(t.pin)).toLowerCase().includes(q) || npin(t.pin) === npin(q)));
    const s = BH.f.sort || 'high', zb = t => zipMed(t) || 0;
    L.sort(s === 'quick' ? (a, b) => (isDeep(a) - isDeep(b)) || zb(b) - zb(a) || b.land - a.land : s === 'high' ? (a, b) => zb(b) - zb(a) || b.land - a.land : s === 'land' ? (a, b) => b.land - a.land
      : s === 'held' ? (a, b) => (b.held || 0) - (a.held || 0) : s === 'ac' ? (a, b) => (b.ac || 0) - (a.ac || 0)
      : s === 'comp' ? (a, b) => ((a.sl ?? 99) <= 5 ? 0 : (a.sl ?? 99) <= 10 ? 1 : 2) - ((b.sl ?? 99) <= 5 ? 0 : (b.sl ?? 99) <= 10 ? 1 : 2) || (a.cd ?? 9) - (b.cd ?? 9) : (a, b) => b.score - a.score || b.land - a.land);
    return L;
  }

  function zipBox(z) {
    const e = D().Z[z]; if (!e) return '';
    const bs = (e.builders || []).slice(0, 10).map(bName);
    return `<div class="card"><h3 class="sec">What builders pay in ${E(z)} ${E(e.city)}</h3><div class="boxes">
      <div><div class="k">Vacant lot sales (median)</div><div class="v">${money0(e.lotMed)}</div><div class="small muted">${e.lotN || 0} sales, last 24 mo</div></div>
      <div><div class="k">Teardown purchases (median)</div><div class="v">${money0(e.tearMed)}</div><div class="small muted">${e.tearN || 0} purchases</div></div>
      <div><div class="k">Builder lot size</div><div class="v">${e.acMed ? e.acMed + ' ac' : '—'}</div><div class="small muted">${e.acMin != null ? e.acMin + '–' + e.acMax + ' ac range' : ''}</div></div>
      <div><div class="k">Typical build value</div><div class="v">${money0(e.build)}</div><div class="small muted">${e.permits || 0} builder permits</div></div></div>
      <div class="small"><b>Builders buying here:</b> ${bs.map(E).join(' · ') || '—'}</div></div>`;
  }

  window.vHubTargets = async function () {
    addCss();
    $('actions').innerHTML = `<button class="btn" id="bh_dl">Download this list</button>`;
    $('view').innerHTML = `<div class="bh"><div class="card"><div class="bar">${marketSel('bh_mkt')}<div class="seg" id="bh_seg"></div></div>
      <div class="bar" style="margin-top:10px"><label id="bh_zipw">Zip<select id="bh_zip"></select></label>
      <label>Sort<select id="bh_sort">${SORTS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label>Search<input id="bh_q" type="search" placeholder="Owner, street or APN"></label></div>
      <div class="ck">${CHECKS.map(([k, l]) => `<label><input type="checkbox" data-ck="${k}"> ${l}</label>`).join('')}</div>
      <div class="small muted" style="margin-top:8px">Each box you check narrows the list. Owners with a bad mailing address, recent buyers (under 2 years) and flood-zone lots are already left out.</div></div>
      <div id="bh_zipbox"></div><div class="card"><div class="pg"><span id="bh_cnt" class="small muted">Loading…</span><span><button class="btn ghost sm" id="bh_prev">Previous</button> <span id="bh_pgn" class="small muted"></span> <button class="btn ghost sm" id="bh_next">Next</button></span></div>
      <div class="tw"><table class="tt"><thead><tr><th>Property</th><th>Owner &amp; mailing address</th><th class="n">Acres</th><th class="n">Land value · offer</th><th class="n">Built</th><th class="n">Owned</th><th>Why it's a prospect</th><th>Builders buying here</th><th></th></tr></thead><tbody id="bh_body"></tbody></table></div>
      <p class="small muted" id="bh_note"></p></div></div>`;
    $('bh_mkt').onchange = e => setMarket(e.target.value, vHubTargets);
    try { await targets(); } catch (e) { $('bh_cnt').textContent = 'Couldn\'t load the target lists. Reload the page.'; return; }
    const T = D().T;
    $('bh_seg').innerHTML = KINDS.map(([k, l]) => `<button class="btn ${k === BH.kind ? '' : 'ghost'} sm" data-k="${k}">${l} <span class="small">(${T.filter(t => t.kind === k).length.toLocaleString()})</span></button>`).join('');
    $('bh_seg').querySelectorAll('[data-k]').forEach(b => b.onclick = () => { BH.kind = b.dataset.k; BH.f.zip = ''; if (BH.kind === 'Sewer') BH.f.sort = 'comp'; BH.page = 0; vHubTargets(); });
    $('bh_note').textContent = MARKETS[BH.mkt].note;
    const zs = [...new Set(T.filter(t => t.kind === BH.kind).map(t => t.zip))].filter(Boolean).sort();
    $('bh_zipw').style.display = zs.length ? '' : 'none';
    $('bh_zip').innerHTML = '<option value="">All zips</option>' + zs.map(z => `<option value="${z}">${z} · ${E(D().Z[z]?.city || '')}</option>`).join('');
    $('bh_zip').value = zs.includes(BH.f.zip) ? BH.f.zip : ''; BH.f.zip = $('bh_zip').value;
    $('bh_sort').value = BH.f.sort || 'high'; $('bh_q').value = BH.f.q || '';
    document.querySelectorAll('.bh [data-ck]').forEach(x => { x.checked = !!BH.f[x.dataset.ck]; x.onchange = () => { BH.f[x.dataset.ck] = x.checked; draw(true); }; });
    $('bh_zip').onchange = e => { BH.f.zip = e.target.value; draw(true); };
    $('bh_sort').onchange = e => { BH.f.sort = e.target.value; draw(true); };
    $('bh_q').oninput = e => { BH.f.q = e.target.value; draw(true); };
    $('bh_prev').onclick = () => { BH.page--; draw(); }; $('bh_next').onclick = () => { BH.page++; draw(); };
    $('bh_dl').onclick = download;
    draw();
  };

  function draw(reset) {
    if (reset) BH.page = 0;
    const d = D(), rows = BH.rows = filt(), z = BH.f.zip;
    $('bh_zipbox').innerHTML = z ? zipBox(z) : '';
    const pages = Math.max(1, Math.ceil(rows.length / PAGE)); BH.page = Math.max(0, Math.min(BH.page, pages - 1));
    $('bh_cnt').textContent = `${rows.length.toLocaleString()} ${BH.kind === 'Vacant' ? 'vacant lots' : BH.kind === 'Split' ? 'split parcels (3+ lots, checks passed)' : 'infill lots that passed every check, with lot comps nearby'}${z ? ' in ' + z : ''}`;
    $('bh_pgn').textContent = `Page ${BH.page + 1} of ${pages}`; $('bh_prev').disabled = BH.page === 0; $('bh_next').disabled = BH.page >= pages - 1;
    $('bh_body').innerHTML = rows.slice(BH.page * PAGE, BH.page * PAGE + PAGE).map(t => {
      const e = d.Z[t.zip] || {}, bs = (e.builders || []).slice(0, 3).map(bName), of = offerFor(t);
      const val = t.kind === 'Split' ? `${t.lots} lots · ${t.frontage || '?'} ft road · most you can pay ${money0(t.offer)}` : t.kind === 'Sewer' ? `comps median ${money0(t.pad)}<br>nearest ${t.cd != null ? t.cd + ' mi' : ''}: ${E(String(t.near || '').split('; ')[0])}` : (t.bldg ? money0(t.bldg) + ' bldg' : 'no building');
      return `<tr><td><b>${E(t.site || '(no street address)')}</b><br>${E(t.city)} ${E(t.zip || '')}<br><span class="pin">APN ${E(t.pin)}</span></td>
        <td>${speedTag(t)} ${E(t.nm || t.owner)}<br><span class="ml">${E([t.m1, t.m2, t.m3].filter(Boolean).join(', '))}</span></td>
        <td class="n">${t.ac ?? '—'}</td><td class="n">${money0(t.land)}<br><span class="ml">${val}</span>${of ? `<br><span class="fl" title="70% of the median price builders paid for lots in this zip">Suggested offer ${money0(of)}</span>` : ''}</td>
        <td class="n">${t.yb || '—'}</td><td class="n">${t.held != null ? Math.round(t.held) + ' yrs' : '—'}</td><td>${why(t)}</td>
        <td class="small">${t.kind === 'Split' ? E(String(t.buyers || '').split(', ').slice(0, 3).join(' · ')) : bs.map(E).join('<br>')}</td>
        <td><button class="btn ghost sm" data-m="${E(t.pin)}">Match</button></td></tr>`;
    }).join('') || '<tr><td colspan="9" class="muted">No parcels match these filters.</td></tr>';
    $('bh_body').querySelectorAll('[data-m]').forEach(b => b.onclick = () => { BH.matchPin = b.dataset.m; go('match'); });
  }

  function download() {
    const rows = BH.rows || []; if (!rows.length) return toast('Nothing to download');
    const usd = n => n == null || n === '' ? '' : '$' + Math.round(n).toLocaleString('en-US');
    const H = ['OfferCode', 'SuggestedOffer', 'SplitLots', 'MostICanPay', 'SplitGrade', 'SplitFlags', 'Sewer', 'BuyersWhoFit', 'Zoning', 'FrontageFt', 'ZipMedianBuilderPrice', 'FirstName', 'LastName', 'MailingName', 'Greeting', 'MailAddress', 'MailCity', 'MailState', 'MailZip', 'PropertyAddress', 'PropertyCity', 'PropertyState', 'PropertyZip', 'APN', 'PropertiesOwned', 'OtherAPNs', 'Acres', 'LandValue', 'BuildingValue', 'YearsOwned', 'Absentee', 'OutOfState', 'HeirsEstate', 'TaxesOwed', 'CodeCase', 'Priority', 'ListType', 'ListAction', 'DeepDiveReason', 'BuildabilityFlag', 'OwnerOnRecord'];
    const G = new Map(); for (const t of rows) { const k = (!t.why && t.mk) ? t.mk : ('P|' + t.pin); if (!G.has(k)) G.set(k, []); G.get(k).push(t); }
    const out = [H].concat([...G.values()].map(g => { const t = g[0]; return [OCP[BH.mkt] + KC(t.kind) + npin(t.pin), usd(offerFor(t)), t.lots ?? '', usd(t.offer), t.grade || '', t.flags || '', t.sewer || '', t.buyers || '', t.zoning || '', t.frontage ?? '', usd(zipMed(t)), t.fn || '', t.ln || '', t.mn || t.nm || String(t.owner || '').trim(), t.gr || 'Property Owner', t.ma ?? t.m1, t.mc || '', t.ms || '', t.mz || '', t.site, t.city, 'NC', t.zip || '', t.pin, g.length, g.slice(1).map(x => x.pin).join(' '), t.ac, usd(t.land), usd(t.bldg), t.held ?? '', t.absentee ? 'Yes' : 'No', t.oos ? 'Yes' : 'No', t.estate ? 'Yes' : 'No', t.tax > 0 ? (t.tax > 1 ? usd(t.tax) : 'Yes') : 'No', t.code > 1 ? 'Open / housing' : t.code > 0 ? 'Yes' : 'No', t.score, t.kind === 'Vacant' ? 'Vacant lot' : t.kind === 'Split' ? 'Split parcel' : 'Infill lot', t.act || 'Mail', t.why || '', t.bf || '', String(t.owner || '').trim()]; }));
    const z = BH.f.zip, today = new Date().toISOString().slice(0, 10);
    dlCSV(`${MARKETS[BH.mkt].file}_${BH.kind === 'Vacant' ? 'Vacant_Lots' : BH.kind === 'Split' ? 'Split_Parcels' : 'Infill_Lots'}${z ? '_' + z : ''}_${today}.csv`, out);
  }

  // ---------- Deal matcher ----------
  function pinCands(v) {
    const raw = String(v || '').trim().toUpperCase(), n = npin(raw), out = [n];
    if (/^\d{5,7}$/.test(n)) out.push(n.padStart(8, '0')); // Mecklenburg APNs are 8 digits
    const c = raw.match(/^(MEC|GAS)[VSW]([0-9A-Z]+)$/); if (c) out.push(c[2]); // offer code -> APN
    return [...new Set(out.filter(Boolean))];
  }
  async function findPin(input) {
    const d = await targets();
    for (const pin of pinCands(input)) {
      const t = d.T.find(x => npin(x.pin) === pin);
      if (t) { const r = { pin: t.pin, addr: t.site, city: t.city, zip: t.zip, ac: t.ac, kind: 'Vacant', list: t.kind, land: t.land, bldg: t.bldg, yb: t.yb, owner: t.owner, la: t.la, lo: t.lo, sewer: t.sewer, zon: t.zoning };
        if (!r.zip) { const p = await pins(); const k = p.PI.get(pin); if (k) r.zip = p.P[k][2]; } return r; }
      const c = d.CP.find(x => npin(x.pin) === pin);
      if (c) return { pin: c.pin, addr: c.addr, city: c.city, zip: c.zip, ac: c.ac, kind: c.kind, zon: c.zon, la: c.la, lo: c.lo };
    }
    const p = await pins();
    for (const pin of pinCands(input)) { const k = p.PI.get(pin); if (k) { const r = p.P[k]; return { pin: k, addr: r[0], city: r[1], zip: r[2], ac: r[3], zon: r[4], land: r[5], kind: r[6] ? 'Teardown' : 'Vacant', yb: r[7], la: r[8], lo: r[9] }; } }
    return null;
  }
  const lotUtil = s => { s = String(s || ''); return /^Sewer\/septic mixed/i.test(s) ? 'mixed' : /^(Sewer|Likely)/i.test(s) ? 'sewer' : /^(Septic|Unlikely)/i.test(s) ? 'septic' : ''; };
  function utilNote(b, u) {
    const t = low(arr(b.utilities).join(', ')); if (!u || !t) return null;
    const septicOk = /septic/.test(t) && !/no septic/.test(t);
    if (u === 'sewer') return { ok: true, t: 'Lot looks to be on sewer' };
    if (u === 'septic') return septicOk ? { ok: true, t: 'Septic is OK for them' } : { ok: false, t: 'They want public sewer; this lot looks like septic' };
    return septicOk ? { ok: true, t: 'Septic is OK for them (area is mixed sewer/septic)' } : { ok: false, t: 'They want public sewer; area is mixed sewer/septic, confirm first' };
  }
  // Same matching style as Buyers > "Who buys here?": zip first, then city, then county. A zip they say to avoid knocks them out.
  function buyersFor(p) {
    const zip = p.zip || '', c = /\bco\.?$/i.test(p.city || '') ? '' : low(p.city), k = cty(MARKETS[BH.mkt].county), u = lotUtil(p.sewer);
    return (BH.buyers || []).map(b => {
      const avoid = [...arr(b.avoid).join(' ').matchAll(/\b\d{5}\b/g), ...String(b.deal_breakers || '').matchAll(/\b\d{5}\b/g)].map(m => m[0]);
      if (zip && avoid.includes(zip)) return null;
      const byZip = zip && arr(b.zips).map(z => String(z).trim()).includes(zip);
      const byCity = c && arr(b.cities).map(low).some(s => s === c || (s.length >= 4 && (s.includes(c) || c.includes(s))));
      const byCounty = k && arr(b.counties).map(cty).includes(k);
      if (!(byZip || byCity || byCounty)) return null;
      return { b, rank: byZip ? 0 : byCity ? 1 : 2, why: byZip ? 'Buys in ' + zip : byCity ? 'Buys in ' + tcase(p.city) : 'Buys in ' + MARKETS[BH.mkt].county + ' County', util: utilNote(b, u) };
    }).filter(Boolean).sort((a, b) => a.rank - b.rank || (!!b.b.bb_submitted_at) - (!!a.b.bb_submitted_at) || String(a.b.name || '').localeCompare(String(b.b.name || '')));
  }
  function buyerHit(name) { const k = coKey(name); if (k.length < 4) return null; return (BH.buyers || []).find(b => coKey(b.company) === k || coKey(b.name) === k) || null; }

  window.vHubMatch = async function () {
    addCss();
    $('view').innerHTML = `<div class="bh"><div class="card"><form id="bh_mf" class="bar" autocomplete="off">${marketSel('bh_mmkt')}
      <label>Parcel number (APN)<input id="bh_pin" placeholder="${BH.mkt === 'gas' ? 'e.g. 3546-72-8889' : 'e.g. 07719608'}"></label><button class="btn" type="submit">Match</button>
      <span class="small muted" style="align-self:center">or enter it yourself:</span>
      <label>Zip<select id="bh_mzip"><option value=""></option></select></label><label>Acres<input id="bh_ac" type="number" step="0.01" min="0" placeholder="0.25" style="width:90px"></label>
      <label>Type<select id="bh_kind"><option>Vacant</option><option>Teardown</option></select></label>
      <label>Search within<select id="bh_rad"><option value="0.5">½ mile</option><option value="1" selected>1 mile</option><option value="2">2 miles</option><option value="3">3 miles</option><option value="5">5 miles</option><option value="zip">Same zip only</option></select></label>
      <label>Your offer at (% of builder price)<input id="bh_pct" type="number" min="30" max="100" value="70" style="width:80px"></label></form></div>
      <div id="bh_mout">${msg('<b>Type a parcel number.</b> You\'ll see what builders paid for similar lots nearby, a suggested offer, builders building close by, and whose buy box fits.')}</div></div>`;
    $('bh_mmkt').onchange = e => { BH.matchPin = ''; setMarket(e.target.value, vHubMatch); };
    $('bh_mf').onsubmit = e => { e.preventDefault(); runMatch(); };
    ['bh_mzip', 'bh_kind'].forEach(id => $(id).onchange = () => { if (id === 'bh_mzip') $('bh_pin').value = ''; runMatch(); });
    ['bh_rad', 'bh_pct', 'bh_ac'].forEach(id => $(id).onchange = () => { if ($('bh_mout').querySelector('.mg')) runMatch(); });
    try { await base(); } catch (e) { $('bh_mout').innerHTML = msg('Couldn\'t load comps. Reload the page.'); return; }
    const Z = D().Z; $('bh_mzip').innerHTML = '<option value=""></option>' + Object.keys(Z).filter(k => !k.startsWith('__')).sort().map(z => `<option value="${z}">${z} · ${E(Z[z].city)}</option>`).join('');
    loadBuyers().catch(e => { BH.buyersErr = e.message || String(e); });
    if (BH.matchPin) { $('bh_pin').value = BH.matchPin; BH.matchPin = ''; runMatch(); }
  };

  async function runMatch() {
    const out = $('bh_mout'), d = await base(), Z = d.Z, pinRaw = $('bh_pin').value.trim();
    let p = null;
    if (pinRaw) {
      out.innerHTML = msg('Looking up parcel…');
      p = await findPin(pinRaw);
      if (!p) { out.innerHTML = msg(`<b>Parcel ${E(pinRaw)} isn't in the ${MARKETS[BH.mkt].name} data.</b> Check the market at the top, or pick its zip, acres and type and press Match.`); return; }
      if (p.zip && Z[p.zip]) $('bh_mzip').value = p.zip; if (p.ac) $('bh_ac').value = p.ac; $('bh_kind').value = p.kind;
    } else {
      const z = $('bh_mzip').value; if (!z) { out.innerHTML = msg('<b>Enter a parcel number</b>, or pick a zip and acres.'); return; }
      p = { pin: '', addr: '', city: Z[z]?.city || '', zip: z, ac: parseFloat($('bh_ac').value) || null, kind: $('bh_kind').value, manual: true };
    }
    p.kind = $('bh_kind').value; p.ac = parseFloat($('bh_ac').value) || p.ac;
    const pct = Math.min(100, Math.max(30, parseFloat($('bh_pct').value) || 70)) / 100;
    const geo = p.la != null && p.lo != null, rSel = $('bh_rad').value; let R = geo && rSel !== 'zip' ? parseFloat(rSel) : null;
    const withD = d.CP.map(c => ({ ...c, d: geo && c.la != null ? miles(p.la, p.lo, c.la, c.lo) : null }));
    let autoNote = '';
    if (R) { const same = withD.filter(c => c.kind === p.kind && c.pin !== p.pin && c.d != null), asked = R;
      for (const r of [R, ...[0.5, 1, 2, 3, 5, 10].filter(x => x > R)]) { R = r; if (same.filter(c => c.d <= r).length >= 3) break; }
      if (R !== asked) autoNote = `No ${p.kind === 'Vacant' ? 'lot sales' : 'teardown purchases'} within ${asked} mi, so this widened to ${R} mi on its own.`; }
    const inArea = c => R ? (c.d != null && c.d <= R) : c.zip === p.zip, areaTxt = R ? `within ${R} mi` : `in ${p.zip || 'this zip'}`;
    let C = withD.filter(c => inArea(c) && c.kind === p.kind && c.pin !== p.pin), widened = '';
    if (p.ac) { const nb = C.filter(c => c.ac && c.ac >= p.ac * 0.5 && c.ac <= p.ac * 1.75); if (nb.length >= 3) C = nb; else widened = `Few sales at this size ${areaTxt}, so all lot sizes are shown.`; }
    if (C.length < 2 && p.kind === 'Teardown') { const v = withD.filter(c => inArea(c) && c.kind === 'Vacant' && c.pin !== p.pin); if (v.length) { C = C.concat(v); widened = `Few teardown purchases ${areaTxt}, so vacant lot sales are included.`; } }
    if (autoNote) widened = autoNote + (widened ? ' ' + widened : '');
    if (R && C.length < 3) widened += (widened ? ' ' : '') + `Only ${C.length} sale${C.length === 1 ? '' : 's'} ${areaTxt}. Try a bigger radius above.`;
    C.sort(geo ? ((a, b) => (a.d ?? 99) - (b.d ?? 99)) : ((a, b) => b.date.localeCompare(a.date)));
    const prices = C.map(c => c.price), m = med(prices), lo = prices.length ? Math.min(...prices) : null, hi = prices.length ? Math.max(...prices) : null;
    const ppa = C.filter(c => c.ac > 0).map(c => c.price / c.ac), est = p.ac && ppa.length >= 3 ? med(ppa) * p.ac : null;
    let rings = '';
    if (geo) { const same = withD.filter(c => c.kind === p.kind && c.pin !== p.pin && c.d != null);
      rings = `<div class="boxes">${[0.25, 0.5, 1, 2].map(r => { const n = same.filter(c => c.d <= r), mm = med(n.map(c => c.price)); return `<div><div class="k">${p.kind === 'Vacant' ? 'Lot sales' : 'Teardown buys'} within ${r === 0.25 ? '¼' : r === 0.5 ? '½' : r} mi</div><div class="v">${n.length}</div><div class="small muted">${mm ? 'median ' + money0(mm) : 'no sales'}</div></div>`; }).join('')}</div>`; }
    // builders building closest (permit locations), else the zip's builder list
    let bl = [], bmode = 'zip';
    if (geo) { const BP = (await bpts()).BP, RR = R || 1;
      bl = d.B.map(b => { const pts = (BP[b.id] || []).filter(q => q[0] != null).map(q => ({ la: q[0], lo: q[1], dt: q[2] || '', d: miles(p.la, p.lo, q[0], q[1]) })); if (!pts.length) return null;
        const near = Math.min(...pts.map(q => q.d)); return { ...b, pts, near, n1: pts.filter(q => q.d <= 1).length }; }).filter(Boolean).sort((a, b) => a.near - b.near).filter(b => b.near <= Math.max(RR, 3)).slice(0, 10);
      bmode = 'dist'; }
    if (!bl.length) { const e = Z[p.zip] || {}; bl = (e.builders || []).map(id => d.B.find(b => b.id === id)).filter(Boolean).slice(0, 8); bmode = 'zip'; }
    const mapR = R || (geo ? 1 : null);
    const tags = [p.list === 'Split' ? 'Split parcel' : p.list === 'Sewer' ? 'Infill lot' : p.kind, (p.city || '') + ' ' + (p.zip || ''), p.ac ? p.ac + ' ac' : '', p.land ? 'Land value ' + money0(p.land) : '', p.yb ? 'Built ' + p.yb : '', p.zon ? 'Zoning ' + p.zon : '', p.sewer ? String(p.sewer).replace(/ \(MLS: .*$/, '') : '', p.owner || ''].filter(x => String(x).trim());
    out.innerHTML = `<div class="mg"><div class="card">
      <div class="small muted">${p.manual ? 'Manual entry' : 'APN ' + E(p.pin)}</div><h2 style="margin:2px 0 6px">${E(p.addr || 'Lot in ' + p.zip)}</h2>
      <div>${tags.map(t => `<span class="pill" style="margin:0 4px 4px 0">${E(t)}</span>`).join('')}${geo ? `<a class="pill" href="${gmap(p.la, p.lo)}" target="_blank" rel="noopener">Open in Google Maps</a>` : ''}</div>
      <div class="boxes"><div><div class="k">Similar lots sold for (median)</div><div class="v">${money0(m)}</div><div class="small muted">${C.length} sales ${areaTxt}${lo ? ', ' + money0(lo) + '–' + money0(hi) : ''}</div></div>
        ${est ? `<div><div class="k">At this lot size</div><div class="v">${money0(est)}</div><div class="small muted">median price per acre × ${p.ac} ac</div></div>` : ''}
        <div><div class="k">Your offer at ${Math.round(pct * 100)}%</div><div class="v big">${m ? money0(m * pct) : '—'}</div><div class="small muted">${m ? money0(m * (pct - 0.1)) + '–' + money0(m * pct) + ' range' : 'no sales to compare'}</div></div></div>
      ${rings}${widened ? `<p class="small muted">${E(widened)}</p>` : ''}${geo ? '' : '<p class="small muted">This parcel has no map location in the data, so sales are matched by zip instead of distance.</p>'}
      <h3 class="sec">Recent sales ${areaTxt}${geo ? ', closest first' : ''}</h3>
      <div class="tw"><table class="tt" style="min-width:600px"><thead><tr>${geo ? '<th class="n">Distance</th>' : ''}<th>Date</th><th>Address</th><th class="n">Acres</th><th class="n">Price</th><th>Type</th><th>Builder</th></tr></thead><tbody>
      ${C.slice(0, 25).map(c => `<tr>${geo ? `<td class="n">${fmtMi(c.d)}</td>` : ''}<td>${E(c.date)}</td><td>${c.la != null ? `<a href="${gmap(c.la, c.lo)}" target="_blank" rel="noopener">${E(c.addr)}</a>` : E(c.addr)}<br><span class="pin">${E(c.pin)}${c.zon ? ' · ' + E(c.zon) : ''}</span></td><td class="n">${c.ac ?? '—'}</td><td class="n">${money0(c.price)}</td><td>${E(c.kind)}</td><td>${c.b ? '<b>' + E(bName(c.b)) + '</b>' : '<span class="ml">—</span>'}</td></tr>`).join('') || `<tr><td colspan="${geo ? 7 : 6}" class="muted">No recorded sales ${areaTxt} in the last 24 months.</td></tr>`}
      </tbody></table></div><p class="small muted">${E(MARKETS[BH.mkt].salesNote)}</p></div>
      <div><div class="card" id="bh_bb"><h3 class="sec">Whose buy box fits</h3><div class="muted small">Loading buyers…</div></div>
      ${geo ? `<div class="card"><h3 class="sec">Map · ${mapR} mi around the lot</h3>${mapSVG(p, C, bl, mapR)}</div>` : ''}
      <div class="card"><h3 class="sec">${bmode === 'dist' ? 'Builders building closest to this lot' : 'Builders active in ' + E(p.zip)}</h3>
      ${bl.map(b => { const h = buyerHit(b.name); const ph = h?.phone || b.phone, em = h?.email || String(b.email || '').split(';')[0].trim();
        return `<div class="who"><div><b>${E(b.name)}</b><br><span class="small muted">${bmode === 'dist' ? `<b>Nearest build ${fmtMi(b.near)}</b> · ${b.n1} within 1 mi · ` : ''}${E(b.tier || '')} · ${b.infill || 0} infill permits${h ? ' · in your Buyers' : ''}</span></div>
        <div class="r">${ph ? `<a href="tel:${E(ph)}">${E(ph)}</a><br>` : ''}${em ? `<a href="mailto:${E(em)}">${E(em)}</a>` : '<span class="muted small">No contact on file</span>'}</div></div>`; }).join('') || '<p class="muted small">No builders have permits near this lot yet.</p>'}</div></div></div>`;
    wireMap(out);
    drawBuyers(p);
  }

  async function drawBuyers(p) {
    const el = $('bh_bb'); if (!el) return;
    try { if (!BH.buyers) await loadBuyers(); } catch (e) { el.innerHTML = '<h3 class="sec">Whose buy box fits</h3><div class="muted small">Couldn\'t load buyers: ' + E(e.message || e) + '</div>'; return; }
    if (!$('bh_bb')) return;
    const F = buyersFor(p), withBox = F.filter(x => x.b.bb_submitted_at).length;
    const ph = [...new Set(F.map(x => String(x.b.phone || '').trim()).filter(Boolean))], em = [...new Set(F.map(x => String(x.b.email || '').split(/[;,\s]+/)[0]).filter(Boolean))];
    el.innerHTML = `<h3 class="sec">Whose buy box fits (${F.length})</h3>
      ${F.length ? `<div class="small muted" style="margin-bottom:6px">${withBox} filled out your buy-box form · ${F.length - withBox} listed for this area without one. Zip matches first, then city, then county.</div>
      <div class="row" style="gap:6px;margin-bottom:6px">${em.length ? `<button class="btn ghost sm" style="flex:0 0 auto" data-cp="${E(em.join(', '))}">Copy ${em.length} email${em.length > 1 ? 's' : ''}</button>` : ''}${ph.length ? `<button class="btn ghost sm" style="flex:0 0 auto" data-cp="${E(ph.join(', '))}">Copy ${ph.length} phone${ph.length > 1 ? 's' : ''}</button>` : ''}</div>` : ''}
      ${F.map(({ b, why, util }) => `<div class="who"><div><b>${E(b.name || b.company || '(no name)')}</b>${b.company && b.company !== b.name ? ` · ${E(b.company)}` : ''}${b.kind === 'agent' ? ' <span class="pill">agent</span>' : ''}
        <br><span class="fit">${E(why)}</span>${util ? `<br><span class="${util.ok ? 'fit' : 'warn'}">${E(util.t)}</span>` : ''}<br><span class="small muted">${b.bb_submitted_at ? 'Buy box filled out ' + fmtDate(b.bb_submitted_at) : 'No buy-box form yet'}</span></div>
        <div class="r">${b.phone ? `<a href="tel:${E(b.phone)}">${E(b.phone)}</a><br>` : ''}${b.email ? `<a href="mailto:${E(String(b.email).split(/[;,\s]+/)[0])}">${E(String(b.email).split(/[;,\s]+/)[0])}</a>` : ''}</div></div>`).join('')
      || `<p class="muted small">No buyer in DLG HQ covers ${E(p.zip || '')}${p.city ? ', ' + E(tcase(p.city)) : ''} or ${MARKETS[BH.mkt].county} County yet. Call the builders below.</p>`}`;
    el.querySelectorAll('[data-cp]').forEach(x => x.onclick = () => { navigator.clipboard.writeText(x.dataset.cp); toast('Copied'); });
  }

  // ---------- map (same as the Hub's) ----------
  function mapSVG(p, C, B, R) {
    const S = 320, c = S / 2, pad = 14, sc = (c - pad) / R, kx = Math.cos(p.la * Math.PI / 180) * 69.17, ky = 69.0;
    const xy = (la, lo) => [c + (lo - p.lo) * kx * sc, c - (la - p.la) * ky * sc];
    let s = `<div class="mapwrap"><div class="mapbtns"><button type="button" class="btn ghost" data-z="in">+</button><button type="button" class="btn ghost" data-z="out">−</button><button type="button" class="btn ghost" data-z="reset">Reset</button></div><svg class="zmap" viewBox="0 0 ${S} ${S}" width="100%" role="img" aria-label="Map of sales and builder activity within ${R} miles">`;
    s += `<rect x="0" y="0" width="${S}" height="${S}" fill="#eef3ee" rx="8"/>`;
    for (const r of [0.25, 0.5, 1, 2, 3, 5].filter(r => r <= R + 1e-9)) s += `<circle cx="${c}" cy="${c}" r="${r * sc}" fill="none" stroke="#cfd6cf" stroke-width="1.2" stroke-dasharray="${r === R ? '0' : '3 3'}"/><text x="${c + r * sc * 0.7071 + 3}" y="${c - r * sc * 0.7071 - 3}" font-size="10" fill="#6e6880">${r < 1 ? (r === 0.25 ? '¼' : '½') : r} mi</text>`;
    for (const b of B) for (const q of (b.pts || [])) { if (q.d > R) continue; const [x, y] = xy(q.la, q.lo); s += `<rect class="bp" x="${x - 3.5}" y="${y - 3.5}" width="7" height="7" fill="none" stroke="var(--warn)" stroke-width="1.6"><title>${E(b.name)} built here${q.dt ? ' (' + q.dt.slice(0, 7) + ')' : ''} · ${fmtMi(q.d)}</title></rect>`; }
    for (const k of C) { if (k.d == null || k.d > R) continue; const [x, y] = xy(k.la, k.lo); s += `<circle class="dot" data-i="${E(tcase(k.addr) + ' · ' + money0(k.price) + ' · ' + k.date + ' · ' + fmtMi(k.d) + ' away' + (k.b ? ' · ' + bName(k.b) : ''))}" cx="${x}" cy="${y}" r="5" fill="${k.kind === 'Teardown' ? 'var(--flag)' : 'var(--pine)'}" stroke="#fff" stroke-width="1.2"><title>${E(k.addr)} · ${money0(k.price)} · ${E(k.date)} · ${fmtMi(k.d)}</title></circle>`; }
    s += `<path class="star" d="M${c} ${c - 9} L${c + 2.6} ${c - 3} L${c + 9} ${c - 3} L${c + 4} ${c + 1.5} L${c + 6} ${c + 8} L${c} ${c + 4} L${c - 6} ${c + 8} L${c - 4} ${c + 1.5} L${c - 9} ${c - 3} L${c - 2.6} ${c - 3} Z" fill="#231b30" stroke="#fff" stroke-width="1.2"><title>Your lot</title></path></svg></div>`;
    s += `<div class="small muted mapinfo" style="text-align:center;margin-top:4px">Tap a dot for the sale. Scroll or use + / − to zoom, drag to move.</div><div class="small muted" style="display:flex;flex-wrap:wrap;gap:4px 14px;justify-content:center;margin-top:4px"><span><b style="color:#231b30">★</b> your lot</span><span><b style="color:#2f6b3a">●</b> vacant lot sale</span><span><b style="color:#b3261e">●</b> teardown purchase</span><span><b style="color:#c98a00">□</b> builder new build</span></div>`;
    return s;
  }
  function wireMap(root) {
    const svg = root.querySelector('.zmap'); if (!svg) return; const S = 320; let vb = { x: 0, y: 0, w: S };
    const set = () => { svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.w}`); const k = vb.w / S;
      svg.querySelectorAll('circle.dot').forEach(c => { c.setAttribute('r', 5 * k); c.setAttribute('stroke-width', 1.2 * k); });
      svg.querySelectorAll('rect.bp').forEach(r => { const cx = +r.getAttribute('x') + +r.getAttribute('width') / 2, cy = +r.getAttribute('y') + +r.getAttribute('height') / 2, w = 7 * k; r.setAttribute('x', cx - w / 2); r.setAttribute('y', cy - w / 2); r.setAttribute('width', w); r.setAttribute('height', w); r.setAttribute('stroke-width', 1.6 * k); });
      svg.querySelectorAll('text').forEach(t => t.setAttribute('font-size', 10 * k));
      const st = svg.querySelector('.star'); if (st) st.setAttribute('transform', `translate(${S / 2} ${S / 2}) scale(${k}) translate(${-S / 2} ${-S / 2})`); };
    const zoom = (f, cx = vb.x + vb.w / 2, cy = vb.y + vb.w / 2) => { const w = Math.min(S, Math.max(S / 16, vb.w * f)); vb = { x: cx - (cx - vb.x) * w / vb.w, y: cy - (cy - vb.y) * w / vb.w, w }; set(); };
    const pt = e => { const r = svg.getBoundingClientRect(); return [vb.x + (e.clientX - r.left) / r.width * vb.w, vb.y + (e.clientY - r.top) / r.height * vb.w]; };
    svg.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = pt(e); zoom(e.deltaY < 0 ? 0.8 : 1.25, x, y); }, { passive: false });
    let drag = null;
    svg.addEventListener('pointerdown', e => { if (e.target.classList.contains('dot')) return; drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }; svg.setPointerCapture(e.pointerId); });
    svg.addEventListener('pointermove', e => { if (!drag) return; const r = svg.getBoundingClientRect(); vb.x = drag.vx - (e.clientX - drag.x) / r.width * vb.w; vb.y = drag.vy - (e.clientY - drag.y) / r.height * vb.w; set(); });
    svg.addEventListener('pointerup', () => drag = null); svg.addEventListener('pointercancel', () => drag = null);
    const info = root.querySelector('.mapinfo');
    svg.querySelectorAll('circle.dot').forEach(c => c.addEventListener('click', () => { if (info) info.textContent = c.dataset.i; }));
    root.querySelectorAll('[data-z]').forEach(b => b.onclick = () => { if (b.dataset.z === 'in') zoom(0.7); else if (b.dataset.z === 'out') zoom(1 / 0.7); else { vb = { x: 0, y: 0, w: S }; set(); } });
  }
})();
