// DLG HQ - Split Finder tab.
// Vacant parcels that can be split into 3+ legal lots on the existing road (exempt/minor split, no new street).
// Sell the extra lots to a builder to pay for the land, keep 1-2 lots free and clear.
// Candidates come from county GIS (zoning minimum lot size + width, measured road frontage) and are loaded by Claude
// or with the Import button. Pad prices are per county/zip settings until Canopy comps are added.
const SP = {
  county: 'Charlotte', status: '', owner: '', q: '', pencil: true, sewer: false, clean: true, rows: [],
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
// Conservative lot count: lots that fit along the single longest road (corner second streets don't add lots),
// with 5% width margin, and lot area padded 30% for odd shapes, driveways and setbacks. 3+ real lots or it's out.
function spLots(r) {
  const w = r.min_width_ft || 0, m = r.min_lot_sqft || 0; if (!w || !m) return 0;
  const roads = [...String(r.road_name || '').matchAll(/\((\d+) ft\)/g)].map(x => +x[1]);
  const front = roads.length ? Math.max(...roads) : (r.frontage_ft || 0);
  return Math.min(Math.floor(front / (w * 1.05)), Math.floor((r.lot_sqft || 0) / (m * 1.3)));
}
function spCountyName(r) { return r.county === 'Charlotte' ? 'Mecklenburg County' : r.county === 'Gaston' ? 'Gaston County' : (r.county || '') + ' County'; }
function spMath(r) {
  const lots = Math.min(spLots(r), SP.maxLots);
  const sell = Math.max(0, lots - SP.keep);
  const pad = spPad(r);
  const maxOffer = sell * pad - SP.costs - (SP.cushion || 0);
  const ask = r.tax_land_value || 0;
  const room = maxOffer - ask;
  const ok = lots >= Math.max(3, SP.keep + 1) && maxOffer > 0 && !!r.pad_price;
  const grade = !r.pad_price ? 'No comp' : !ok || room < 0 ? 'No' : room >= SP.goal ? 'Profit' : 'Free lot';
  return { lots, sell, pad, maxOffer, ask, grade, pencils: grade === 'Profit' || grade === 'Free lot', profit: grade === 'Profit', cushion: room };
}
function spCk(r) { try { return JSON.parse(r.checks_done || '{}') || {}; } catch (e) { return {}; } }
function spChecked(r) { return spCk(r).v >= 1; }
function spSite(r) {
  const f = [], c = spCk(r);
  if (r.floodway) f.push(['Floodway', 'bad']);
  if (r.flood_pct >= 25) f.push([`${r.flood_pct}% flood`, 'bad']); else if (r.flood_pct >= 5) f.push([`${r.flood_pct}% flood`, 'warn']);
  if (r.slope_pct >= 15) f.push([`${r.slope_pct}% slope`, 'bad']); else if (r.slope_pct >= 8) f.push([`${r.slope_pct}% slope`, 'warn']);
  if (c.below_road_ft != null && c.below_road_ft >= 10) f.push([`${c.below_road_ft} ft below road`, 'bad']); else if (c.below_road_ft >= 5) f.push([`${c.below_road_ft} ft below road`, 'warn']);
  if (c.band_slope_pct >= 15) f.push([`Steep near road ${c.band_slope_pct}%`, 'bad']); else if (c.band_slope_pct >= 10) f.push([`Sloped near road ${c.band_slope_pct}%`, 'warn']);
  if (spChecked(r) && !r.frontage_ft) f.push(['No road frontage found', 'bad']);
  if (r.road_public === false) f.push(['Private road?', 'warn']);
  if (r.shape_ok === false) f.push(['Odd shape', 'warn']);
  if (r.subdivision) f.push(['Platted: check covenants', 'warn']);
  const sb2 = spSetback(r); if (sb2 && (sb2.ed < 20 || sb2.ew < 16)) f.push([`House won't fit (${sb2.ew}×${sb2.ed} ft)`, 'bad']); else if (sb2 && !sb2.ok) f.push(['Setbacks tight', 'warn']);
  if (/\(|CD|HDO|ANDO|PED|TOD|MUDD|-O\b/i.test(String(r.zoning || '').replace(/^N1-[A-F]$/, ''))) f.push(['Zoning conditions/overlay', 'warn']);
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
// Setbacks (Charlotte N1 districts; secondary source, confirm with the UDO): does a house envelope fit each lot?
const SP_SB = { 'N1-A': [27, 5, 40], 'N1-B': [27, 5, 35], 'N1-C': [17, 5, 30], 'N1-D': [17, 5, 25] };
function spSetback(r) {
  const z = String(r.zoning || '').match(/N1-[A-D]/); if (!z || !r.frontage_ft || !r.lot_sqft) return null;
  const [fr, side, rear] = SP_SB[z[0]], lots = Math.max(1, Math.min(spLots(r) || 1, SP.maxLots));
  const w = r.frontage_ft / lots, d = r.lot_sqft / r.frontage_ft, ew = Math.round(w - 2 * side), ed = Math.round(d - fr - rear);
  return { ok: ew >= 24 && ed >= 30, ew, ed, zone: z[0], fr, side, rear };
}
// Clean = no red flags and no yellow flags (a recorded plat and watershed notes are allowed; check covenants before an offer).
function spClean(r) { return !spSite(r).some(x => x[1] === 'bad' || (x[1] === 'warn' && !/^Platted|^Watershed/.test(x[0]))) && spChecked(r); }
function spPill(t, k) {
  const s = k === 'bad' ? 'background:#fde8e8;color:#a61b1b' : k === 'warn' ? 'background:#fff4d6;color:#7a5a00' : k === 'good' ? 'background:#e3f4ea;color:#1a7a45' : 'background:#f1f1f1;color:#666';
  return `<span class="pill" style="${s}">${esc(t)}</span>`;
}
function spSewerPill(r) { const g = String(r.sewer_guess || ''); return /^likely/i.test(g) ? spPill('Sewer likely', 'good') : /^unlikely/i.test(g) ? spPill('Septic area', '') : spPill('Sewer ?', ''); }

async function vSplit() {
  if (SP.map) { try { SP.map.remove(); } catch (e) { } SP.map = null; SP.mapFitted = false; }
  $('view').innerHTML = '<div class="muted">Loading…</div>';
  const t = await spAll();
  if (t.error) {
    $('view').innerHTML = `<div class="card">Split Finder isn't set up yet: ${esc(t.error.message)}<div class="small muted" style="margin-top:6px">Run split.sql once in the Supabase SQL editor, then reload.</div></div>`;
    return;
  }
  SP.rows = t.data || [];
  try { const b = await sb.from('buyers').select('name,company,counties,cities,zips,lot_sizes,utilities,deal_breakers,price_ranges').range(0, 4999); const seen = new Set(); SP.buyers = (b.data || []).filter(x => (x.price_ranges || (x.lot_sizes && x.lot_sizes.length) || x.utilities) && !/^test/i.test(x.company || x.name || '')).filter(x => { const k = String(x.company || x.name).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); } catch (e) { SP.buyers = []; }
  $('actions').innerHTML = `<input type="file" id="spFile" accept=".xlsx" style="display:none" onchange="spImport(this.files[0])"><button class="btn ghost" onclick="$('spFile').click()">Import split list (.xlsx)</button>`;
  const counties = [...new Set(SP.rows.map(r => r.county).filter(Boolean))].sort();
  const owners = [...new Set(SP.rows.map(r => r.owner_type).filter(Boolean))].sort();
  const num = (id, v, step) => `<input id="${id}" type="number" step="${step || 1000}" value="${v}" style="width:96px" onchange="spSet()">`;
  $('view').innerHTML = `
    <div class="card" style="padding:12px 14px">
      <details><summary style="cursor:pointer;font-weight:600">How the Split Finder works</summary>
        <ol class="small" style="margin:8px 0 0 18px;line-height:1.6">
          <li><b>Every parcel here is vacant</b> and big enough, with enough road frontage, to cut into 3+ lots that meet its zoning's minimum lot size and width on the road it already has (no new street, so it's an exempt or minor split, not a subdivision).</li>
          <li><b>Lots</b> (conservative) = the smaller of (frontage on the single longest road ÷ minimum width, plus 5%) and (area ÷ minimum lot size, plus 30% for odd shapes). A second street on a corner does not add lots. Under 3 lots = out. The surveyor confirms.</li><li><b>Pad price</b> comes from Canopy closed lot sales (last 18 months) near the parcel with the same sewer/septic and a similar lot size: the median of 3+ comps, or the lower one when there are only 1-2. The source line shows the nearest comp's ML#. No comp = hidden until you add a price.</li>
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
        <select style="width:auto" onchange="SP.county=this.value;vSplitDraw()">${counties.map(c => `<option value="${esc(c)}" ${SP.county === c ? 'selected' : ''}>${esc(spCountyName({ county: c }))}</option>`).join('')}<option value="" ${SP.county ? '' : 'selected'}>Both counties</option></select>
        <select style="width:auto" onchange="SP.owner=this.value;vSplitDraw()"><option value="">Any owner</option>${owners.map(c => `<option ${SP.owner === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select style="width:auto" onchange="SP.status=this.value;vSplitDraw()"><option value="">Any status</option>${SP_STATUSES.map(([k, l]) => `<option value="${k}" ${SP.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" style="width:auto" ${SP.pencil ? 'checked' : ''} onchange="SP.pencil=this.checked;vSplitDraw()"> Profit only (hide break-even)</label>
        <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" style="width:auto" ${SP.clean ? 'checked' : ''} onchange="SP.clean=this.checked;vSplitDraw()"> Clean only (no red or yellow flags)</label>
        <label class="small" style="display:flex;gap:4px;align-items:center" title="Off = people, churches, heirs and family trusts only. Builders never show."><input type="checkbox" style="width:auto" ${SP.companies ? 'checked' : ''} onchange="SP.companies=this.checked;vSplitDraw()"> Include companies held 20+ yrs</label>
        <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" style="width:auto" ${SP.checked ? 'checked' : ''} onchange="SP.checked=this.checked;vSplitDraw()"> Checked only</label>
        <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" style="width:auto" ${SP.sewer ? 'checked' : ''} onchange="SP.sewer=this.checked;vSplitDraw()"> Sewer likely only</label>
        <input placeholder="Search owner, address, parcel, zip" style="width:240px" value="${esc(SP.q)}" oninput="SP.q=this.value;vSplitDraw()">
        <span class="small muted" id="spCount"></span>
      </div>
    </div>
    <div class="seg" id="spViews" style="margin:0 0 10px">${[['list', 'List'], ['map', 'Map'], ['spot', 'Spot check']].map(([k, l]) => `<button class="${SP.view === k ? 'on' : ''}" onclick="SP.view='${k}';vSplitDraw()">${l}</button>`).join('')}</div>
    <div class="card" id="spListWrap" style="padding:0;overflow-x:auto"><table class="ctable" id="spTable"></table></div>
    <div class="card" id="spMapWrap" style="padding:0;display:none"><div id="spMap" style="height:72vh;min-height:420px;border-radius:8px"></div></div>
    <div id="spSpotWrap" style="display:none"></div>`;
  vSplitDraw();
}

function spSet() {
  SP.keep = Number($('spKeep').value); SP.maxLots = Number($('spMax').value);
  SP.costs = Number($('spCosts').value) || 0; SP.goal = Number($('spGoal').value) || 0; SP.cushion = Number($('spCushion').value) || 0;
  for (const c of Object.keys(SP.pads)) { const el = $('spPad_' + c); if (el) SP.pads[c] = Number(el.value) || SP.pads[c]; }
  spSaveSettings(); vSplitDraw();
}

// Owners worth calling: individuals, churches, heirs/estates and family trusts. Companies (LLCs, builders, developers)
// already know what the land can do, so they're out; old company owners (20+ yrs, not builders) can be shown on purpose.
const SP_BUILDER = /\b(homes?|builders?|building|construction|development|developers?|communities|residential|land co|pulte|lennar|horton|nvr|ryan|toll|meritage|taylor morrison|stanley martin|true homes|mattamy|dream finders|eastwood|david weekley|shea|ashton woods|century|lgi|smith douglas|tri pointe|m\/i)\b/i;
function spIsCompany(r) { const n = String(r.owner_name || ''); if (/church|heirs|estate/i.test((r.owner_type || '') + ' ' + n)) return false; if (/\btrust(ee)?\b|revocable|living trust|\btr\b/i.test(n) && !/\b(llc|inc|corp)\b/i.test(n)) return false; return r.owner_type === 'Company/trust' || /\b(llc|l\.l\.c|inc|corp|corporation|company|co\b|lp|ltd|holdings|partners|properties|investments|realty|group)\b/i.test(n); }
function spIsBuilder(r) { return spIsCompany(r) && SP_BUILDER.test(String(r.owner_name || '')); }
function spFiltered() {
  const q = SP.q.trim().toLowerCase();
  return SP.rows.filter(r => {
    if (SP.county && r.county !== SP.county) return false;
    if (SP.owner && r.owner_type !== SP.owner) return false;
    if (spIsBuilder(r)) return false;
    if (spIsCompany(r) && !(SP.companies && (r.years_held || 0) >= 20)) return false;
    if (SP.status && (r.my_status || 'new') !== SP.status) return false;
    if (SP.pencil && !spMath(r).profit) return false;
    if (SP.clean && !spClean(r)) return false;
    if (SP.sewer && !/^likely/i.test(r.sewer_guess || '')) return false;
    if (SP.checked && !spChecked(r)) return false;
    if (q && ![r.owner_name, r.owner_name2, r.address, r.parcel, r.mail_city, r.mail_zip, r.zoning].some(x => String(x || '').toLowerCase().includes(q))) return false;
    return true;
  }).map(r => ({ r, m: spMath(r) })).sort((a, b) => (b.m.pencils - a.m.pencils) || (b.m.cushion - a.m.cushion));
}

// Builders whose buy box fits this parcel (area, sewer requirement, lot size, deal breakers). Live from the Buyers table.
const SP_CO = { Charlotte: 'Mecklenburg', Gaston: 'Gaston' };
function spBuyers(r) {
  const co = SP_CO[r.county] || r.county, city = String(r.jurisdiction || r.county || '').replace(/\s*\(.*\)/, '').replace(/^Gaston Co\.?.*/i, '').trim().toLowerCase();
  const lotAc = r.acres && spLots(r) ? r.acres / Math.max(1, Math.min(spLots(r), SP.maxLots)) : null;
  const bucket = lotAc == null ? null : lotAc < .25 ? 'Under 1/4 acre' : lotAc < .5 ? '1/4 to 1/2 acre' : lotAc < 1 ? '1/2 to 1 acre' : lotAc < 5 ? '1 to 5 acres' : '5+ acres';
  const sewerNo = /^unlikely/i.test(r.sewer_guess || ''), c = spCk(r);
  return (SP.buyers || []).filter(b => {
    const cs = (b.counties || []).map(x => String(x).toLowerCase()), ct = String(b.cities || '').toLowerCase();
    const geo = cs.some(x => x.includes(co.toLowerCase())) || (city && ct.includes(city)) || (r.county === 'Charlotte' && /charlotte/.test(ct)) || /within .*charlotte|charlotte (area|region|metro)|surrounding/.test(ct);
    if (!geo) return false;
    const u = String(b.utilities || '');
    if (sewerNo && /public water and sewer only/i.test(u) && !/septic is ok/i.test(u)) return false;
    if (bucket && b.lot_sizes && b.lot_sizes.length && !String(b.lot_sizes).includes(bucket)) return false;
    const db = String(b.deal_breakers || '').toLowerCase();
    if (/flood|fz/.test(db) && (r.flood_pct >= 5 || r.floodway)) return false;
    if (/steep|slope|topo|hill|drop/.test(db) && (r.slope_pct >= 10 || c.band_slope_pct >= 10 || c.below_road_ft >= 5)) return false;
    if (/easement|power/.test(db) && c.power_line) return false;
    if (/hoa/.test(db) && r.subdivision) return false;
    return true;
  }).map(b => b.company || b.name);
}
function vSplitDraw() {
  const v = SP.view || 'list';
  document.querySelectorAll('#spViews button').forEach((b, i) => b.classList.toggle('on', ['list', 'map', 'spot'][i] === v));
  if ($('spListWrap')) { $('spListWrap').style.display = v === 'list' ? '' : 'none'; $('spMapWrap').style.display = v === 'map' ? '' : 'none'; $('spSpotWrap').style.display = v === 'spot' ? '' : 'none'; }
  if (v === 'map') return spDrawMap();
  if (v === 'spot') return spDrawSpot();
  const t = $('spTable'); if (!t) return;
  const rows = spFiltered();
  const c = $('spCount'); if (c) c.textContent = `${rows.length} clean deals in ${SP.county ? spCountyName({ county: SP.county }) : 'both counties'}`;
  const head = `<tr><th>Site</th><th>Parcel</th><th>Owner</th><th class="right">Lots</th><th class="right">Frontage</th><th class="right">Most I can pay</th><th class="right">Tax land value</th><th>Buyers who fit</th><th>My status</th><th></th></tr>`;
  if (!rows.length) { t.innerHTML = head + `<tr><td colspan="10" class="muted">${SP.rows.length ? 'Nothing matches. Try turning off "Profit or free lot only" or raising the pad price.' : 'No parcels yet. Claude loads them, or click "Import split list (.xlsx)".'}</td></tr>`; return; }
  t.innerHTML = head + rows.slice(0, 1500).map(({ r, m }) => `<tr>
      <td>${spPill(m.grade, m.grade === 'Profit' ? 'good' : m.grade === 'Free lot' ? 'warn' : 'bad')} ${spSewerPill(r)}<div style="margin-top:3px">${spSite(r).map(x => spPill(x[0], x[1])).join(' ')}</div></td>
      <td><b>${esc(r.address || '(no site address)')}</b><div class="small muted">${esc(r.jurisdiction || r.county || '')} · ${esc(r.zoning || '')} · ${esc(r.parcel || '')} · ${r.acres ?? ''} ac</div></td>
      <td>${esc(r.owner_name || '')}<div class="small muted">${esc(r.owner_type || '')}${r.years_held != null ? ' · ' + Math.round(r.years_held) + ' yrs' : ''}${r.out_of_state ? ' · out of state' : ''}</div></td>
      <td class="right num">${m.lots}</td>
      <td class="right num">${r.frontage_ft != null ? Math.round(r.frontage_ft) + ' ft' : '—'}</td>
      <td class="right num"><b style="color:${m.pencils ? '#1a7a45' : '#a61b1b'}">${money(m.maxOffer)}</b><div class="small muted">sell ${m.sell} × ${money(m.pad)}</div></td>
      <td class="right num">${r.tax_land_value != null ? money(r.tax_land_value) : '—'}</td>
      <td class="small">${(() => { const b = spBuyers(r); return b.length ? `<b>${b.length}</b> <span class="muted">${esc(b.slice(0, 2).join(', '))}${b.length > 2 ? '…' : ''}</span>` : '<span class="muted">none</span>'; })()}</td>
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
  openDrawer(`<div class="dhead"><div><div class="small muted"><b>${esc(spCountyName(r))}</b> · ${esc(r.jurisdiction || r.county || '')}</div><h2 style="margin:2px 0 0">${esc(r.address || r.parcel || 'Parcel')}</h2><div class="small muted">${r.acres ?? ''} acres · ${esc(r.zoning || '')} · parcel ${esc(r.parcel || '')}</div></div><button class="btn ghost" onclick="closeDrawer()">Close</button></div>
    <div class="card"><div style="font-size:15px">${m.grade === 'Profit' ? spPill('Profit + free lot', 'good') : m.grade === 'Free lot' ? spPill('Free lot (break even)', 'warn') : spPill(m.grade === 'No comp' ? 'No Canopy comp yet: add a pad price below' : "Doesn't work at these numbers", 'bad')}</div>
      <div class="small" style="margin-top:8px;line-height:1.7">
        ${m.lots} lots on ${esc(String(r.road_name || '').split(/\s*\(/)[0] || 'the road')} − keep ${SP.keep} = sell ${m.sell} × ${money(m.pad)} pad${r.pad_price_source ? ' <span class="muted">(' + esc(r.pad_price_source) + ')</span>' : ''} = ${money(m.sell * m.pad)}<br>
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
      ${line('Setbacks', (() => { const x = spSetback(r); return x ? `${x.zone}: front ${x.fr}, sides ${x.side}, rear ${x.rear} ft → each lot leaves about <b>${x.ew} ft × ${x.ed} ft</b> to build${x.ok ? '' : ' · <b>tight: check the house fits</b>'} <span class="small muted">(setbacks from a secondary source; confirm with the UDO)</span>` : (r.county === 'Charlotte' ? null : 'Not checked for this county yet'); })())}
      ${line('Recorded plat', r.subdivision ? esc(r.subdivision) + ' <span class="small muted">(check covenants/restrictions before offering)</span>' : null)}
      ${line('Sewer', esc(r.sewer_guess || ''))}
      ${line('Flood (FEMA)', r.flood_pct != null ? `${r.flood_pct}% in the 100-year flood zone${r.floodway ? ' · includes floodway (can\'t build)' : ''}` : 'Not checked yet')}
      ${line('Slope / grade', r.slope_pct != null ? `${r.slope_pct}% average · ${spCk(r).relief_ft ?? '?'} ft high-to-low · ${spCk(r).below_road_ft == null ? 'road height unknown' : spCk(r).below_road_ft > 0 ? spCk(r).below_road_ft + ' ft below the road' : spCk(r).below_road_ft < 0 ? -spCk(r).below_road_ft + ' ft above the road' : 'level with the road'} <span class="small muted">(USGS 1 m lidar)</span>` : 'Not checked yet')}
      ${line('Shape', r.shape_ok == null ? null : r.shape_ok ? 'Regular enough to cut into lots' : 'Irregular (flag lot, taper or skinny strip): surveyor must confirm the lot layout')}
      ${line('Tree cover', r.tree_pct != null ? `${r.tree_pct}% (NLCD canopy)` : 'Not checked yet')}
      ${line('Owner', esc(r.owner_name || '') + (r.owner_name2 ? '<div class="small muted">' + esc(r.owner_name2) + '</div>' : '') + `<div class="small muted">${esc(r.owner_type || '')}</div>`)}
      ${line('Mailing address', esc([r.mail_address, r.mail_city, r.mail_state, r.mail_zip].filter(Boolean).join(', ')))}
      ${line('Held', r.years_held != null ? `${Math.round(r.years_held)} years${r.year_bought ? ' (since ' + r.year_bought + ')' : ''}${r.last_sale_price ? ' · paid ' + money(r.last_sale_price) : ''}` : null)}
      ${line('Buyers who fit', spBuyers(r).map(esc).join(' · ') || 'No buy box fits yet (area, sewer, lot size or deal breakers)')}
      ${line('Links', links || null)}
    </table></div>
    <div class="card"><h3 class="sec" style="margin-top:0">Spot check</h3>
      ${r.reviewed ? `<div class="small" style="margin-bottom:6px">Checked: ${esc(spReview(r).result || '')} ${spReview(r).issues && spReview(r).issues.length ? '· ' + esc(spReview(r).issues.join(', ')) : ''} ${spReview(r).note ? '· ' + esc(spReview(r).note) : ''}</div>` : ''}
      <div class="row" style="gap:6px;flex-wrap:wrap">${['Frontage', 'Flood', 'Slope', 'Road', 'Zoning', 'Lot count', 'Creek/wetland', 'Other'].map(k => `<label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" class="spIss" value="${k}" style="width:auto" ${(spReview(r).issues || []).includes(k) ? 'checked' : ''}> ${k}</label>`).join('')}</div>
      <input id="sp_rnote" placeholder="What's wrong (optional)" value="${esc(spReview(r).note || '')}" style="margin-top:6px">
      <div class="row" style="gap:8px;margin-top:8px"><button class="btn" onclick="spSaveReview(${r.id},'Looks right')">Looks right</button><button class="btn ghost" onclick="spSaveReview(${r.id},'Wrong')">Wrong (save what's checked)</button></div></div>
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

function spReview(r) { try { return JSON.parse(r.review_notes || '{}') || {}; } catch (e) { return { note: r.review_notes }; } }
async function spSaveReview(id, result) {
  const issues = [...document.querySelectorAll('.spIss:checked')].map(x => x.value), note = ($('sp_rnote') || {}).value || '';
  if (result === 'Wrong' && !issues.length && !note) return toast('Check what is wrong, or add a note.');
  const upd = { reviewed: true, review_notes: JSON.stringify({ result, issues: result === 'Wrong' ? issues : [], note, at: new Date().toISOString().slice(0, 10) }), updated_at: new Date().toISOString() };
  const { error } = await sb.from('split_parcels').update(upd).eq('id', id);
  if (error) return toast(error.message);
  const r = SP.rows.find(x => x.id === id); if (r) Object.assign(r, upd);
  toast('Spot check saved'); closeDrawer(); vSplitDraw();
}
// Spot check sample: per county, 10 from the top of the clean list + 10 random clean (stable across visits).
function spSample() {
  const out = [];
  for (const c of [...new Set(SP.rows.map(r => r.county))].filter(c => !SP.county || c === SP.county).sort()) {
    const clean = SP.rows.filter(r => r.county === c && !spIsBuilder(r) && !spIsCompany(r) && spClean(r) && spMath(r).profit).map(r => ({ r, m: spMath(r) })).sort((a, b) => b.m.cushion - a.m.cushion).map(x => x.r);
    const top = clean.slice(0, 10), rest = clean.slice(10);
    const h = x => { let v = 0; for (const ch of String(x.dedupe_key)) v = (v * 31 + ch.charCodeAt(0)) >>> 0; return v; };
    const rnd = rest.slice().sort((a, b) => h(a) - h(b)).slice(0, 10);
    out.push({ county: c, rows: top.map(r => ({ r, why: 'Top of list' })).concat(rnd.map(r => ({ r, why: 'Random' }))) });
  }
  return out;
}
function spDrawSpot() {
  const el = $('spSpotWrap'); if (!el) return;
  const S = spSample();
  el.innerHTML = `<div class="card small" style="line-height:1.6"><b>How to spot check:</b> open each parcel, compare against Polaris / the county map (frontage with the measure tool), FEMA, Street View (slope, road, below-road) and the zoning map. Click <b>Looks right</b>, or tick what's wrong and click <b>Wrong</b>. If 2+ of 20 miss on the same check, that check gets fixed and the county is rerun.</div>`
    + S.map(g => { const done = g.rows.filter(x => x.r.reviewed).length, bad = g.rows.filter(x => spReview(x.r).result === 'Wrong').length;
      return `<div class="card" style="padding:0;overflow-x:auto"><div style="padding:10px 14px"><b>${esc(spCountyName({ county: g.county }))}</b> <span class="small muted">${done} of ${g.rows.length} checked${bad ? ' · ' + bad + ' wrong' : ''}</span></div><table class="ctable"><tr><th></th><th>Parcel</th><th class="right">Lots</th><th class="right">Frontage</th><th>Flags</th><th>Result</th><th></th></tr>`
        + g.rows.map(({ r, why }) => `<tr><td class="small muted">${why}</td><td><b>${esc(r.address || r.parcel)}</b><div class="small muted">${esc(r.zoning || '')} · parcel ${esc(r.parcel)} · ${r.acres} ac · pad ${money(spMath(r).pad)}</div></td><td class="right num">${spMath(r).lots}</td><td class="right num">${r.frontage_ft != null ? Math.round(r.frontage_ft) + ' ft' : '—'}</td><td>${spSite(r).map(x => spPill(x[0], x[1])).join(' ')}</td><td class="small">${r.reviewed ? esc(spReview(r).result) + (spReview(r).issues && spReview(r).issues.length ? ': ' + esc(spReview(r).issues.join(', ')) : '') : '<span class="muted">not yet</span>'}</td><td><button class="btn ghost sm" onclick="spOpen(${r.id})">Open</button></td></tr>`).join('') + '</table></div>'; }).join('');
}
// Map: satellite/streets, county parcel lines, zoning, FEMA flood, creeks, wetlands, power lines, watersheds; split parcels as pins by grade.
function spLoadMap() {
  if (window.L && L.esri) return Promise.resolve();
  const add = (tag, attrs) => new Promise((res, rej) => { const e = document.createElement(tag); Object.assign(e, attrs); e.onload = res; e.onerror = () => rej(new Error('Could not load the map library')); document.head.appendChild(e); });
  return (window.L ? Promise.resolve() : add('link', { rel: 'stylesheet', href: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css' }).then(() => add('script', { src: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js' })))
    .then(() => add('script', { src: 'https://unpkg.com/esri-leaflet@3.0.12/dist/esri-leaflet.js' }));
}
async function spDrawMap() {
  try { await spLoadMap(); } catch (e) { $('spMap').innerHTML = '<div class="muted" style="padding:20px">' + esc(e.message) + '</div>'; return; }
  if (!SP.map) {
    const m = SP.map = L.map('spMap', { preferCanvas: true }).setView([35.25, -80.95], 10);
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, attribution: 'Esri imagery' });
    const streets = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, attribution: 'Esri' }).addTo(m);
    const dyn = (url, layers, opacity, minZoom) => L.esri.dynamicMapLayer({ url, layers, opacity: opacity || 0.6, f: 'image', minZoom: minZoom || 0 });
    const overlays = {
      'Parcel lines': (SP.lines = L.layerGroup()),
      'Zoning (Charlotte)': dyn('https://gis.charlottenc.gov/arcgis/rest/services/PLN/Zoning/MapServer', [0], 0.45, 13),
      'Zoning (Gaston + towns)': dyn('https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Zoning/MapServer', [1, 2, 10, 11, 15, 16, 20], 0.45, 13),
      'FEMA flood zones': dyn('https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer', [28], 0.5, 12),
      'Creeks (USGS)': dyn('https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer', [6], 0.9, 13),
      'Wetlands (USFWS)': dyn('https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer', [0], 0.5, 13),
      'Power transmission lines': L.esri.featureLayer({ url: 'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0', minZoom: 12, style: () => ({ color: '#ff3b30', weight: 3 }) }),
      'Water-supply watersheds': L.esri.featureLayer({ url: 'https://services2.arcgis.com/kCu40SDxsCGcuUWO/ArcGIS/rest/services/dwq_wsws_20141126/FeatureServer/0', minZoom: 9, style: () => ({ color: '#2b6cb0', weight: 1, fillOpacity: .08 }) }),
    };
    overlays['Parcel lines'].addTo(m);
    m.on('moveend', spParcelLines);
    SP.pins = L.layerGroup().addTo(m);
    L.control.layers({ Streets: streets, Satellite: sat }, { 'Split parcels': SP.pins, ...overlays }, { collapsed: true }).addTo(m);
    const lg = L.control({ position: 'bottomleft' }); lg.onAdd = () => { const d = L.DomUtil.create('div'); d.style.cssText = 'background:#fff;padding:6px 8px;border-radius:6px;font-size:12px;line-height:1.5'; d.innerHTML = '<span style="color:#1a7a45">●</span> Profit &nbsp;<span style="color:#c08a00">●</span> Free lot &nbsp;<span style="color:#a61b1b">●</span> No &nbsp;<span style="color:#555">○</span> red flag'; return d; }; lg.addTo(m);
  }
  setTimeout(() => SP.map.invalidateSize(), 50);
  SP.pins.clearLayers();
  const rows = spFiltered(), pts = [];
  for (const { r, m } of rows) {
    if (!r.lat || !r.lng) continue;
    const col = m.grade === 'Profit' ? '#1a7a45' : m.grade === 'Free lot' ? '#c08a00' : '#a61b1b', bad = !spClean(r);
    const mk = L.circleMarker([r.lat, r.lng], { radius: 7, color: bad ? '#555' : '#fff', weight: 2, fillColor: col, fillOpacity: bad ? .35 : .9 });
    mk.bindTooltip(`${esc(r.address || r.parcel)} · ${m.lots} lots · ${esc(m.grade)}`);
    mk.on('click', () => spOpen(r.id)); mk.addTo(SP.pins); pts.push([r.lat, r.lng]);
  }
  const c = $('spCount'); if (c) c.textContent = `${pts.length} on the map in ${SP.county ? spCountyName({ county: SP.county }) : 'both counties'}`;
  spParcelLines();
  if (pts.length && !SP.mapFitted) { SP.map.fitBounds(pts, { padding: [20, 20], maxZoom: 15 }); SP.mapFitted = true; }
}

// Parcel outlines in view (zoom 16+), as vector lines from the county GIS. JSONP so it works for counties without CORS.
function spJsonp(url, params) {
  return new Promise((res, rej) => {
    const cb = '_spcb' + Math.random().toString(36).slice(2), sc = document.createElement('script');
    const t = setTimeout(() => { cleanup(); rej(new Error('timeout')); }, 20000);
    function cleanup() { clearTimeout(t); delete window[cb]; sc.remove(); }
    window[cb] = j => { cleanup(); res(j); };
    sc.src = url + '?' + new URLSearchParams({ ...params, f: 'json', callback: cb }); sc.onerror = () => { cleanup(); rej(new Error('load failed')); };
    document.head.appendChild(sc);
  });
}
const SP_PARCEL_SRC = [
  { url: 'https://gis.charlottenc.gov/arcgis/rest/services/PLN/AllParcelData/MapServer/0/query', id: 'parcelid', county: 'Charlotte', box: [-81.06, 35.0, -80.55, 35.52] },
  { url: 'https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Parcels/MapServer/11/query', id: 'PIN', county: 'Gaston', box: [-81.46, 35.14, -80.92, 35.42] },
];
async function spParcelLines() {
  if (!SP.map || !SP.lines || !SP.map.hasLayer(SP.lines)) return;
  const m = SP.map, z = m.getZoom(), seq = (SP.lineSeq = (SP.lineSeq || 0) + 1);
  if (z < 16) { SP.lines.clearLayers(); return; }
  const b = m.getBounds(), env = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const byKey = new Map(SP.rows.map(r => [r.county + '|' + r.parcel, r]));
  const feats = [];
  for (const src of SP_PARCEL_SRC) {
    if (env[2] < src.box[0] || env[0] > src.box[2] || env[3] < src.box[1] || env[1] > src.box[3]) continue;
    try {
      const j = await spJsonp(src.url, { geometry: env.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: src.id, returnGeometry: 'true', resultRecordCount: '1500', geometryPrecision: '6' });
      for (const f of j.features || []) feats.push({ src, f });
    } catch (e) { }
  }
  if (seq !== SP.lineSeq) return;
  SP.lines.clearLayers();
  for (const { src, f } of feats) {
    const r = byKey.get(src.county + '|' + f.attributes[src.id]);
    const ll = (f.geometry.rings || []).map(rr => rr.map(([x, y]) => [y, x]));
    if (r) {
      const g = spMath(r).grade, col = g === 'Profit' ? '#22c55e' : g === 'Free lot' ? '#facc15' : '#ef4444';
      L.polygon(ll, { color: col, weight: 3, fillOpacity: .12 }).bindTooltip(`${esc(r.address || r.parcel)} · ${spMath(r).lots} lots · ${g}`).on('click', () => spOpen(r.id)).addTo(SP.lines);
    } else L.polygon(ll, { color: '#fde68a', weight: 1, fill: false, interactive: false }).addTo(SP.lines);
  }
}
