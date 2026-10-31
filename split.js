// DLG HQ - Split Finder tab.
// Vacant parcels that can be split into 3+ legal lots on the existing road (exempt/minor split, no new street).
// Sell the extra lots to a builder to pay for the land, keep 1-2 lots free and clear.
// Candidates come from county GIS (zoning minimum lot size + width, measured road frontage) and are loaded by Claude
// or with the Import button. Pad prices are per county/zip settings until Canopy comps are added.
const SP = {
  county: '', status: '', owner: '', q: '', pencil: true, sewer: false, clean: true, rows: [],
  keep: 1, maxLots: 3, costs: 3500, goal: 10000, cushion: 0,
  pads: { Charlotte: 70000, Gaston: 50000 },
};
const SP_STATUSES = [['new', 'New'], ['mailed', 'Mailed'], ['contacting', 'Contacting owner'], ['survey', 'Surveyor check'], ['offer', 'Offer made'], ['contract', 'Under contract'], ['dead', 'Dead']];
try { Object.assign(SP, JSON.parse(localStorage.getItem('dlg_split_settings') || '{}'), { rows: [] }); } catch (e) { }
function spSaveSettings() { try { const { keep, maxLots, costs, goal, cushion, pads } = SP; localStorage.setItem('dlg_split_settings', JSON.stringify({ keep, maxLots, costs, goal, cushion, pads })); } catch (e) { } }

async function spAll() {
  const all = [];
  for (let i = 0; i < 20000; i += 1000) {
    const r = await sb.from('split_parcels').select('*').order('score', { ascending: false }).order('id').range(i, i + 999);
    if (r.error) return r;
    all.push(...r.data);
    if (r.data.length < 1000) break;
  }
  return { data: all, error: null };
}

