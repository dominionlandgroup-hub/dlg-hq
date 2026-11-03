// DLG HQ - Spot Check. Damien looks over each lot before a list is built: Good keeps it, Cut drops it.
// Rows live in spot_lots (one list per drop). Decisions, comps and notes save as soon as he clicks or types.
// Aerial: Esri World Imagery tiles stitched on a canvas, parcel outline in red from NC OneMap (York SC: county service).
// Nothing is written on page load; every write comes from a click or an edit.
(function () {
  const PER = 24;
  const SC = window.SC = { view: 'ready', list: '', county: '', undec: false, flagged: false, page: 0, lists: [], counties: [], sum: {}, buyers: new Map() };
  const css = `.sc-bar{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}.sc-bar select{width:auto;max-width:100%}.sc-bar label.ck{display:flex;gap:6px;align-items:center;font-size:13px}
.sc-bar label.ck input{width:auto}
.sc-sum{overflow-x:auto}.sc-sum td,.sc-sum th{padding:5px 8px;white-space:nowrap}.sc-sum tr.tot td{font-weight:700;border-top:2px solid var(--line)}
.sc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}
.sc-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0}
.sc-card.good{border:2px solid #1f7a3a}.sc-card.cut{border:2px solid #b3261e;opacity:.75}
.sc-card .hd{font-weight:700;font-size:15px}.sc-card .meta{font-size:12px;color:var(--muted);line-height:1.45;overflow-wrap:anywhere}
.sc-img{position:relative;width:100%;max-width:340px;aspect-ratio:1;background:#111;border-radius:8px;overflow:hidden;margin:8px 0}
.sc-img canvas{width:100%;height:100%;display:block}.sc-img .nope{position:absolute;left:6px;bottom:6px;font-size:11px;color:#fff;background:rgba(0,0,0,.6);padding:2px 6px;border-radius:4px}
.sc-box{padding:6px 8px;margin:6px 0;border-radius:6px;font-size:13px}.sc-red{background:#fdecea;border:1px solid #d93025}.sc-yel{background:#fff3cd;border:1px solid #e0a800}
.sc-comp{background:#eef4ff;border:1px solid #7aa7e8}
.sc-dec{display:flex;gap:8px;margin-top:8px}.sc-dec button{flex:1;font:inherit;font-weight:600;padding:9px;border-radius:9px;border:1px solid var(--line);background:#fff;cursor:pointer}
.sc-dec .good.on{background:#1f7a3a;color:#fff;border-color:#1f7a3a}.sc-dec .cut.on{background:#b3261e;color:#fff;border-color:#b3261e}
.sc-card .row2{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.sc-card .row2 input{width:110px}
.sc-card textarea{min-height:44px;margin-top:6px;font-size:13px}
.sc-tbl{overflow:auto;max-height:75vh;padding:0}.sc-tbl table{border-collapse:collapse;font-size:12px}.sc-tbl th{position:sticky;top:0;background:var(--card);z-index:1}.sc-tbl th,.sc-tbl td{padding:4px 6px;border-bottom:1px solid var(--line);white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis;text-align:left}.sc-tbl tr.no td{color:var(--muted)}.sc-tbl tr.no td:first-child{color:#b3261e;font-weight:600}.sc-tbl tr.ok td:first-child{color:#1f7a3a;font-weight:600}
.sc-pg{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap;margin:10px 0}`;
  const addCss = () => { if (document.getElementById('sc-css')) return; const s = document.createElement('style'); s.id = 'sc-css'; s.textContent = css; document.head.appendChild(s); };
  const n0 = v => v == null || v === '' || isNaN(+v) ? null : +v;
  const usd = v => n0(v) == null ? '—' : '$' + Math.round(+v).toLocaleString();
  const offerFor = c => Math.floor(0.7 * c / 500) * 500;
  const q = () => sb.from('spot_lots');

  // distinct values without loading every row: ask for the next value after the last one (few lists, few counties)
  async function distinct(col, filt) { const out = []; let last = null;
    for (let i = 0; i < 200; i++) { let r = q().select(col).not(col, 'is', null).order(col).limit(1); if (filt) r = filt(r); if (last != null) r = r.gt(col, last);
      const { data, error } = await r; if (error) throw error; if (!data || !data.length) break; last = data[0][col]; out.push(last); }
    return out; }
  async function loadLists() { const L = await distinct('list');
    const withDate = await Promise.all(L.map(async l => { const { data } = await q().select('created_at').eq('list', l).order('created_at', { ascending: false }).limit(1); return { l, t: (data && data[0] && data[0].created_at) || '' }; }));
    return withDate.sort((a, b) => b.t.localeCompare(a.t) || b.l.localeCompare(a.l)).map(x => x.l); }

  // summary: per county Good / Cut / Not checked / red auto-cuts not overridden (head counts only)
  async function loadSummary() { const S = {}, list = SC.list;
    await Promise.all(SC.counties.map(async c => { const b = () => q().select('id', { count: 'exact', head: true }).eq('list', SC.list).eq('county', c);
      const [g, k, u, r] = await Promise.all([b().eq('decision', 'good'), b().eq('decision', 'cut'), b().is('decision', null).is('auto_cut', null), b().is('decision', null).not('auto_cut', 'is', null)]);
      for (const x of [g, k, u, r]) if (x.error) throw x.error;
      S[c] = { good: g.count || 0, cut: k.count || 0, und: u.count || 0, red: r.count || 0 }; }));
    if (list === SC.list) { SC.sum = S; SC.sumList = list; } }
  function drawSummary() { const el = $('sc_sum'); if (!el || SC.sumList !== SC.list) return; const cs = SC.counties, T = { good: 0, cut: 0, und: 0, red: 0 };
    cs.forEach(c => { for (const k in T) T[k] += (SC.sum[c] || {})[k] || 0; });
    const row = (n, x, cls) => `<tr class="${cls || ''}"><td>${esc(n)}</td><td class="right" style="color:#1f7a3a">${x.good.toLocaleString()}</td><td class="right" style="color:#b3261e">${x.cut.toLocaleString()}</td><td class="right">${x.und.toLocaleString()}</td><td class="right" style="color:#b3261e">${x.red.toLocaleString()}</td></tr>`;
    el.innerHTML = `<table><tr><th>County</th><th class="right">Approved</th><th class="right">You cut</th><th class="right">To check (mails unless cut)</th><th class="right">Cut by the checks</th></tr>${cs.map(c => row(c, SC.sum[c] || { good: 0, cut: 0, und: 0, red: 0 })).join('')}${row('Total', T, 'tot')}</table>`; }
  // keep the summary in step after a click without asking the server again
  function adjust(r, sign) { const s = SC.sumList === SC.list && SC.sum[r.county]; if (!s) return; if (r.decision === 'good') s.good += sign; else if (r.decision === 'cut') s.cut += sign; else if (r.auto_cut) s.red += sign; else s.und += sign; }

  window.vSpotCheck = async function () { addCss();
    $('view').innerHTML = '<div class="card muted">Loading…</div>';
    try { SC.lists = await loadLists(); } catch (e) { $('view').innerHTML = '<div class="card">Could not load Spot Check: ' + esc(e.message) + '</div>'; return; }
    if (!SC.lists.length) { $('view').innerHTML = '<div class="card muted">No lots to check yet.</div>'; return; }
    if (!SC.lists.includes(SC.list)) { SC.list = SC.lists[0]; SC.county = ''; SC.page = 0; }
    await openList(); };
  async function openList() {
    $('view').innerHTML = `<div class="card"><div class="sc-bar">
      <label class="ck" ${SC.lists.length > 1 ? '' : 'hidden'}>List <select id="sc_list">${SC.lists.map(l => `<option ${l === SC.list ? 'selected' : ''} value="${esc(l)}">${esc(l)}</option>`).join('')}</select></label>
      <label class="ck">County <select id="sc_cty"><option value="">All</option></select></label>
      <span class="sc-views">${[['ready','To check (will mail unless you Cut)'],['good','Approved'],['cut','Cut (by you)'],['auto','Cut by the checks'],['table','Every lot: table + Excel']].map(([k,l])=>`<button class="btn ${SC.view===k?'':'ghost'} sm" data-view="${k}">${l}</button>`).join(' ')}</span></div>
      <div class="small muted" style="margin-top:8px">${{ready:'Infill lots that passed every check and have a close comp of $50K+. They get mailed unless you click <b>Cut</b>. Clicking <b>Good</b> just marks them checked.',good:'Lots marked approved: ones you clicked Good, plus the clean lots in counties you finished on the Nov 3 page.',cut:'Lots you cut. Click Cut again to undo.',auto:'Lots the checks cut, with the reason in red (water, no road, house, flood, recently bought, no close comp, comp under $50K, on the MLS). Click Good to keep one anyway.',table:'Every lot in the list, one row each, with the result of every check and the proof behind it. Pick a county, or download the whole list to Excel and filter it yourself.'}[SC.view]} Everything saves as you go.</div></div>
      <div class="card sc-sum" id="sc_sum"><span class="muted small">Counting…</span></div><div id="sc_pg1" class="sc-pg"></div><div id="sc_grid" class="sc-grid"></div><div id="sc_pg2" class="sc-pg"></div>`;
    $('sc_list').onchange = e => { SC.list = e.target.value; SC.county = ''; SC.page = 0; openList(); };
    try { SC.counties = await distinct('county', r => r.eq('list', SC.list)); } catch (e) { $('sc_sum').textContent = 'Could not load counties: ' + e.message; SC.counties = []; }
    if (SC.county && !SC.counties.includes(SC.county)) SC.county = '';
    $('sc_cty').innerHTML = '<option value="">All</option>' + SC.counties.map(c => `<option ${c === SC.county ? 'selected' : ''} value="${esc(c)}">${esc(c)}</option>`).join('');
    $('sc_cty').onchange = e => { SC.county = e.target.value; SC.page = 0; loadPage(); };
    document.querySelectorAll('.sc-views button').forEach(b => b.onclick = () => { SC.view = b.dataset.view; SC.page = 0; openList(); });
    SC.sumList = null; loadSummary().then(drawSummary).catch(e => { if ($('sc_sum')) $('sc_sum').textContent = 'Could not count: ' + e.message; });
    loadPage(); }

  async function loadPage() { const g = $('sc_grid'); if (!g) return; g.innerHTML = '<div class="muted">Loading…</div>';
    if (SC.view === 'table') return loadTable(g);
    let r = q().select('id,list,county,state,apn,data,auto_cut,flag,priority,decision,comp,note', { count: 'exact' }).eq('list', SC.list);
    if (SC.county) r = r.eq('county', SC.county); r = SC.view === 'good' ? r.eq('decision', 'good') : SC.view === 'cut' ? r.eq('decision', 'cut') : SC.view === 'auto' ? r.is('decision', null).not('auto_cut', 'is', null) : r.is('decision', null).is('auto_cut', null);
    const { data, count, error } = await r.order('priority', { ascending: false, nullsFirst: false }).order('id').range(SC.page * PER, SC.page * PER + PER - 1);
    if (error) { g.innerHTML = '<div class="card">Could not load lots: ' + esc(error.message) + '</div>'; return; }
    const pages = Math.max(1, Math.ceil((count || 0) / PER));
    if (SC.page >= pages && SC.page > 0) { SC.page = pages - 1; return loadPage(); }
    const need = [...new Set((data || []).flatMap(x => (x.data && x.data.f) || []).map(String))].filter(id => !SC.buyers.has(id));
    if (need.length) { const { data: bs } = await sb.from('buyers').select('id,name,company').in('id', need); need.forEach(id => SC.buyers.set(id, null)); (bs || []).forEach(b => SC.buyers.set(String(b.id), b.company || b.name || ('Buyer #' + b.id))); }
    const pg = `<span class="small">${count ? (SC.page * PER + 1).toLocaleString() : 0} - ${Math.min(count || 0, SC.page * PER + PER).toLocaleString()} of ${(count || 0).toLocaleString()} lots</span><button class="btn ghost sm" ${SC.page ? '' : 'disabled'} data-p="-1">‹ Prev</button><button class="btn ghost sm" ${SC.page < pages - 1 ? '' : 'disabled'} data-p="1">Next ›</button>`;
    for (const id of ['sc_pg1', 'sc_pg2']) { const el = $(id); el.innerHTML = pg; el.querySelectorAll('button[data-p]').forEach(b => b.onclick = () => { SC.page += +b.dataset.p; loadPage(); if (id === 'sc_pg2') $('sc_pg1').scrollIntoView(); }); }
    g.style.display = ''; g.innerHTML = ''; (data || []).forEach(x => g.appendChild(card(x)));
    if (!(data || []).length) g.innerHTML = '<div class="card muted">Nothing left to check here. All done.</div>'; }

  // ---- Every lot: one row per lot with every check result, plus a CSV (opens in Excel) of the whole list ----
  const TPER = 200;
  const status = r => r.decision === 'good' ? 'Approved' : r.decision === 'cut' ? 'You cut' : r.auto_cut ? 'Cut by the checks' : 'Will mail';
  const hasNum = d => /^\s*[1-9]\d*[A-Z]?\s/.test(d.a || '');
  const mlsRes = (r, d) => /^On the MLS/.test(r.auto_cut || '') ? 'ON THE MLS - cut' : /MLS listing/.test(r.flag || '') ? 'Listing on same street - check' : hasNum(d) ? 'Not found (matched by address)' : 'Street only - no listing on this street found';
  const waterRes = (r, d) => /^Waterfront/.test(r.auto_cut || '') ? 'WATERFRONT - cut' : n0(d.wd) != null && +d.wd >= 0 ? Math.round(+d.wd) + ' m to water' : 'No lake/pond found nearby';
  const COLS = [
    ['Status', r => status(r)], ['Why', r => r.auto_cut || (r.decision === 'cut' ? 'You cut it' : 'Passed every check')], ['Check note', r => r.flag || ''],
    ['County', r => r.county], ['Address', (r, d) => d.a || ''], ['City', (r, d) => d.city || ''], ['Parcel', r => r.apn], ['Acres', (r, d) => n0(d.ac) != null ? (+d.ac).toFixed(2) : ''],
    ['Owner', (r, d) => d.o || ''], ['Mail to', (r, d) => [d.ma, d.mc, d.ms, d.mz].filter(Boolean).join(' ')],
    ['Comp $', (r, d) => n0(r.comp) != null ? Math.round(r.comp) : n0(d.cp) != null ? Math.round(d.cp) : ''], ['Comp source', (r, d) => n0(r.comp) != null ? 'Your comp' : d.ac_src === 'auto' ? 'Auto (' + (d.ac_conf || '') + ')' : d.ac_src === 'Nov 3 comp' || d.src === 'nov3' ? 'Nov 3 comp' : d.cp ? 'Comp' : 'None'],
    ['Comp sales used', (r, d) => d.cm || ''], ['Comp distance mi', (r, d) => n0(d.cd) != null ? (+d.cd).toFixed(2) : ''], ['Offer', (r, d) => { const c = n0(r.comp) != null ? r.comp : n0(d.cp); return c ? offerFor(c) : ''; }],
    ['MLS check', (r, d) => mlsRes(r, d)], ['Water check', (r, d) => waterRes(r, d)], ['Road frontage ft', (r, d) => n0(d.fr) != null ? Math.round(d.fr) : ''], ['Width ft', (r, d) => n0(d.w) != null ? Math.round(d.w) : ''],
    ['Flood %', (r, d) => n0(d.fl) != null ? Math.round(+d.fl * 100) : ''], ['House on lot?', (r, d) => d.hs || ''], ['Last sale date', (r, d) => d.sd || ''],
    ['Your note', r => r.note || ''], ['Map', (r, d) => n0(d.lat) != null ? 'https://www.google.com/maps/search/?api=1&query=' + d.lat + ',' + d.lng : '']];
  const tq = () => { let r = q().select('id,county,state,apn,data,auto_cut,flag,decision,comp,note', { count: 'exact' }).eq('list', SC.list); if (SC.county) r = r.eq('county', SC.county);
    const f = SC.tf || 'all'; return f === 'mail' ? r.is('auto_cut', null).or('decision.is.null,decision.eq.good') : f === 'cutc' ? r.is('decision', null).not('auto_cut', 'is', null) : f === 'cuty' ? r.eq('decision', 'cut') : r; };
  async function loadTable(g) {
    const f = SC.tf || 'all';
    const { data, count, error } = await tq().order('county').order('id').range(SC.page * TPER, SC.page * TPER + TPER - 1);
    if (error) { g.innerHTML = '<div class="card">Could not load lots: ' + esc(error.message) + '</div>'; return; }
    const pages = Math.max(1, Math.ceil((count || 0) / TPER));
    const pg = `<label class="ck small">Show <select class="sc-tf">${[['all','Every lot'],['mail','Will mail (approved + to check)'],['cutc','Cut by the checks'],['cuty','You cut']].map(([k,l])=>`<option value="${k}" ${k===f?'selected':''}>${l}</option>`).join('')}</select></label>
      <button class="btn sm sc-csv">Download ${SC.county ? esc(SC.county) : 'whole list'} to Excel (${(count||0).toLocaleString()} rows)</button><span class="small sc-csvmsg"></span>
      <span class="small">${count ? (SC.page * TPER + 1).toLocaleString() : 0} - ${Math.min(count || 0, SC.page * TPER + TPER).toLocaleString()} of ${(count || 0).toLocaleString()}</span><button class="btn ghost sm" ${SC.page ? '' : 'disabled'} data-p="-1">‹ Prev</button><button class="btn ghost sm" ${SC.page < pages - 1 ? '' : 'disabled'} data-p="1">Next ›</button>`;
    for (const id of ['sc_pg1', 'sc_pg2']) { const el = $(id); el.innerHTML = pg; el.querySelectorAll('button[data-p]').forEach(b => b.onclick = () => { SC.page += +b.dataset.p; loadPage(); $('sc_pg1').scrollIntoView(); });
      el.querySelector('.sc-tf').onchange = e => { SC.tf = e.target.value; SC.page = 0; loadPage(); }; el.querySelector('.sc-csv').onclick = () => csv(el.querySelector('.sc-csvmsg')); }
    const cell = (k, v) => k === 'Map' && v ? `<a href="${esc(v)}" target="_blank" rel="noopener">map</a>` : esc(v);
    g.style.display = 'block';
    g.innerHTML = `<div class="card sc-tbl"><table><tr>${COLS.map(c => `<th>${c[0]}</th>`).join('')}</tr>${(data || []).map(r => { const d = r.data || {}; const st = status(r);
      return `<tr class="${st === 'Will mail' || st === 'Approved' ? 'ok' : 'no'}">${COLS.map(c => `<td>${cell(c[0], c[1](r, d))}</td>`).join('')}</tr>`; }).join('')}</table></div>`; }
  async function csv(msg) { const rows = []; let from = 0;
    for (;;) { msg.textContent = 'Getting rows… ' + rows.length.toLocaleString(); const { data, error } = await tq().order('county').order('id').range(from, from + 999); if (error) { msg.textContent = 'Could not download: ' + error.message; return; } rows.push(...data); if (data.length < 1000) break; from += 1000; }
    const qv = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const out = [COLS.map(c => c[0]).join(',')].concat(rows.map(r => { const d = r.data || {}; return COLS.map(c => qv(c[0] === 'Parcel' ? '="' + r.apn + '"' : c[1](r, d))).join(','); })).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + out], { type: 'text/csv' })); a.download = 'Spot Check ' + (SC.county || 'all counties') + ' - ' + new Date().toISOString().slice(0, 10) + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    msg.textContent = rows.length.toLocaleString() + ' rows downloaded'; }

  function card(r) { const d = r.data || {}, c = document.createElement('div');
    const style = () => { c.className = 'sc-card' + (r.decision === 'good' ? ' good' : r.decision === 'cut' ? ' cut' : ''); };
    const fits = d.fn && d.fn.length ? d.fn : ((d.f || []).map(id => SC.buyers.get(String(id)) || ('Buyer #' + id)));
    const cty = r.county || d.c || '', apn = String(r.apn || d.p || '');
    const deed = cty === 'Mecklenburg' ? 'https://polaris3g.mecklenburgcountync.gov/pid/' + encodeURIComponent(apn.replace(/\D/g, '').padStart(8, '0')) : 'https://www.google.com/search?q=' + encodeURIComponent(cty + ' County ' + (r.state || 'NC') + ' tax parcel ' + apn);
    const pct = v => n0(v) == null ? '—' : Math.round(+v * 100) + '%', ft = v => n0(v) == null ? '—' : Math.round(+v).toLocaleString() + ' ft';
    const water = n0(d.wd) == null ? '—' : +d.wd < 0 ? 'none nearby' : Math.round(+d.wd).toLocaleString() + ' m';
    const comp = n0(d.cp) != null ? `<b>Comp:</b> ${esc(d.cm || '')} · ${usd(d.cp)}${n0(d.cd) != null ? ' · ' + (+d.cd).toFixed(2) + ' mi' : ''}${n0(d.cac) != null ? ' · ' + (+d.cac).toFixed(2) + ' ac' : ''}<br><b>Offer:</b> <span style="font-size:15px">${usd(d.off)}</span>` : '<i>Neutral letter (no comp yet)</i>';
    c.innerHTML = `<div class="hd">${esc(d.a || '(no address)')}</div>
      <div class="meta">${esc([d.city, d.zip].filter(Boolean).join(' '))}${d.city || d.zip ? ' · ' : ''}${esc(r.county || d.c || '')} County, ${esc(r.state || '')} · parcel ${esc(r.apn || d.p || '')} · ${n0(d.ac) != null ? (+d.ac).toFixed(2) + ' ac' : '— ac'}<br>
      <b>Owner:</b> ${esc(d.o || '')}<br><b>Mail to:</b> ${esc([d.ma, [d.mc, [d.ms, d.mz].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ') || '—')}</div>
      ${r.auto_cut ? `<div class="sc-box sc-red"><b>Will be cut at build:</b> ${esc(r.auto_cut)}. Click Good to keep it.</div>` : ''}
      ${r.flag ? `<div class="sc-box sc-yel"><b>Check:</b> ${esc(r.flag)}</div>` : ''}
      <div class="sc-img"><canvas width="512" height="512"></canvas></div>
      <div class="meta"><b>Width:</b> ${ft(d.w)} · <b>Road frontage:</b> ${ft(d.fr)}${n0(d.near) != null ? ' · nearest road ' + Math.round(+d.near) + ' m' : ''}<br><b>Flood:</b> ${pct(d.fl)} · <b>Water:</b> ${water}${d.hs ? '<br><b>House?</b> ' + esc(d.hs) : ''}<br>
      <b>Fits ${fits.length} buyer${fits.length === 1 ? '' : 's'}:</b> ${fits.length ? esc(fits.join(', ')) : 'none'}<br><a href="${deed}" target="_blank" rel="noopener">Check deed / owner</a>${n0(d.lat) != null ? ` · <a href="https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}" target="_blank" rel="noopener">Google Maps</a>` : ''}</div>
      <div class="sc-box" style="background:var(--bg)">${comp}</div>
      <div class="sc-box sc-comp row2"><b>Your comp $</b><input type="text" inputmode="numeric" class="sc-cv" placeholder="e.g. 65000" value="${n0(r.comp) != null ? Math.round(r.comp) : ''}"><span class="sc-off" style="font-weight:600"></span></div>
      <textarea class="sc-note" placeholder="Note">${esc(r.note || '')}</textarea>
      <div class="sc-dec"><button class="good">Good</button><button class="cut">Cut</button></div><div class="small sc-msg" style="color:var(--red)"></div>`;
    style(); const msg = t => { c.querySelector('.sc-msg').textContent = t || ''; };
    const btns = () => { c.querySelector('.good').classList.toggle('on', r.decision === 'good'); c.querySelector('.cut').classList.toggle('on', r.decision === 'cut'); }; btns();
    const decide = async v => { const old = r.decision, next = old === v ? null : v; adjust(r, -1); r.decision = next; adjust(r, 1); style(); btns(); drawSummary(); msg('');
      const { error } = await q().update({ decision: next, decided_at: next ? new Date().toISOString() : null }).eq('id', r.id);
      if (error) { adjust(r, -1); r.decision = old; adjust(r, 1); style(); btns(); drawSummary(); msg('Not saved: ' + error.message); } };
    c.querySelector('.good').onclick = () => decide('good'); c.querySelector('.cut').onclick = () => decide('cut');
    const ci = c.querySelector('.sc-cv'), off = c.querySelector('.sc-off');
    const showOff = (n, saved) => { off.textContent = n ? `→ offer ${usd(offerFor(n))}${saved ? ' (saved)' : ''}` : ''; }; showOff(n0(r.comp));
    ci.onchange = async () => { const v = ci.value.replace(/[^0-9.kK]/g, ''); let n = /k$/i.test(v) ? parseFloat(v) * 1000 : parseFloat(v); if (n && n < 1000) n *= 1000; n = n ? Math.round(n) : null;
      ci.value = n || ''; const { error } = await q().update({ comp: n }).eq('id', r.id); if (error) return msg('Comp not saved: ' + error.message); r.comp = n; showOff(n, true); msg(''); };
    ci.onkeydown = e => { if (e.key === 'Enter') ci.blur(); };
    const nt = c.querySelector('.sc-note'); nt.onchange = async () => { const v = nt.value.trim() || null; const { error } = await q().update({ note: v }).eq('id', r.id); if (error) return msg('Note not saved: ' + error.message); r.note = v; msg(''); };
    const cv = c.querySelector('canvas');
    if (n0(d.lat) == null || n0(d.lng) == null) cv.parentNode.insertAdjacentHTML('beforeend', '<div class="nope">No map point for this lot</div>');
    else if ('IntersectionObserver' in window) { const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); aerial(cv, r); } }, { rootMargin: '300px' }); io.observe(cv); }
    else aerial(cv, r);
    return c; }

  // ---- aerial: 3x3 Esri tiles at zoom 18 stitched onto a 512px canvas, parcel outline drawn on top in red ----
  const Z = 18;
  function px(lng, lat) { const S = 256 * Math.pow(2, Z), x = (lng + 180) / 360 * S, s = Math.sin(lat * Math.PI / 180); return [x, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * S]; }
  const sq = s => String(s || '').replace(/'/g, "''");
  async function rings(r) { const d = r.data || {}, county = r.county || d.c || '', apn = String(r.apn || d.p || '').trim();
    const get = async (url, where) => { const u = url + '/query?' + new URLSearchParams({ where, returnGeometry: 'true', outSR: '4326', f: 'json' }); const j = await (await fetch(u)).json(); return (j.features || []).flatMap(f => (f.geometry && f.geometry.rings) || []); };
    try { if (apn) { let rs;
        if (/^york$/i.test(county) && r.state === 'SC') rs = await get('https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Parcels/FeatureServer/0', `TAXMAPID='${sq(apn)}'`);
        else if (/^lancaster$/i.test(county) && r.state === 'SC') rs = await get('https://services3.arcgis.com/rJcpRneDUBgTeCT3/arcgis/rest/services/LC_Parcels/FeatureServer/0', `PIN='${sq(apn)}'`);
        else { const p = /^iredell$/i.test(county) && !apn.includes('.') ? apn + '.000' : apn; rs = await get('https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1', `parno='${sq(p)}' AND cntyname='${sq(county)}'`); }
        if (rs.length) return rs; } } catch (e) {}
    try { const u = 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query?' + new URLSearchParams({ geometry: `${d.lng},${d.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'true', outSR: '4326', f: 'json' });
      const j = await (await fetch(u)).json(); const rs = (j.features || []).flatMap(f => (f.geometry && f.geometry.rings) || []); return rs.length ? rs : null; } catch (e) { return null; } }
  async function aerial(cv, r) { const d = r.data || {}, ctx = cv.getContext('2d'); const [cx, cy] = px(+d.lng, +d.lat), ox = cx - 256, oy = cy - 256, tx0 = Math.floor(ox / 256), ty0 = Math.floor(oy / 256);
    const outP = Promise.race([rings(r), new Promise(res => setTimeout(() => res(null), 10000))]);
    const tiles = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tiles.push(new Promise(res => { const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => { ctx.drawImage(im, (tx0 + i) * 256 - ox, (ty0 + j) * 256 - oy); res(); }; im.onerror = () => res();
      im.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${Z}/${ty0 + j}/${tx0 + i}`; }));
    const [rs] = await Promise.all([outP, Promise.all(tiles)]);
    if (!rs) { cv.parentNode.insertAdjacentHTML('beforeend', '<div class="nope">Outline did not load - picture only</div>'); return; }
    ctx.beginPath();
    for (const ring of rs) { ring.forEach(([x, y], k) => { const p = px(x, y); if (k) ctx.lineTo(p[0] - ox, p[1] - oy); else ctx.moveTo(p[0] - ox, p[1] - oy); }); ctx.closePath(); }
    ctx.fillStyle = 'rgba(255,0,0,.12)'; ctx.fill('evenodd'); ctx.strokeStyle = '#f00'; ctx.lineWidth = 4; ctx.stroke(); }
})();
