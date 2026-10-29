// DLG HQ - Acreage Play tab.
// Tracts, builder buyers and comps come from the "REVIEW - NC Acreage List" spreadsheet (Import button).
// Sewer tiers are map-based; always confirm capacity with the utility before an offer.
const AC = { tab: 'tracts', tier: '1', county: '', status: '', q: '', ready: false, rows: [], buyers: [], comps: [] };
const AC_STATUSES = [['new', 'New'], ['mailed', 'Mailed'], ['contacting', 'Contacting owner'], ['utility', 'Utility check'], ['offer', 'Offer made'], ['contract', 'Under contract'], ['dead', 'Dead']];
const AC_TIERS = { '1': 'Sewer likely', '2': 'Sewer nearby', '3': 'Well/septic area' };

function acTierPill(t) {
  const k = String(t || '').charAt(0);
  const s = k === '1' ? 'background:#e3f4ea;color:#1a7a45' : k === '2' ? 'background:#fff4d6;color:#7a5a00' : 'background:#f1f1f1;color:#777';
  return `<span class="pill" style="${s}">${esc(AC_TIERS[k] || t || '—')}</span>`;
}

async function vAcreage() {
  $('view').innerHTML = '<div class="muted">Loading…</div>';
  const [t, b, c] = await Promise.all([
    sb.from('acreage_tracts').select('*').order('score', { ascending: false }).range(0, 4999),
    sb.from('acreage_buyers').select('*').order('acres', { ascending: false }).range(0, 1999),
    sb.from('acreage_comps').select('*'),
  ]);
  if (t.error) {
    $('view').innerHTML = `<div class="card">Acreage Play isn't set up yet: ${esc(t.error.message)}<div class="small muted" style="margin-top:6px">Run acreage.sql once in the Supabase SQL editor, then reload.</div></div>`;
    return;
  }
  AC.rows = t.data || []; AC.buyers = b.data || []; AC.comps = c.data || [];
  $('actions').innerHTML = `<input type="file" id="acFile" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" style="display:none" onchange="acImport(this.files[0])"><button class="btn" onclick="$('acFile').click()">Import acreage list (.xlsx)</button>`;
  const counties = [...new Set(AC.rows.map(r => r.county).filter(Boolean))].sort();
  $('view').innerHTML = `
    <div class="card" style="padding:12px 14px">
      <details><summary style="cursor:pointer;font-weight:600">How the Acreage Play works</summary>
        <ol class="small" style="margin:8px 0 0 18px;line-height:1.6">
          <li><b>Follow the builders.</b> Every tract here is 15-150 acres, owned by an individual, with a builder or developer buying 10+ acres within 2 miles since July 2024.</li>
          <li><b>Sewer decides the fee.</b> Sewer land sells for 2-4x well/septic land. Tier 1 = sewer likely, Tier 2 = sewer nearby, Tier 3 = well/septic (homesite buyers, thin spread).</li>
          <li><b>Site check:</b> every tract is checked against the NCDOT road map and FEMA flood maps. "No road found" can still be a private drive or easement, so verify before writing it off. Over 50% flood usually kills the deal.</li>
          <li><b>Mail everyone a general acreage letter</b> (no blind offers on acreage). Call Tier 1 owners first.</li>
          <li><b>Price with the Comps tab</b>: start from the county median for that size, use the sewer comps on Tier 1 tracts.</li>
          <li><b>Call the utility before any offer</b> on a Tier 1 tract: capacity, gravity vs. pump, extension cost.</li>
          <li><b>Contract terms:</b> 60-90 day due diligence, $500-$1,000 refundable earnest money with Nicole, assignment clause, 90-120 day close. Target $50K+ fee.</li>
          <li><b>Assign</b> to a buyer on the Builder Buyers tab who bought near the tract.</li>
        </ol>
      </details>
      <div class="seg" id="acTabs" style="margin:10px 0 0">${[['tracts', 'Tracts'], ['buyers', 'Builder Buyers'], ['comps', 'Comps']].map(([k, l]) => `<button class="${AC.tab === k ? 'on' : ''}" onclick="AC.tab='${k}';vAcreageDraw()">${l}</button>`).join('')}</div>
      <div class="row" id="acFilters" style="gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <div class="seg" id="acTier" style="margin:0;flex:0 0 auto">${['1', '2', '3', 'All'].map(v => `<button class="${AC.tier === v ? 'on' : ''}" onclick="AC.tier='${v}';vAcreageDraw()">${v === 'All' ? 'All' : AC_TIERS[v]} <span id="acN_${v}" class="small"></span></button>`).join('')}</div>
        <select style="width:auto" onchange="AC.county=this.value;vAcreageDraw()"><option value="">All counties</option>${counties.map(c => `<option ${AC.county === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select style="width:auto" onchange="AC.status=this.value;vAcreageDraw()"><option value="">Any status</option>${AC_STATUSES.map(([k, l]) => `<option value="${k}" ${AC.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" style="width:auto" ${AC.ready ? 'checked' : ''} onchange="AC.ready=this.checked;vAcreageDraw()"> Mail-ready only (road found, under 50% flood)</label>
        <input placeholder="Search owner, road, parcel, buyer" style="width:240px" value="${esc(AC.q)}" oninput="AC.q=this.value;vAcreageDraw()">
      </div>
    </div>
    <div class="card" style="padding:0;overflow-x:auto"><table class="ctable" id="acTable"></table></div>`;
  vAcreageDraw();
}

function acMailReady(r) { return r.road_found === true && (r.flood_pct == null || r.flood_pct < 50) && !['dead', 'mailed'].includes(r.my_status || 'new'); }
function acSiteFlags(r) {
  const f = [];
  if (r.road_found === false) f.push('<span class="pill" style="background:#fde8e8;color:#a61b1b">No road found</span>');
  if (r.flood_pct >= 50) f.push(`<span class="pill" style="background:#fde8e8;color:#a61b1b">${r.flood_pct}% flood</span>`);
  else if (r.flood_pct >= 10) f.push(`<span class="pill" style="background:#fff4d6;color:#7a5a00">${r.flood_pct}% flood</span>`);
  return f.join(' ');
}
function acFiltered(ignoreTier) {
  const q = AC.q.trim().toLowerCase();
  return AC.rows.filter(r => {
    if (!ignoreTier && AC.tier !== 'All' && String(r.sewer_tier || '').charAt(0) !== AC.tier) return false;
    if (AC.county && r.county !== AC.county) return false;
    if (AC.status && (r.my_status || 'new') !== AC.status) return false;
    if (AC.ready && !acMailReady(r)) return false;
    if (q && ![r.owner_name, r.owner_name2, r.address, r.parcel, r.nearest_buyer, r.mail_city].some(x => String(x || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

function vAcreageDraw() {
  document.querySelectorAll('#acTabs button').forEach((b, i) => b.classList.toggle('on', ['tracts', 'buyers', 'comps'][i] === AC.tab));
  const f = $('acFilters'); if (f) f.style.display = AC.tab === 'tracts' ? 'flex' : 'none';
  const t = $('acTable'); if (!t) return;
  if (AC.tab === 'buyers') return acDrawBuyers(t);
  if (AC.tab === 'comps') return acDrawComps(t);
  document.querySelectorAll('#acTier button').forEach((b, i) => b.classList.toggle('on', ['1', '2', '3', 'All'][i] === AC.tier));
  const base = acFiltered(true);
  for (const v of ['1', '2', '3', 'All']) { const el = $('acN_' + v); if (el) el.textContent = '(' + (v === 'All' ? base.length : base.filter(r => String(r.sewer_tier || '').charAt(0) === v).length) + ')'; }
  const rows = acFiltered(false);
  const head = `<tr><th>Sewer</th><th>Owner</th><th>Tract</th><th class="right">Acres</th><th class="right">Land value</th><th>Builder buys nearby</th><th>My status</th><th></th></tr>`;
  if (!rows.length) { t.innerHTML = head + `<tr><td colspan="8" class="muted">${AC.rows.length ? 'No tracts match these filters.' : 'No tracts yet. Click "Import acreage list (.xlsx)" and pick the REVIEW - NC Acreage List file.'}</td></tr>`; return; }
  t.innerHTML = head + rows.slice(0, 1500).map(r => `<tr>
      <td>${acTierPill(r.sewer_tier)}<div style="margin-top:3px">${acSiteFlags(r)}</div></td>
      <td><b>${esc(r.owner_name || '')}</b><div class="small muted">${esc([r.mail_city, r.mail_state].filter(Boolean).join(', '))}</div></td>
      <td>${esc(r.address || '(no site address)')}<div class="small muted">${esc(r.county || '')} · ${esc(r.parcel || '')} · owned since ${esc(r.owned_since || '—')}</div></td>
      <td class="right num">${r.acres ?? '—'}</td>
      <td class="right num">${r.land_value != null ? money(r.land_value) : '—'}</td>
      <td class="small">${r.builder_buys_2mi ?? 0} within 2 mi<div class="muted">${esc(r.nearest_buyer || '')}${r.nearest_buyer_mi != null ? ' · ' + r.nearest_buyer_mi + ' mi' : ''}</div></td>
      <td><select style="width:auto" onchange="acSetStatus(${r.id},this.value)">${AC_STATUSES.map(([k, l]) => `<option value="${k}" ${(r.my_status || 'new') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>${r.my_notes ? '<div class="small muted" style="margin-top:3px">📝 has notes</div>' : ''}</td>
      <td><button class="btn ghost sm" onclick="acOpen(${r.id})">Details</button></td></tr>`).join('');
}

function acDrawBuyers(t) {
  const head = `<tr><th>Buyer (as recorded)</th><th class="right">10+ acre tracts since Jul 2024</th><th class="right">Acres</th><th>Counties</th><th>Last purchase</th><th>Mailing address</th></tr>`;
  if (!AC.buyers.length) { t.innerHTML = head + '<tr><td colspan="6" class="muted">No buyers yet. Import the acreage list.</td></tr>'; return; }
  t.innerHTML = head + AC.buyers.map(b => `<tr><td><b>${esc(b.name)}</b></td><td class="right num">${b.tracts ?? ''}</td><td class="right num">${b.acres ?? ''}</td><td class="small">${esc(b.counties || '')}</td><td>${fmtDate(b.last_purchase)}</td><td class="small">${esc(b.mail_address || '')}</td></tr>`).join('');
}

function acDrawComps(t) {
  const head = `<tr><th>County</th><th>Group</th><th class="right">Sales</th><th class="right">Median $/acre</th></tr>`;
  if (!AC.comps.length) { t.innerHTML = head + '<tr><td colspan="4" class="muted">No comps yet. Import the acreage list.</td></tr>'; return; }
  const ord = c => ['Union', 'Cabarrus', 'Lincoln', 'Gaston', 'Rowan'].indexOf(c.county) + 1 || 9;
  t.innerHTML = head + AC.comps.slice().sort((a, b) => ord(a) - ord(b) || a.county.localeCompare(b.county) || a.grp.localeCompare(b.grp)).map(c => `<tr><td>${esc(c.county)}</td><td>${esc(c.grp)}</td><td class="right num">${c.sales ?? ''}</td><td class="right num">${c.median_per_acre != null ? money(c.median_per_acre) : ''}</td></tr>`).join('')
    + `<tr><td colspan="4" class="small muted">Canopy MLS closed Lots/Acres/Farms, 10-300 acres, last 2 years. Harnett from Acres.com. County medians are a starting point, not an appraisal.</td></tr>`;
}

async function acSetStatus(id, v) {
  const { error } = await sb.from('acreage_tracts').update({ my_status: v, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return toast(error.message);
  const r = AC.rows.find(x => x.id === id); if (r) r.my_status = v;
  toast('Status saved');
}

function acOpen(id) {
  const r = AC.rows.find(x => x.id === id); if (!r) return;
  const line = (l, v) => `<tr><td class="small muted" style="width:170px;vertical-align:top">${l}</td><td>${v === null || v === undefined || v === '' ? '<span class="muted">—</span>' : v}</td></tr>`;
  const map = r.lat && r.lng ? `<a href="https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}" target="_blank" rel="noopener">Google Maps</a> · <a href="https://msc.fema.gov/portal/search?AddressQuery=${r.lat},${r.lng}" target="_blank" rel="noopener">FEMA flood</a> · <a href="https://websoilsurvey.nrcs.usda.gov/app/WebSoilSurvey.aspx" target="_blank" rel="noopener">Soil survey</a>` : '';
  const comp = AC.comps.filter(c => c.county === r.county).map(c => `${esc(c.grp)}: ${money(c.median_per_acre)}/ac`).join(' · ');
  window._wideNext = true;
  openDrawer(`<div class="dhead"><div><div class="small muted">Acreage Play · ${esc(r.county || '')} County</div><h2 style="margin:2px 0 0">${esc(r.address || r.parcel || 'Tract')}</h2><div class="small muted">${r.acres ?? ''} acres · parcel ${esc(r.parcel || '')}</div></div><button class="btn ghost" onclick="closeDrawer()">Close</button></div>
    <div class="card">${acTierPill(r.sewer_tier)} <span class="small">${esc(r.utilities || '')}</span>
      <div class="small muted" style="margin-top:6px">Map-based. Call the utility to confirm capacity before any offer.</div></div>
    <div class="card"><table>
      ${line('Owner', esc(r.owner_name || '') + (r.owner_name2 ? '<div class="small muted">' + esc(r.owner_name2) + '</div>' : ''))}
      ${line('Mailing address', esc([r.mail_address, r.mail_city, r.mail_state, r.mail_zip].filter(Boolean).join(', ')))}
      ${line('Owned since', esc(r.owned_since || ''))}
      ${line('Land / total value', (r.land_value != null ? money(r.land_value) : '—') + ' / ' + (r.total_value != null ? money(r.total_value) : '—') + ' <span class="small muted">(county tax value, not market)</span>')}
      ${line('Road frontage', esc(r.road_frontage || ''))}
      ${line('Flood (FEMA)', r.flood_pct != null ? `${r.flood_pct}% of the tract in the 100-year flood zone${r.floodway ? ' · includes floodway (can\'t build)' : ''}${r.flood_zones ? ' <span class="small muted">zones ' + esc(r.flood_zones) + '</span>' : ''}` : null)}
      ${line('Land use', esc(r.land_use || ''))}
      ${line('Builder buys nearby', `${r.builder_buys_2mi ?? 0} within 2 miles · nearest: ${esc(r.nearest_buyer || '')}${r.nearest_buyer_mi != null ? ' (' + r.nearest_buyer_mi + ' mi)' : ''}`)}
      ${line('County comps', comp || null)}
      ${line('Maps', map || null)}
    </table></div>
    <div class="card"><h3 class="sec" style="margin-top:0">My notes</h3>
      <select id="ac_st" style="width:auto;margin-bottom:8px">${AC_STATUSES.map(([k, l]) => `<option value="${k}" ${(r.my_status || 'new') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <textarea id="ac_notes" rows="6" placeholder="Calls, utility answers, offers">${esc(r.my_notes || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" onclick="acSaveNotes(${r.id})">Save</button></div></div>`);
}

async function acSaveNotes(id) {
  const my_notes = $('ac_notes').value, my_status = $('ac_st').value;
  const { error } = await sb.from('acreage_tracts').update({ my_notes, my_status, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return toast(error.message);
  const r = AC.rows.find(x => x.id === id); if (r) { r.my_notes = my_notes; r.my_status = my_status; }
  toast('Saved'); closeDrawer(); vAcreageDraw();
}

function acLoadXlsx() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the spreadsheet reader')); document.head.appendChild(s); });
}

async function acImport(file) {
  if (!file) return;
  try {
    toast('Reading ' + file.name + '…');
    await acLoadXlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet = n => wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: null }) : [];
    const num = v => v === null || v === '' || v === undefined ? null : (isNaN(Number(String(v).replace(/[$,]/g, ''))) ? null : Number(String(v).replace(/[$,]/g, '')));
    const str = v => v === null || v === undefined ? null : String(v).trim() || null;
    const listName = file.name.replace(/\.xlsx$/i, '');
    const tracts = sheet('Acreage Mail List').filter(r => r['Parcel ID']).map(r => ({
      dedupe_key: `${r['County']}|${r['Parcel ID']}`, list_name: listName,
      sewer_tier: str(r['Sewer Tier']), utilities: str(r['Utilities']),
      first_name: str(r['First Name']), last_name: str(r['Last Name']), owner_name: str(r['Owner (County Record)']), owner_name2: str(r['Owner 2']),
      mail_address: str(r['Mailing Address']), mail_city: str(r['Mailing City']), mail_state: str(r['Mailing State']), mail_zip: str(r['Mailing Zip']),
      address: str(r['Property Address']), city: str(r['Property City']), state: str(r['Property State']) || 'NC', county: str(r['County']), parcel: str(r['Parcel ID']),
      acres: num(r['Acres']), land_value: num(r['Land Value']), total_value: num(r['Total Value']), owned_since: str(r['Owned Since']),
      builder_buys_2mi: num(r['Builder/Developer Buys Within 2 Mi']), nearest_buyer: str(r['Nearest Builder/Developer Buyer']), nearest_buyer_mi: num(r['Miles to Nearest Buy']),
      road_frontage: str(r['Road Frontage']), score: num(r['Score']), land_use: str(r['Land Use']), lat: num(r['Latitude']), lng: num(r['Longitude']),
      updated_at: new Date().toISOString(),
    }));
    const buyers = sheet('Builder Buyers').filter(r => r['Buyer (as recorded)']).map(r => {
      const d = r['Last Purchase']; return {
        name: String(r['Buyer (as recorded)']).trim(), tracts: num(r['10+ Acre Tracts Bought (Jul 2024+)']), acres: num(r['Total Acres']),
        counties: str(r['Counties']), last_purchase: d ? String(d).slice(0, 10) : null, mail_address: str(r['Mailing Address']), updated_at: new Date().toISOString(),
      };
    });
    const comps = sheet('Canopy Acreage Comps').filter(r => r['County'] && r['Group'] && num(r['Median $/Acre']) != null)
      .map(r => ({ county: String(r['County']).trim(), grp: String(r['Group']).trim(), sales: num(r['Sales']), median_per_acre: num(r['Median $/Acre']) }));
    if (!tracts.length) return toast('No "Acreage Mail List" tab with parcels found in that file.');
    for (let i = 0; i < tracts.length; i += 500) {
      const { error } = await sb.from('acreage_tracts').upsert(tracts.slice(i, i + 500), { onConflict: 'dedupe_key' });
      if (error) return toast('Tract import failed: ' + error.message);
    }
    if (buyers.length) { const { error } = await sb.from('acreage_buyers').upsert(buyers, { onConflict: 'name' }); if (error) return toast('Buyer import failed: ' + error.message); }
    if (comps.length) { const { error } = await sb.from('acreage_comps').upsert(comps, { onConflict: 'county,grp' }); if (error) return toast('Comps import failed: ' + error.message); }
    toast(`Imported ${tracts.length} tracts, ${buyers.length} buyers, ${comps.length} comp rows. Your statuses and notes were kept.`);
    vAcreage();
  } catch (e) { toast('Import failed: ' + e.message); }
}
