// DLG HQ - Foreclosures tab.
// Cases come from the foreclosure-scout edge function (nightly in the cloud, or "Run scout now").
// Every dollar figure here except the firm's bids and the county value is an ESTIMATE and is labeled that way.
const FC = { verdict: 'Pursue', area: 'mine', source: '', q: '', showGone: false, rows: [], counties: [], minFee: 25000 };
const FC_STATUSES = [['new', 'New'], ['researching', 'Researching'], ['contacting', 'Contacting owner'], ['offer', 'Offer made'], ['dead', 'Dead']];
const FC_SOURCES = { ruff: 'Ruff Bond (tax)', kania: 'Kania (tax)', brock: 'Brock & Scott (mortgage)', canopy: 'Canopy (other lenders)' };

function fcToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); }
function fcDays(d) { if (!d) return null; return Math.round((new Date(String(d).slice(0, 10) + 'T12:00:00') - new Date(fcToday() + 'T12:00:00')) / 864e5); }
function fcSaleCell(c) {
  if (c.upset_last_day && c.current_bid != null) {
    const n = fcDays(c.upset_last_day);
    return `<b>Auction held</b><div class="small muted">upset ends ${fmtDate(c.upset_last_day)}${n != null && n >= 0 ? ` (${n} day${n === 1 ? '' : 's'})` : ''}</div>`;
  }
  if (!c.sale_date) return `<span class="muted">Not set yet</span>`;
  const n = fcDays(c.sale_date);
  const when = n < 0 ? `${-n} day${n === -1 ? '' : 's'} ago` : n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`;
  return `${fmtDate(c.sale_date)}<div class="small" style="color:${n >= 0 && n <= 14 ? 'var(--red)' : 'var(--muted)'}">${when}</div>`;
}
function fcPill(v) {
  const s = v === 'Pursue' ? 'background:#e3f4ea;color:#1a7a45' : v === 'Skip' ? 'background:#f1f1f1;color:#777' : 'background:#fff4d6;color:#7a5a00';
  return `<span class="pill" style="${s}">${esc(v || 'Review')}</span>`;
}

async function vForeclosures() {
  $('view').innerHTML = '<div class="muted">Loading…</div>';
  const [cases, runs, settings] = await Promise.all([
    sb.from('foreclosure_cases').select('*').order('sale_date', { ascending: true, nullsFirst: false }).range(0, 4999),
    sb.from('foreclosure_scout_runs').select('source,ok,finished_at,rows_found,added,error').order('id', { ascending: false }).limit(60),
    sb.from('foreclosure_settings').select('key,value'),
  ]);
  if (cases.error) { $('view').innerHTML = `<div class="card">Couldn't load foreclosure cases: ${esc(cases.error.message)}</div>`; return; }
  FC.rows = cases.data || [];
  const set = Object.fromEntries((settings.data || []).map(r => [r.key, r.value]));
  FC.counties = Array.isArray(set.counties) ? set.counties : ['Mecklenburg', 'Gaston', 'Union', 'Cabarrus', 'Iredell', 'Lincoln', 'Rowan', 'Cleveland', 'York'];
  FC.minFee = Number(set.min_fee ?? 25000) || 25000;
  // last run per source
  const last = {}, lastOk = {};
  for (const r of runs.data || []) { if (!last[r.source]) last[r.source] = r; if (r.ok && !lastOk[r.source]) lastOk[r.source] = r; }
  const srcLine = [['ruff', 'Ruff Bond'], ['kania', 'Kania'], ['brock_nc', 'Brock & Scott NC'], ['brock_sc', 'Brock & Scott SC'], ['county', 'County data']].map(([k, l]) => {
    const ok = lastOk[k], l1 = last[k];
    const age = ok ? Math.floor((Date.now() - new Date(ok.finished_at)) / 864e5) : null;
    const stale = !ok || age >= 2;
    const failed = l1 && !l1.ok;
    return `<span style="margin-right:14px;color:${stale || failed ? 'var(--red)' : 'inherit'}" title="${esc(failed ? 'Last try failed: ' + (l1.error || '') : '')}">${l} — ${ok ? 'pulled ' + new Date(ok.finished_at).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + (ok.rows_found != null ? ` (${ok.rows_found})` : '') : 'never pulled'}${failed ? ' · last try failed' : ''}</span>`;
  }).join('');
  $('actions').innerHTML = `<button class="btn ghost" onclick="fcMinFee()">Min fee: ${money(FC.minFee)}</button> <button class="btn" id="fcRun" onclick="fcRunScout()">Run scout now</button>`;
  $('view').innerHTML = `<div class="card" style="padding:12px 14px">
      <div class="small muted" style="margin-bottom:8px">${srcLine}</div>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
        <div class="seg" id="fcSeg" style="margin:0;flex:0 0 auto">${['Pursue', 'Review', 'Skip', 'All'].map(v => `<button class="${FC.verdict === v ? 'on' : ''}" onclick="FC.verdict='${v}';fcDraw()">${v} <span id="fcN_${v}" class="small"></span></button>`).join('')}</div>
        <select id="fcArea" style="width:auto" onchange="FC.area=this.value;fcDraw()"><option value="mine" ${FC.area === 'mine' ? 'selected' : ''}>My area</option><option value="all" ${FC.area === 'all' ? 'selected' : ''}>All NC & SC</option></select>
        <select id="fcSrc" style="width:auto" onchange="FC.source=this.value;fcDraw()"><option value="">All firms</option>${Object.entries(FC_SOURCES).map(([k, l]) => `<option value="${k}" ${FC.source === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input id="fcQ" placeholder="Search address, owner, county, case #" style="width:240px" value="${esc(FC.q)}" oninput="FC.q=this.value;fcDraw()">
        <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" style="width:auto" ${FC.showGone ? 'checked' : ''} onchange="FC.showGone=this.checked;fcDraw()"> Show cases no longer listed</label>
      </div>
      <div class="small muted" style="margin-top:8px">Est. room = 70% of county value minus est. debt — what's left for the seller's payout and your fee. County value isn't market value, and debts are estimates until checked. Verify with comps and a loan check before any offer.</div>
    </div>
    <div class="card" style="padding:0;overflow-x:auto"><table class="ctable" id="fcTable"></table></div>`;
  fcDraw();
}

function fcFiltered(ignoreVerdict) {
  const q = FC.q.trim().toLowerCase();
  const mine = new Set(FC.counties.map(c => String(c).toLowerCase()));
  return FC.rows.filter(c => {
    if (!FC.showGone && c.gone_since) return false;
    if (FC.area === 'mine' && !mine.has(String(c.county || '').toLowerCase())) return false;
    if (FC.source && c.source !== FC.source) return false;
    if (!ignoreVerdict && FC.verdict !== 'All' && (c.verdict || 'Review') !== FC.verdict) return false;
    if (q && ![c.address, c.owner_name, c.county_owner, c.county, c.case_no, c.parcel].some(x => String(x || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

function fcDraw() {
  document.querySelectorAll('#fcSeg button').forEach(b => b.classList.toggle('on', b.textContent.trim().startsWith(FC.verdict)));
  const base = fcFiltered(true);
  for (const v of ['Pursue', 'Review', 'Skip', 'All']) { const el = document.getElementById('fcN_' + v); if (el) el.textContent = '(' + (v === 'All' ? base.length : base.filter(c => (c.verdict || 'Review') === v).length) + ')'; }
  const rows = fcFiltered(false);
  const t = document.getElementById('fcTable'); if (!t) return;
  const head = `<tr><th>Sale</th><th>Property</th><th>Owner</th><th class="right">County value</th><th class="right">Est. debt</th><th class="right">Est. room</th><th>Verdict</th><th>My status</th><th></th></tr>`;
  if (!rows.length) { t.innerHTML = head + `<tr><td colspan="9" class="muted">${FC.rows.length ? 'No cases match these filters.' : 'No cases yet. Click "Run scout now", or wait for tonight\'s run.'}</td></tr>`; return; }
  t.innerHTML = head + rows.map(c => {
    const owner = c.owner_name || c.county_owner || '';
    return `<tr style="${c.gone_since ? 'opacity:.55' : ''}">
      <td style="white-space:nowrap">${fcSaleCell(c)}</td>
      <td><b>${esc(c.address || '(no address)')}</b>${c.is_heirs ? ' <span class="pill" style="background:#efe6f6;color:var(--brand)">Heirs</span>' : ''}<div class="small muted">${esc(c.county || '')}${c.state ? ', ' + esc(c.state) : ''} · ${esc(FC_SOURCES[c.source] || c.source)}${c.gone_since ? ' · no longer listed' : ''}</div></td>
      <td class="small">${esc(owner) || '<span class="muted">—</span>'}</td>
      <td class="right num">${c.county_value != null ? money(c.county_value) : `<span class="small muted">${esc(c.county === 'Mecklenburg' ? 'not found' : 'not connected')}</span>`}</td>
      <td class="right num" title="${esc(c.est_debt_method || '')}">${c.est_debt != null ? money(c.est_debt) : '—'}${c.est_debt != null ? '<div class="small muted">estimate</div>' : ''}</td>
      <td class="right num" style="color:${c.est_spread != null && c.est_spread >= FC.minFee ? '#1a9e5a' : 'inherit'}">${c.est_spread != null ? money(c.est_spread) : '—'}</td>
      <td style="min-width:200px">${fcPill(c.verdict)}<div class="small muted" style="margin-top:3px">${esc(c.verdict_reason || '')}</div></td>
      <td><select style="width:auto" onchange="fcSetStatus(${c.id},this.value)">${FC_STATUSES.map(([k, l]) => `<option value="${k}" ${(c.my_status || 'new') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>${c.my_notes ? '<div class="small muted" style="margin-top:3px">📝 has notes</div>' : ''}</td>
      <td><button class="btn ghost sm" onclick="fcOpen(${c.id})">Details</button></td></tr>`;
  }).join('');
}

async function fcSetStatus(id, v) {
  const { error } = await sb.from('foreclosure_cases').update({ my_status: v }).eq('id', id);
  if (error) return toast(error.message);
  const c = FC.rows.find(x => x.id === id); if (c) c.my_status = v;
  toast('Status saved');
}

function fcOpen(id) {
  const c = FC.rows.find(x => x.id === id); if (!c) return;
  const line = (l, v) => `<tr><td class="small muted" style="width:170px;vertical-align:top">${l}</td><td>${v === null || v === undefined || v === '' ? '<span class="muted">—</span>' : v}</td></tr>`;
  const meckLink = c.parcel && c.county === 'Mecklenburg' ? ` <a href="https://polaris3g.mecklenburgcountync.gov/pid/${encodeURIComponent(c.parcel)}" target="_blank" rel="noopener">Polaris</a>` : '';
  const srcUrl = { ruff: 'https://www.rbcwb.com/tax-foreclosure-listings/', kania: 'https://kanialawfirm.com/tax-foreclosures/foreclosure-listings/', brock: 'https://www.brockandscott.com/foreclosure-sales/', canopy: 'https://matrix.canopymls.com/Matrix/PublicRecords/MatrixTaxSearch' }[c.source];
  window._wideNext = true;
  openDrawer(`<div class="dhead"><div><div class="small muted">Foreclosure · ${esc(FC_SOURCES[c.source] || c.source)}</div><h2 style="margin:2px 0 0">${esc(c.address || '(no address)')}</h2><div class="small muted">${esc(c.county || '')}${c.state ? ', ' + esc(c.state) : ''}${c.zip ? ' ' + esc(c.zip) : ''}</div></div><button class="btn ghost" onclick="closeDrawer()">Close</button></div>
    <div class="card">${fcPill(c.verdict)} <span class="small">${esc(c.verdict_reason || '')}</span>
      <table style="margin-top:10px">
        ${line('County value', c.county_value != null ? money(c.county_value) + (c.county_land_value != null ? ` <span class="small muted">(land ${money(c.county_land_value)})</span>` : '') : esc(c.county_data_status || ''))}
        ${line('Est. debt (estimate)', c.est_debt != null ? money(c.est_debt) + `<div class="small muted">${esc(c.est_debt_method || '')}</div>` : null)}
        ${line('Est. room (estimate)', c.est_spread != null ? money(c.est_spread) + `<div class="small muted">${esc(c.est_spread_note || '')}</div>` : null)}
      </table></div>
    <div class="card"><h3 class="sec" style="margin-top:0">From the firm's list</h3><table>
      ${line('Owner on the list', esc(c.owner_name || '') + (c.is_heirs ? ' <span class="pill" style="background:#efe6f6;color:var(--brand)">Heirs / estate</span>' : ''))}
      ${line('Case #', esc(c.case_no || ''))}
      ${line('Parcel', esc(c.parcel || '') + meckLink)}
      ${line('Property type', esc(c.property_type || ''))}
      ${line('Sale date', c.sale_date ? fmtDate(c.sale_date) + (c.sale_time ? ' ' + esc(c.sale_time) : '') : null)}
      ${line('Opening bid', c.opening_bid != null && Number(c.opening_bid) > 0 ? money(c.opening_bid) : null)}
      ${line('Current bid', c.current_bid != null ? money(c.current_bid) : null)}
      ${line('Last day for upset bid', c.upset_last_day ? fmtDate(c.upset_last_day) : null)}
      ${line('Status on the list', esc(c.source_status || ''))}
      ${line('Deed of trust book/page', esc(c.book_page || ''))}
      ${line('Source', srcUrl ? `<a href="${srcUrl}" target="_blank" rel="noopener">Open the firm's list</a>` : null)}
      ${line('First seen / last seen', fmtDate(c.first_seen_at) + ' / ' + fmtDate(c.last_seen_at) + (c.gone_since ? ` · <span style="color:var(--red)">no longer listed since ${fmtDate(c.gone_since)}</span>` : ''))}
    </table></div>
    <div class="card"><h3 class="sec" style="margin-top:0">County record</h3><table>
      ${line('Data', esc(c.county_data_status || ''))}
      ${line('Owner on record', esc(c.county_owner || ''))}
      ${line('Mailing address', esc(c.county_mail_address || ''))}
      ${line('Use', esc(c.county_use || ''))}
      ${line('Acres', c.county_acres != null ? esc(String(c.county_acres)) : null)}
      ${line('Last sale', c.county_last_sale_date ? fmtDate(c.county_last_sale_date) + (Number(c.county_last_sale_price) > 0 ? ' for ' + money(c.county_last_sale_price) : ' (no price recorded)') : null)}
      ${line('Deed book', esc(c.county_deed_book || ''))}
    </table></div>
    <div class="card"><h3 class="sec" style="margin-top:0">My notes</h3>
      <select id="fc_st" style="width:auto;margin-bottom:8px">${FC_STATUSES.map(([k, l]) => `<option value="${k}" ${(c.my_status || 'new') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <textarea id="fc_notes" rows="6" placeholder="Calls, heirs, anything you learn">${esc(c.my_notes || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" onclick="fcSaveNotes(${c.id})">Save</button></div></div>`);
}

async function fcSaveNotes(id) {
  const my_notes = $('fc_notes').value, my_status = $('fc_st').value;
  const { error } = await sb.from('foreclosure_cases').update({ my_notes, my_status }).eq('id', id);
  if (error) return toast(error.message);
  const c = FC.rows.find(x => x.id === id); if (c) { c.my_notes = my_notes; c.my_status = my_status; }
  toast('Saved'); closeDrawer(); fcDraw();
}

async function fcMinFee() {
  const v = prompt('Minimum fee per deal (cases with less estimated room are marked Skip):', String(FC.minFee));
  if (v === null) return;
  const n = Math.round(Number(String(v).replace(/[^0-9.]/g, '')));
  if (!n || n < 1000) return toast('Enter a dollar amount, like 25000');
  const { error } = await sb.from('foreclosure_settings').upsert({ key: 'min_fee', value: n });
  if (error) return toast(error.message);
  FC.minFee = n; toast('Saved. Re-checking every case with the new minimum…');
  fcRunScout(true);
}

async function fcRunScout(quiet) {
  const b = document.getElementById('fcRun'); if (b) { b.disabled = true; b.textContent = 'Running… (about a minute)'; }
  if (!quiet) toast('Scout running: Ruff Bond, Kania and county data. Brock & Scott runs overnight.');
  try {
    const { data, error } = await sb.functions.invoke('foreclosure-scout', { body: {} });
    if (error) { let m = error.message; try { m = (await error.context.json()).error || m } catch (e) { } toast('Scout failed: ' + m); }
    else if (data && data.ok === false) toast('Scout finished with a problem: ' + Object.entries(data.results || {}).filter(([, r]) => r && r.ok === false).map(([k, r]) => k + ': ' + r.error).join('; '));
    else toast('Scout done.');
  } catch (e) { toast('Scout failed: ' + e.message); }
  if (CUR === 'foreclosures') vForeclosures();
}