// The math: lots we can actually do (capped for an exempt/minor split), sell all but the keepers,
// minus survey/plat/closing (and an optional cushion) = the most we can pay and still keep the lot(s) free.
// Grade: Profit = room >= profit goal; Free lot = room >= 0 (break even, keep a free lot); No = short.
// Water/sewer taps are the builder's cost on the lots sold; the kept lot is a portfolio hold.
function spPad(r) { return r.pad_price || SP.pads[r.county] || 50000; }
function spMath(r) {
  const lots = Math.min(r.est_lots || 0, SP.maxLots);
  const sell = Math.max(0, lots - SP.keep);
  const pad = spPad(r);
  const maxOffer = sell * pad - SP.costs - (SP.cushion || 0);
  const ask = r.tax_land_value || 0;
  const room = maxOffer - ask;
  const ok = lots >= SP.keep + 1 && maxOffer > 0;
  const grade = !ok || room < 0 ? 'No' : room >= SP.goal ? 'Profit' : 'Free lot';
  return { lots, sell, pad, maxOffer, ask, grade, pencils: grade !== 'No', cushion: room };
}
function spCk(r) { try { return JSON.parse(r.checks_done || '{}') || {}; } catch (e) { return {}; } }
function spChecked(r) { return spCk(r).v >= 1; }
function spSite(r) {
  const f = [], c = spCk(r);
  if (r.floodway) f.push(['Floodway', 'bad']);
  if (r.flood_pct >= 25) f.push([`${r.flood_pct}% flood`, 'bad']); else if (r.flood_pct >= 5) f.push([`${r.flood_pct}% flood`, 'warn']);
  if (r.slope_pct >= 15) f.push([`${r.slope_pct}% slope`, 'bad']); else if (r.slope_pct >= 8) f.push([`${r.slope_pct}% slope`, 'warn']);
  if (c.below_road_ft != null && c.below_road_ft >= 8) f.push([`${c.below_road_ft} ft below road`, 'bad']); else if (c.below_road_ft >= 4) f.push([`${c.below_road_ft} ft below road`, 'warn']);
  if (c.relief_ft >= 20) f.push([`${c.relief_ft} ft drop`, 'warn']);
  if (spChecked(r) && !r.frontage_ft) f.push(['No road frontage found', 'bad']);
  if (r.road_public === false) f.push(['Private road?', 'warn']);
  if (r.shape_ok === false) f.push(['Odd shape', 'warn']);
  if (r.subdivision) f.push(['Platted: check covenants', 'warn']);
  if (r.creek_buffer_pct >= 30) f.push([`Creek buffer ${r.creek_buffer_pct}%`, 'bad']); else if (r.creek_buffer_pct >= 5) f.push([`Creek buffer ${r.creek_buffer_pct}%`, 'warn']);
  if (r.wetland) f.push([`Wetland ${c.wetland_pct || ''}%`, c.wetland_pct >= 25 ? 'bad' : 'warn']);
  if (c.power_line) f.push(['Power line', 'warn']);
  if (c.busy_road) f.push(['Busy road: driveways?', 'warn']);
  if (spWsLimit(r)) f.push(['Watershed limits', 'warn']);
  if (r.tree_pct >= 70) f.push([`${r.tree_pct}% trees`, 'warn']);
  if (!spChecked(r)) f.push(['Not checked yet', '']);
  return f;
}
// NC water-supply watershed: critical areas and WS-II/III limit density for all new homes; WS-IV protected areas only
// for projects that need an erosion-control plan (about 1+ acre disturbed). Not verified per parcel: confirm with planning.
function spWsLimit(r) { const w = String(spCk(r).watershed || ''); if (!w) return false; if (/WS-(II|III)|C\b|C \(/.test(w) && !/WS-V/.test(w)) return true; return /WS-IV/.test(w) && (r.acres || 0) >= 1; }
function spClean(r) { return !spSite(r).some(x => x[1] === 'bad'); }
function spPill(t, k) {
  const s = k === 'bad' ? 'background:#fde8e8;color:#a61b1b' : k === 'warn' ? 'background:#fff4d6;color:#7a5a00' : k === 'good' ? 'background:#e3f4ea;color:#1a7a45' : 'background:#f1f1f1;color:#666';
  return `<span class="pill" style="${s}">${esc(t)}</span>`;
}
function spSewerPill(r) { const g = String(r.sewer_guess || ''); return /^likely/i.test(g) ? spPill('Sewer likely', 'good') : /^unlikely/i.test(g) ? spPill('Septic area', '') : spPill('Sewer ?', ''); }

async function vSplit() {
  $('view').innerHTML = '<div class="muted">Loading…</div>';
  const t = await spAll();
  if (t.error) {
    $('view').innerHTML = `<div class="card">Split Finder isn't set up yet: ${esc(t.error.message)}<div class="small muted" style="margin-top:6px">Run split.sql once in the Supabase SQL editor, then reload.</div></div>`;
    return;
  }
  SP.rows = t.data || [];
  $('actions').innerHTML = `<input type="file" id="spFile" accept=".xlsx" style="display:none" onchange="spImport(this.files[0])"><button class="btn ghost" onclick="$('spFile').click()">Import split list (.xlsx)</button>`;
  const counties = [...new Set(SP.rows.map(r => r.county).filter(Boolean))].sort();
  const owners = [...new Set(SP.rows.map(r => r.owner_type).filter(Boolean))].sort();
  const num = (id, v, step) => `<input id="${id}" type="number" step="${step || 1000}" value="${v}" style="width:96px" onchange="spSet()">`;
  $('view').innerHTML = `
    <div class="card" style="padding:12px 14px">
      <details><summary style="cursor:pointer;font-weight:600">How the Split Finder works</summary>
        <ol class="small" style="margin:8px 0 0 18px;line-height:1.6">
          <li><b>Every parcel here is vacant</b> and big enough, with enough road frontage, to cut into 3+ lots that meet its zoning's minimum lot size and width on the road it already has (no new street, so it's an exempt or minor split, not a subdivision).</li>
          <li><b>Lots</b> = the smaller of (area ÷ minimum lot size) and (frontage ÷ minimum width). Frontage is measured from the county street map, so it can be off; the surveyor confirms.</li>
          <li><b>The math:</b> lots used (capped at your max) − lots you keep = lots you sell. Lots sold × pad price − survey, plat fees and closing (both sides) = the <b>most you can pay</b> and still keep your lot free. Water/sewer taps are the builder's cost.</li>
          <li><b>Grade</b> (against county tax land value, a stand-in for the owner's price): <b>Profit</b> = room left ≥ your profit goal. <b>Free lot</b> = you break even or a little better and keep a lot free and clear. <b>No</b> = hidden.</li>
          <li><b>Site checks:</b> FEMA flood %, average slope and tree cover. Builders walk from flood and steep lots. Red = skip, yellow = look closer.</li>
          <li><b>Sewer:</b> inside city/town limits = likely, unincorporated = septic area (each lot then needs its own perc test). Call the utility before an offer.</li>
          <li><b>Before you sell any lot:</b> contract with a plat-approval contingency, surveyor confirms, plat recorded (Charlotte exempt plat ~5 business days). A minor split can't be re-split for 10 years (G.S. 160D-802).</li>
        </ol>
      </details>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <label class="small">Keep ${`<select id="spKeep" style="width:auto" onchange="spSet()">${[1, 2].map(v => `<option ${SP.keep == v ? 'selected' : ''}>${v}</option>`).join('')}</select>`} lot(s)</label>
        <label class="small">Max lots ${`<select id="spMax" style="width:auto" onchange="spSet()">${[3, 4, 5].map(v => `<option ${SP.maxLots == v ? 'selected' : ''}>${v}</option>`).join('')}</select>`}</label>
        <label class="small">Survey/plat/closing ${num('spCosts', SP.costs, 500)}</label>
        <label class="small">Profit goal ${num('spGoal', SP.goal)}</label>
        <label class="small" title="Optional: interest/holding if you fund it yourself">Cushion ${num('spCushion', SP.cushion || 0, 500)}</label>
        ${Object.keys(SP.pads).map(c => `<label class="small">${esc(c)} pad ${num('spPad_' + c, SP.pads[c])}</label>`).join('')}
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <select style="width:auto" onchange="SP.county=this.value;vSplitDraw()"><option value="">All areas</option>${counties.map(c => `<option ${SP.county === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select style="width:auto" onchange="SP.owner=this.value;vSplitDraw()"><option value="">Any owner</option>${owners.map(c => `<option ${SP.owner === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select style="width:auto" onchange="SP.status=this.value;vSplitDraw()"><option value="">Any status</option>${SP_STATUSES.map(([k, l]) => `<option value="${k}" ${SP.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" style="width:auto" ${SP.pencil ? 'checked' : ''} onchange="SP.pencil=this.checked;vSplitDraw()"> Profit or free lot only</label>
        <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" style="width:auto" ${SP.clean ? 'checked' : ''} onchange="SP.clean=this.checked;vSplitDraw()"> Hide flood/steep</label>
        <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" style="width:auto" ${SP.checked ? 'checked' : ''} onchange="SP.checked=this.checked;vSplitDraw()"> Checked only</label>
        <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" style="width:auto" ${SP.sewer ? 'checked' : ''} onchange="SP.sewer=this.checked;vSplitDraw()"> Sewer likely only</label>
        <input placeholder="Search owner, address, parcel, zip" style="width:240px" value="${esc(SP.q)}" oninput="SP.q=this.value;vSplitDraw()">
        <span class="small muted" id="spCount"></span>
      </div>
    </div>
    <div class="card" style="padding:0;overflow-x:auto"><table class="ctable" id="spTable"></table></div>`;
  vSplitDraw();
}

function spSet() {
  SP.keep = Number($('spKeep').value); SP.maxLots = Number($('spMax').value);
  SP.costs = Number($('spCosts').value) || 0; SP.goal = Number($('spGoal').value) || 0; SP.cushion = Number($('spCushion').value) || 0;
  for (const c of Object.keys(SP.pads)) { const el = $('spPad_' + c); if (el) SP.pads[c] = Number(el.value) || SP.pads[c]; }
  spSaveSettings(); vSplitDraw();
}

function spFiltered() {
  const q = SP.q.trim().toLowerCase();
  return SP.rows.filter(r => {
    if (SP.county && r.county !== SP.county) return false;
    if (SP.owner && r.owner_type !== SP.owner) return false;
    if (SP.status && (r.my_status || 'new') !== SP.status) return false;
    if (SP.pencil && !spMath(r).pencils) return false;
    if (SP.clean && !spClean(r)) return false;
    if (SP.sewer && !/^likely/i.test(r.sewer_guess || '')) return false;
    if (SP.checked && !spChecked(r)) return false;
    if (q && ![r.owner_name, r.owner_name2, r.address, r.parcel, r.mail_city, r.mail_zip, r.zoning].some(x => String(x || '').toLowerCase().includes(q))) return false;
    return true;
  }).map(r => ({ r, m: spMath(r) })).sort((a, b) => (b.m.pencils - a.m.pencils) || (b.m.cushion - a.m.cushion));
}

function vSplitDraw() {
  const t = $('spTable'); if (!t) return;
  const rows = spFiltered();
  const c = $('spCount'); if (c) c.textContent = `${rows.length} of ${SP.rows.length} parcels`;
  const head = `<tr><th>Site</th><th>Parcel</th><th>Owner</th><th class="right">Lots</th><th class="right">Frontage</th><th class="right">Most I can pay</th><th class="right">Tax land value</th><th>My status</th><th></th></tr>`;
  if (!rows.length) { t.innerHTML = head + `<tr><td colspan="9" class="muted">${SP.rows.length ? 'Nothing matches. Try turning off "Profit or free lot only" or raising the pad price.' : 'No parcels yet. Claude loads them, or click "Import split list (.xlsx)".'}</td></tr>`; return; }
  t.innerHTML = head + rows.slice(0, 1500).map(({ r, m }) => `<tr>
      <td>${spPill(m.grade, m.grade === 'Profit' ? 'good' : m.grade === 'Free lot' ? 'warn' : 'bad')} ${spSewerPill(r)}<div style="margin-top:3px">${spSite(r).map(x => spPill(x[0], x[1])).join(' ')}</div></td>
      <td><b>${esc(r.address || '(no site address)')}</b><div class="small muted">${esc(r.jurisdiction || r.county || '')} · ${esc(r.zoning || '')} · ${esc(r.parcel || '')} · ${r.acres ?? ''} ac</div></td>
      <td>${esc(r.owner_name || '')}<div class="small muted">${esc(r.owner_type || '')}${r.years_held != null ? ' · ' + Math.round(r.years_held) + ' yrs' : ''}${r.out_of_state ? ' · out of state' : ''}</div></td>
      <td class="right num">${m.lots}<div class="small muted">${r.est_lots > m.lots ? r.est_lots + ' fit' : ''}</div></td>
      <td class="right num">${r.frontage_ft != null ? Math.round(r.frontage_ft) + ' ft' : '—'}</td>
      <td class="right num"><b style="color:${m.pencils ? '#1a7a45' : '#a61b1b'}">${money(m.maxOffer)}</b><div class="small muted">sell ${m.sell} × ${money(m.pad)}</div></td>
      <td class="right num">${r.tax_land_value != null ? money(r.tax_land_value) : '—'}</td>
      <td><select style="width:auto" onchange="spSetStatus(${r.id},this.value)">${SP_STATUSES.map(([k, l]) => `<option value="${k}" ${(r.my_status || 'new') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>${r.my_notes ? '<div class="small muted" style="margin-top:3px">📝 has notes</div>' : ''}</td>
      <td><button class="btn ghost sm" onclick="spOpen(${r.id})">Details</button></td></tr>`).join('');
}

async function spSetStatus(id, v) {
  const { error } = await sb.from('split_parcels').update({ my_status: v, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return toast(error.message);
  const r = SP.rows.find(x => x.id === id); if (r) r.my_status = v;
  toast('Status saved');
}

function spOpen(id) {
  const r = SP.rows.find(x => x.id === id); if (!r) return;
  const m = spMath(r);
  const line = (l, v) => `<tr><td class="small muted" style="width:170px;vertical-align:top">${l}</td><td>${v === null || v === undefined || v === '' ? '<span class="muted">—</span>' : v}</td></tr>`;
  const ll = r.lat && r.lng ? `${r.lat},${r.lng}` : '';
  const links = [
    ll && `<a href="https://www.google.com/maps/search/?api=1&query=${ll}" target="_blank" rel="noopener">Google Maps</a>`,
    r.county === 'Charlotte' && r.parcel && `<a href="https://polaris3g.mecklenburgcountync.gov/pid/${encodeURIComponent(r.parcel)}" target="_blank" rel="noopener">Polaris</a>`,
    ll && `<a href="https://msc.fema.gov/portal/search?AddressQuery=${ll}" target="_blank" rel="noopener">FEMA flood</a>`,
  ].filter(Boolean).join(' · ');
  window._wideNext = true;
  openDrawer(`<div class="dhead"><div><div class="small muted">Split Finder · ${esc(r.jurisdiction || r.county || '')}</div><h2 style="margin:2px 0 0">${esc(r.address || r.parcel || 'Parcel')}</h2><div class="small muted">${r.acres ?? ''} acres · ${esc(r.zoning || '')} · parcel ${esc(r.parcel || '')}</div></div><button class="btn ghost" onclick="closeDrawer()">Close</button></div>
    <div class="card"><div style="font-size:15px">${m.grade === 'Profit' ? spPill('Profit + free lot', 'good') : m.grade === 'Free lot' ? spPill('Free lot (break even)', 'warn') : spPill("Doesn't work at these numbers", 'bad')}</div>
      <div class="small" style="margin-top:8px;line-height:1.7">
        ${m.lots} lots (of ${r.est_lots ?? '?'} that fit) − keep ${SP.keep} = sell ${m.sell} × ${money(m.pad)} pad${r.pad_price_source ? ' <span class="muted">(' + esc(r.pad_price_source) + ')</span>' : ''} = ${money(m.sell * m.pad)}<br>
        − ${money(SP.costs)} survey/plat/closing${SP.cushion ? ' − ' + money(SP.cushion) + ' cushion' : ''} = <b>${money(m.maxOffer)} most I can pay</b><br>
        Tax land value ${money(m.ask)} → ${m.cushion >= 0 ? money(m.cushion) + ' of room' : money(-m.cushion) + ' short'}. Keep lot(s) worth about ${money(SP.keep * m.pad)}.
      </div></div>
    <div class="card"><table>
      ${line('Lot rules', r.min_lot_sqft ? `${Number(r.min_lot_sqft).toLocaleString()} sq ft minimum, ${r.min_width_ft} ft wide` : null)}
      ${line('Size / frontage', `${r.lot_sqft ? Number(r.lot_sqft).toLocaleString() + ' sq ft' : ''}${r.frontage_ft != null ? ' · ' + Math.round(r.frontage_ft) + ' ft of road frontage (' + (r.frontage_method ? 'measured along the right-of-way' : 'map estimate') + ')' : ''}${r.corner ? ' · corner/two streets' : ''}`)}
      ${line('Road', r.road_name ? esc(r.road_name) + (r.road_public === true ? ' · public (city/state maintained)' : r.road_public === false ? ' · <b>no maintenance on record: may be private, not verified</b>' : '') : esc(r.street || ''))}
      ${line('Creek / wetland', r.creek_buffer_pct == null ? 'Not checked yet' : `${r.creek_buffer_pct}% within 50 ft of a mapped creek${spCk(r).stream ? ' (' + esc(spCk(r).stream) + ')' : ''} · ${r.wetland ? spCk(r).wetland_pct + '% mapped wetland' : 'no mapped wetland'} <span class="small muted">(creek buffers are 35-100 ft in Charlotte; confirm on site)</span>`)}
      ${line('Power lines', spCk(r).v2 ? (spCk(r).power_line ? 'Transmission line within 75 ft (' + esc(spCk(r).power_line) + '): easement takes buildable land' : 'No transmission line mapped nearby') : null)}
      ${line('Watershed', spCk(r).v2 ? (spCk(r).watershed ? esc(spCk(r).watershed) + (spWsLimit(r) ? ' · <b>density limits may apply: confirm with planning</b>' : ' · small split usually not affected (not verified)') : 'Not in a water-supply watershed') : null)}
      ${line('Busy road', spCk(r).busy_road ? esc(spCk(r).busy_road) + ' · 45+ mph or major road: separate driveways may not be allowed' : null)}
      ${line('Recorded plat', r.subdivision ? esc(r.subdivision) + ' <span class="small muted">(check covenants/restrictions before offering)</span>' : null)}
      ${line('Sewer', esc(r.sewer_guess || ''))}
      ${line('Flood (FEMA)', r.flood_pct != null ? `${r.flood_pct}% in the 100-year flood zone${r.floodway ? ' · includes floodway (can\'t build)' : ''}` : 'Not checked yet')}
      ${line('Slope / grade', r.slope_pct != null ? `${r.slope_pct}% average · ${spCk(r).relief_ft ?? '?'} ft high-to-low · ${spCk(r).below_road_ft == null ? 'road height unknown' : spCk(r).below_road_ft > 0 ? spCk(r).below_road_ft + ' ft below the road' : spCk(r).below_road_ft < 0 ? -spCk(r).below_road_ft + ' ft above the road' : 'level with the road'} <span class="small muted">(USGS 1 m lidar)</span>` : 'Not checked yet')}
      ${line('Shape', r.shape_ok == null ? null : r.shape_ok ? 'Regular enough to cut into lots' : 'Irregular (flag lot, taper or skinny strip): surveyor must confirm the lot layout')}
      ${line('Tree cover', r.tree_pct != null ? `${r.tree_pct}% (NLCD canopy)` : 'Not checked yet')}
      ${line('Owner', esc(r.owner_name || '') + (r.owner_name2 ? '<div class="small muted">' + esc(r.owner_name2) + '</div>' : '') + `<div class="small muted">${esc(r.owner_type || '')}</div>`)}
      ${line('Mailing address', esc([r.mail_address, r.mail_city, r.mail_state, r.mail_zip].filter(Boolean).join(', ')))}
      ${line('Held', r.years_held != null ? `${Math.round(r.years_held)} years${r.year_bought ? ' (since ' + r.year_bought + ')' : ''}${r.last_sale_price ? ' · paid ' + money(r.last_sale_price) : ''}` : null)}
      ${line('Links', links || null)}
    </table></div>
    <div class="card"><h3 class="sec" style="margin-top:0">Pad price for this parcel</h3>
      <div class="row" style="gap:8px;align-items:center"><input id="sp_pad" type="number" step="1000" placeholder="${spPad(r)}" value="${r.pad_price || ''}" style="width:120px"><input id="sp_pads" placeholder="Where it came from (comp, builder quote)" value="${esc(r.pad_price_source || '')}"></div>
      <div class="small muted" style="margin-top:4px">Leave blank to use the ${esc(r.county || '')} default.</div></div>
    <div class="card"><h3 class="sec" style="margin-top:0">My notes</h3>
      <select id="sp_st" style="width:auto;margin-bottom:8px">${SP_STATUSES.map(([k, l]) => `<option value="${k}" ${(r.my_status || 'new') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <textarea id="sp_notes" rows="6" placeholder="Calls, surveyor answers, offers">${esc(r.my_notes || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" onclick="spSaveNotes(${r.id})">Save</button></div></div>`);
}

async function spSaveNotes(id) {
  const pv = $('sp_pad').value;
  const upd = { my_notes: $('sp_notes').value, my_status: $('sp_st').value, pad_price: pv ? Number(pv) : null, pad_price_source: $('sp_pads').value.trim() || null, updated_at: new Date().toISOString() };
  const { error } = await sb.from('split_parcels').update(upd).eq('id', id);
  if (error) return toast(error.message);
  const r = SP.rows.find(x => x.id === id); if (r) Object.assign(r, upd);
  toast('Saved'); closeDrawer(); vSplitDraw();
}

function spLoadXlsx() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the spreadsheet reader')); document.head.appendChild(s); });
}

// Import: the "3-Lot Split Candidates" workbook. Statuses, notes and pad prices already saved are kept.
async function spImport(file) {
  if (!file) return;
  try {
    toast('Reading ' + file.name + '…');
    if (/\.json$/i.test(file.name)) return spImportChecks(JSON.parse(await file.text()));
    await spLoadXlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const num = v => v === null || v === '' || v === undefined ? null : (isNaN(Number(String(v).replace(/[$,]/g, ''))) ? null : Number(String(v).replace(/[$,]/g, '')));
    const str = v => v === null || v === undefined ? null : String(v).trim() || null;
    const yes = v => /^y/i.test(String(v || ''));
    const listName = file.name.replace(/\.xlsx$/i, '');
    const out = new Map();
    for (const name of wb.SheetNames) {
      const county = /^charlotte/i.test(name) ? 'Charlotte' : /^gaston/i.test(name) ? 'Gaston' : null;
      if (!county) continue;
      for (const r of XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null })) {
        if (!r['ParcelID']) continue;
        const fl = num(r['FloodAcres']), ac = num(r['Acres']);
        out.set(`${county}|${r['ParcelID']}`, {
          dedupe_key: `${county}|${r['ParcelID']}`, list_name: listName, county, parcel: str(r['ParcelID']),
          jurisdiction: str(r['Jurisdiction']) || str(r['City']), address: str(r['Address']), zoning: str(r['Zoning']),
          est_lots: num(r['EstLots']), lots_by_area: num(r['LotsByAreaOnly']), acres: ac, lot_sqft: num(r['LotSqFt']), frontage_ft: num(r['FrontageFt']),
          min_lot_sqft: num(r['MinLotSqFt']), min_width_ft: num(r['MinWidthFt']), corner: yes(r['CornerOrTwoStreets']),
          sewer_guess: str(r['SewerGuess']), tax_land_value: num(r['TaxLandValue']),
          flood_pct: fl != null && ac ? Math.round(100 * fl / ac) : undefined,
          owner_type: str(r['OwnerType']), owner_name: str(r['Owner']), owner_name2: str(r['Owner2']),
          mail_address: str(r['MailAddress']), mail_city: str(r['MailCity']), mail_state: str(r['MailState']), mail_zip: str(r['MailZip']),
          absentee: yes(r['Absentee']), out_of_state: yes(r['OutOfState']), year_bought: num(r['YearBought']), years_held: num(r['YearsHeld']),
          last_sale_price: num(r['LastSalePrice']), street: str(r['Street']), lat: num(r['Lat']), lng: num(r['Lon']), score: num(r['Score']),
          updated_at: new Date().toISOString(),
        });
      }
    }
    const rows = [...out.values()].map(o => { Object.keys(o).forEach(k => o[k] === undefined && delete o[k]); return o; });
    if (!rows.length) return toast('No Charlotte or Gaston tabs with parcels found in that file.');
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from('split_parcels').upsert(rows.slice(i, i + 500), { onConflict: 'dedupe_key' });
      if (error) return toast('Import failed: ' + error.message);
    }
    toast(`Imported ${rows.length} parcels. Your statuses, notes and pad prices were kept.`);
    vSplit();
  } catch (e) { toast('Import failed: ' + e.message); }
}

// Site-check results computed off-site (counties whose GIS can't be read from this page): [{dedupe_key, ...fields}]
async function spImportChecks(list) {
  if (!Array.isArray(list) || !list.length) return toast('No check results in that file.');
  let i = 0, ok = 0, bad = 0;
  async function w() {
    while (i < list.length) {
      const { dedupe_key, ...upd } = list[i++];
      if (!dedupe_key) { bad++; continue; }
      const { error } = await sb.from('split_parcels').update(upd).eq('dedupe_key', dedupe_key);
      if (error) bad++; else ok++;
    }
  }
  await Promise.all(Array.from({ length: 6 }, w));
  toast(`Saved site checks for ${ok} parcels${bad ? ', ' + bad + ' failed' : ''}.`);
  vSplit();
}
