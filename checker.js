// DLG HQ - List Checker (Nov 2026). Drop a PropStream CSV and every lot is checked in the browser against free public
// maps (county parcels, FEMA flood, USGS elevation, NCDOT/Census roads, building footprints, water bodies) with tools/rc.js.
// Passing lots go into a POOL campaign or a new campaign (import_campaign_list in chunks of 500, then finish_campaign_import).
// Progress (checks and an import in flight) is saved in IndexedDB, so a reload picks up where it stopped.
// PropStream's "Do Not Mail" column is ignored on purpose (Damien, Nov 2026); DLG HQ's own do-not-mail / not-interested
// contacts are still left off by the import (skip_dnm / skip_ni).
(function () {
  const RULES = 'Road frontage (50 ft+ on a public road; NC: state-maintained, or a town street inside city limits; SC: any public road; Brunswick: Rivers Edge, Ocean Ridge Plantation, SeaScape and SeaWatch private roads are OK) · no flag/long strips · any part in a flood zone · 15%+ slope · house or building on the lot (possible encroachment) · under 0.1 acre · under 40 ft wide · triangles / odd shapes · waterfront';
  let CK = null; // {key,name,cols,rows,map,res,run,imp}
  // ---- IndexedDB (localStorage ran out of room) ----
  let _db; const db = () => _db || (_db = new Promise((ok, no) => { const r = indexedDB.open('dlghq-checker', 1); r.onupgradeneeded = () => r.result.createObjectStore('runs'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }));
  const tx = (m, f) => db().then(d => new Promise((ok, no) => { const t = d.transaction('runs', m), q = f(t.objectStore('runs')); t.oncomplete = () => ok(q && q.result); t.onerror = () => no(t.error); }));
  const idbGet = k => tx('readonly', s => s.get(k)).catch(() => null), idbSet = (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => null);
  // the file's rows are saved once (key + ':rows'); results, column picks and the import state on every save
  const save = () => CK && idbSet(CK.key, { name: CK.name, cols: CK.cols, n: CK.rows.length, map: CK.map, res: CK.res, imp: CK.imp || null, at: Date.now() }).then(() => idbSet('last', CK.key));
  const loadRun = async k => { const p = k && await idbGet(k), rows = p && await idbGet(k + ':rows'); return p && rows ? { ...p, rows } : null; };
  const loadRC = () => window.RC ? Promise.resolve() : new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'tools/rc.js?v=5'; s.onload = ok; s.onerror = () => no(new Error('The checker script (tools/rc.js) did not load. Reload and try again.')); document.head.appendChild(s); });
  // ---- columns: PropStream export, or a generic CSV ----
  const K = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const F = { first: ['Owner 1 First Name', 'owner1firstname', 'firstname'], last: ['Owner 1 Last Name', 'owner1lastname', 'lastname'], full: ['Owner Name', 'ownername', 'owner1fullname', 'owner1name', 'fullname', 'owner'],
    care: ['Mailing Care of Name', 'mailingcareofname', 'careofname'], mail: ['Mailing Address', 'mailingaddress', 'mailaddress', 'mailingstreetaddress'], unit: ['Mailing Unit #', 'mailingunit', 'mailingunitnumber'],
    mcity: ['Mailing City', 'mailingcity', 'mailcity'], mstate: ['Mailing State', 'mailingstate', 'mailstate'], mzip: ['Mailing Zip', 'mailingzip', 'mailzip', 'mailingzipcode'],
    apn: ['APN', 'apn', 'parcelnumber', 'parcelid', 'parcel', 'pin'], addr: ['Address', 'address', 'propertyaddress', 'situsaddress', 'siteaddress'], city: ['City', 'city', 'propertycity', 'situscity'],
    state: ['State', 'state', 'propertystate', 'situsstate'], zip: ['Zip', 'zip', 'propertyzip', 'situszip', 'zipcode'], county: ['County', 'county', 'propertycounty', 'countyname'],
    sqft: ['Lot Size Sqft', 'lotsizesqft', 'lotsqft', 'lotsquarefeet'], acres: ['Lot Size Acres', 'lotsizeacres', 'acres', 'lotacres', 'acreage'] };
  const LBL = { first: 'Owner first name', last: 'Owner last name', full: 'Owner name (if no first/last)', care: 'Mailing care of name', mail: 'Mailing address *', unit: 'Mailing unit #', mcity: 'Mailing city', mstate: 'Mailing state', mzip: 'Mailing zip',
    apn: 'APN *', addr: 'Property address', city: 'Property city', state: 'Property state', zip: 'Property zip', county: 'County *', sqft: 'Lot size sqft', acres: 'Lot size acres' };
  const usable = cols => cols.filter(c => !/do\s*not\s*mail/i.test(c)); // PropStream's Do Not Mail column: ignored completely
  const autoMap = cols => { const u = usable(cols), m = {}; for (const [f, ks] of Object.entries(F)) { const c = u.find(x => ks.some(k => K(k) === K(x))); if (c) m[f] = c; } return m; };
  const val = (o, k) => CK.map[k] ? String(o[CK.map[k]] ?? '').trim() : '';
  const county = o => val(o, 'county').replace(/\s+county$/i, '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  const apnOf = o => { const raw = CK.map.apn ? String(o[CK.map.apn] ?? '') : ''; return /^duplin$/i.test(county(o)) ? raw : raw.trim(); }; // Duplin APN kept exactly, spaces and all (rc.js matches it to the county ParcelNumber)
  const rowOf = (o, i) => { const res = CK.res[i] || {}, first = val(o, 'first'), last = val(o, 'last'); let mail = val(o, 'mail'); const unit = val(o, 'unit');
    if (unit && !mail.toLowerCase().includes(unit.toLowerCase())) mail = (mail + ' ' + (/^[#a-z]/i.test(unit) ? unit : '#' + unit)).trim();
    const sq = +val(o, 'sqft').replace(/[,$]/g, ''), ac = +val(o, 'acres').replace(/[,$]/g, '');
    const x = { full_name: [first, last].filter(Boolean).join(' ') || val(o, 'full') || val(o, 'care'), first_name: first, last_name: last, mail_address: mail, mail_city: val(o, 'mcity'), mail_state: val(o, 'mstate').toUpperCase(), mail_zip: val(o, 'mzip'),
      apn: apnOf(o), address: val(o, 'addr'), city: val(o, 'city'), state: val(o, 'state').toUpperCase(), zip: val(o, 'zip'), county: county(o), acres: ac > 0 ? ac : sq > 0 ? +(sq / 43560).toFixed(3) : res.acres };
    for (const k in x) if (x[k] === '' || x[k] == null || (typeof x[k] === 'number' && !isFinite(x[k]))) delete x[k]; return x; };
  // results: removed for a property reason vs. couldn't check (error, parcel not on the county map, no parcel map)
  const cant = o => o && !o.pass && (o.error || /parcel not found|no parcel map/.test(o.fail || ''));
  const why = o => !o ? '' : o.pass ? (o.privateRoad ? 'pass (private road: ' + o.privateRoad + ')' : 'pass') : o.error ? 'could not check: ' + o.error : String(o.fail || '').replace(/^hold: |^aerial: /, '');
  const sets = () => { const R = CK.rows.map((r, i) => [r, CK.res[i], i]); return { R, pass: R.filter(([, o]) => o && o.pass), rem: R.filter(([, o]) => o && !o.pass && !cant(o)), cc: R.filter(([, o]) => cant(o)) }; };
  const lettersOf = list => letterCount(list.map(([r, , i]) => { const x = rowOf(r, i); return { lead_id: 'r' + i, leads: { full_name: x.full_name, mail_address: x.mail_address, mail_zip: x.mail_zip } }; }));
  const n = v => Number(v || 0).toLocaleString();

  window.vChecker = async function () {
    $('view').innerHTML = `<div class="card"><h3 style="margin-top:0">List Checker</h3>
      <div class="small muted" style="margin-bottom:10px">Drop a PropStream CSV (or any CSV with owner, mailing address, APN and county). Every lot is checked against the county parcel map and public maps in this browser, no Claude needed. Leave the tab open while it runs (about 2 lots a second); if it closes, come back here and it picks up where it stopped. PropStream's "Do Not Mail" column is ignored; DLG HQ's own do-not-mail and not-interested contacts are still left off when you add the lots.</div>
      <div class="small" style="margin-bottom:10px"><b>Checks:</b> ${RULES}</div>
      <input type="file" id="ckFile" accept=".csv" onchange="ckLoad()"><div id="ckResume" style="margin-top:10px"></div>
      <div id="ckMap" style="margin-top:12px"></div><div id="ckOut" style="margin-top:12px"></div></div>`;
    if (CK) { ckDrawMap(); return ckShow(); }
    const p = await loadRun(await idbGet('last'));
    if (p && $('ckResume')) $('ckResume').innerHTML = `<div class="card small" style="border-left:4px solid #5c2977;margin:0">Last list: <b>${esc(p.name)}</b> · ${n(Object.keys(p.res || {}).length)} of ${n(p.rows.length)} checked${p.imp && p.imp.stage !== 'done' ? ' · <b style="color:#b26a00">an import into DLG HQ did not finish</b>' : ''}. <button class="btn sm" onclick="ckResume()">Pick up where I left off</button></div>`;
  };
  window.ckResume = async function () { const k = await idbGet('last'), p = await loadRun(k); if (!p) return toast('Nothing saved'); CK = { key: k, ...p, run: false }; $('ckResume').innerHTML = ''; ckDrawMap(); ckShow(); };
  window.ckLoad = function () {
    const f = $('ckFile').files[0]; if (!f) return;
    Papa.parse(f, { header: true, skipEmptyLines: true, complete: async res => {
      const cols = res.meta.fields || [], key = 'ck:' + f.name + ':' + f.size; const prev = await idbGet(key);
      // a finished import is not carried over: dropping the file again lets you add it somewhere else (pools skip lots already in a pool)
      CK = { key, name: f.name, cols, rows: res.data, map: prev && prev.map || autoMap(cols), res: prev && prev.res || {}, imp: prev && prev.imp && prev.imp.stage !== 'done' ? prev.imp : null, run: false };
      $('ckResume').innerHTML = ''; ckDrawMap(); ckShow(); await idbSet(key + ':rows', res.data); save();
    } });
  };
  window.ckDrawMap = function () { const u = usable(CK.cols), done = Object.keys(CK.res).length;
    const sel = k => `<select onchange="ckSetCol('${k}',this.value)"><option value="">(none)</option>${u.map(c => `<option ${c === CK.map[k] ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
    $('ckMap').innerHTML = `<b>${n(CK.rows.length)} lots in ${esc(CK.name)}</b>${done ? ` <span class="small muted">(${n(done)} already checked; those are kept)</span>` : ''}
      <details style="margin-top:6px"><summary class="small">Columns (matched automatically, fix any that are wrong)</summary><table class="small" style="margin-top:6px">${Object.keys(F).map(k => `<tr><td>${LBL[k]}</td><td>${sel(k)}</td><td class="muted">${esc(CK.map[k] ? String((CK.rows[0] || {})[CK.map[k]] ?? '').slice(0, 40) : '')}</td></tr>`).join('')}</table></details>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn" onclick="ckRun()">${done && done < CK.rows.length ? 'Keep checking' : 'Check all lots'}</button> <button class="btn ghost" onclick="ckStop()">Pause</button></div>`; };
  window.ckSetCol = (k, v) => { CK.map[k] = v || undefined; save(); };
  window.ckState = () => CK;
  window.ckStop = () => { if (CK) CK.run = false; };
  window.ckRun = async function () {
    if (!CK || CK.run) return;
    if (!CK.map.apn || !CK.map.county) return alert('Pick the APN and County columns first.');
    try { await loadRC(); } catch (e) { return alert(e.message); }
    CK.run = true; const todo = CK.rows.map((r, i) => [r, i]).filter(([, i]) => !CK.res[i] || CK.res[i].error); let j = 0, c = 0; ckShow();
    const one = async ([r, i]) => { const row = { properties: { apn: apnOf(r), county: county(r), state: val(r, 'state').toUpperCase() } };
      let o; for (let t = 0; t < 3; t++) { try { o = await RC.check(row); break; } catch (e) { o = { error: String(e.message || e).slice(0, 80) }; await new Promise(z => setTimeout(z, 1500 * (t + 1))); } }
      CK.res[i] = o; if (++c % 25 === 0) { save(); if (CUR === 'checker') ckShow(); } };
    const w = async () => { while (CK.run && j < todo.length) await one(todo[j++]); };
    await Promise.all(Array.from({ length: 8 }, w)); CK.run = false; await save(); if (CUR === 'checker') { ckDrawMap(); ckShow(); }
  };

  window.ckShow = async function () {
    if (!CK || !$('ckOut')) return; const done = Object.keys(CK.res).length, { pass, rem, cc } = sets();
    const reasons = {}; rem.forEach(([, o]) => { const k = why(o); reasons[k] = (reasons[k] || 0) + 1; });
    const ccR = {}; cc.forEach(([, o]) => { const k = o.error ? 'could not reach a map (try again)' : why(o); ccR[k] = (ccR[k] || 0) + 1; });
    const fin = !CK.run && done === CK.rows.length, tbl = o => `<table class="small" style="margin-top:6px">${Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="right num">${n(v)}</td></tr>`).join('')}</table>`;
    $('ckOut').innerHTML = `<div style="height:8px;background:var(--line,#eee);border-radius:4px;overflow:hidden"><div style="height:100%;width:${CK.rows.length ? Math.round(100 * done / CK.rows.length) : 0}%;background:#5c2977"></div></div>
      <div class="small" style="margin-top:6px">${n(done)} of ${n(CK.rows.length)} checked${CK.run ? ' · running…' : ''}</div>
      <div class="pstats" style="grid-template-columns:repeat(3,1fr);margin-top:10px">
        <div><div class="small muted">Passed</div><b style="font-size:22px;color:#1d7a3a">${n(pass.length)}</b><div class="small muted">${n(lettersOf(pass))} letters (one per owner)</div></div>
        <div><div class="small muted">Removed</div><b style="font-size:22px;color:var(--red)">${n(rem.length)}</b></div>
        <div><div class="small muted">Couldn't check</div><b style="font-size:22px;color:#b26a00">${n(cc.length)}</b><div class="small muted">${n(CK.rows.length - done)} not checked yet</div></div></div>
      ${rem.length ? `<details style="margin-top:10px" open><summary><b>Why lots were removed</b></summary>${tbl(reasons)}</details>` : ''}
      ${cc.length ? `<details style="margin-top:6px"><summary><b>Couldn't check</b> <span class="small muted">(not added; "Keep checking" retries the ones a map didn't answer)</span></summary>${tbl(ccR)}</details>` : ''}
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost" ${rem.length ? '' : 'disabled'} onclick="ckDownload('rem')">Download removed lots (with reasons)</button><button class="btn ghost" ${cc.length ? '' : 'disabled'} onclick="ckDownload('cc')">Download couldn't-check lots</button></div>
      <div id="ckImp" style="margin-top:14px"></div>`;
    if (fin || CK.imp) ckDrawImport(pass);
  };
  const csvOf = list => Papa.unparse(list.map(([r, o]) => { const x = { ...r }; for (const c of Object.keys(x)) if (/do\s*not\s*mail/i.test(c)) delete x[c]; return { ...x, 'Check result': why(o), 'Acres (county map)': o.acres ?? '', 'Road frontage ft': o.frontFt ?? '', 'Flood %': o.floodPct ?? '', 'Slope %': o.slope ?? '' }; }));
  window.ckDownload = function (k) { const s = sets(), L = k === 'cc' ? s.cc : s.rem;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csvOf(L)], { type: 'text/csv' })); a.download = CK.name.replace(/\.csv$/i, '') + (k === 'cc' ? ' - could not check.csv' : ' - removed.csv'); a.click(); };

  // ---- add the passing lots to DLG HQ ----
  const nextMon = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return localISO(d); };
  async function ckDrawImport(pass) {
    const box = $('ckImp'); if (!box) return; const I = CK.imp;
    if (I && I.stage !== 'done') { box.innerHTML = `<div class="card" style="border-left:4px solid #b26a00;margin:0"><b>Import into "${esc(I.name)}" did not finish.</b> <span class="small">${n(Math.min(I.next, I.rows.length))} of ${n(I.rows.length)} lots saved${I.stage === 'finish' ? '; offer codes still need assigning' : ''}.</span><br><br>
      ${I.stage === 'finish' ? `<button class="btn" onclick="ckFinish()">Finish codes</button>` : `<button class="btn" onclick="ckImportRun()">Resume import</button>`}<div id="ckMsg" class="small" style="margin-top:8px"></div></div>`; return; }
    if (I && I.stage === 'done') { box.innerHTML = `<div class="card" style="border-left:4px solid #1d7a3a;margin:0">${I.summary || ''}<div class="small muted" style="margin-top:6px">To add this list somewhere else, pick the file again.</div></div>`; return; }
    if (!pass.length) { box.innerHTML = '<div class="small muted">No lots passed, nothing to add.</div>'; return; }
    box.innerHTML = '<div class="small muted">Loading pools…</div>';
    const [{ data: pools }, { data: tpls }] = await Promise.all([sb.from('campaigns').select('id,name,drop_date,records').ilike('name', 'POOL%').gte('drop_date', '2099-01-01').order('id', { ascending: false }), sb.from('templates').select('name,file_name').eq('kind', 'mail').order('name')]);
    CK.pools = pools || []; const neutral = (tpls || []).find(t => /neutral/i.test(t.name) && /blessing/i.test(t.name)) || (tpls || []).find(t => /neutral/i.test(t.name));
    if (!$('ckImp')) return;
    $('ckImp').innerHTML = `<div class="card" style="margin:0"><b>Add the ${n(pass.length)} passing lots (${n(lettersOf(pass))} letters)</b> <span class="small muted">Only passed lots are added. Do-not-mail and not-interested contacts in DLG HQ are left off.</span>
      <div class="row" style="margin-top:10px;gap:14px;flex-wrap:wrap;align-items:flex-start">
       <div style="flex:1;min-width:240px"><label class="f">Pool</label><select id="ckPool">${CK.pools.map(p => `<option value="${p.id}">${esc(p.name)} (${n(p.records)} lots)</option>`).join('') || '<option value="">No POOL campaign found</option>'}</select>
        <div class="small muted" style="margin:4px 0 8px">Lots already waiting in a pool are skipped.</div><button class="btn" ${CK.pools.length ? '' : 'disabled'} onclick="ckImport('pool')">Add to Pool</button></div>
       <div style="flex:1;min-width:240px"><label class="f">New campaign name</label><input id="ckName" placeholder="e.g. Brunswick NC Lots Nov 2026">
        <div class="row" style="gap:8px"><label class="f" style="flex:1">Mail date<input id="ckDate" type="date" value="${nextMon()}"></label>
        <label class="f" style="flex:1">Letter<select id="ckTpl">${(tpls || []).map(t => `<option value="${esc(t.file_name)}" ${neutral && neutral.file_name === t.file_name ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label></div>
        <div class="small muted" style="margin:4px 0 8px">Gets its own new offer code prefix.</div><button class="btn" onclick="ckImport('new')">Create campaign</button></div></div>
      <div id="ckMsg" class="small" style="margin-top:10px"></div></div>`;
  }
  const msg = t => { const e = $('ckMsg'); if (e) e.innerHTML = t; };
  window.ckImport = async function (kind) {
    if (CK.busy) return toast('Still working…'); const { pass } = sets(); let rows = pass.map(([r, , i]) => rowOf(r, i)).filter(x => x.mail_address && (x.full_name || x.apn) && x.apn);
    CK.busy = true; CK.dupes = 0; try {
      let cid, name;
      if (kind === 'pool') { cid = +$('ckPool').value; const p = CK.pools.find(x => x.id === cid); if (!p) return toast('Pick a pool'); name = p.name;
        // skip lots already waiting in any pool (same APN + county)
        msg('Checking which lots are already in a pool…'); const pk = (a, c) => String(a || '') + '|' + String(c || '').toLowerCase(), have = new Set(), apns = [...new Set(rows.map(x => x.apn))], poolIds = CK.pools.map(x => x.id);
        for (let i = 0; i < apns.length; i += 200) { const { data: ps, error } = await sb.from('properties').select('id,apn,county').in('apn', apns.slice(i, i + 200)); if (error) throw error; const byId = Object.fromEntries((ps || []).map(x => [x.id, x]));
          const ids = Object.keys(byId).map(Number); for (let k = 0; k < ids.length; k += 200) { const { data: cr, error: e2 } = await sb.from('campaign_records').select('property_id').in('campaign_id', poolIds).in('property_id', ids.slice(k, k + 200)); if (e2) throw e2; (cr || []).forEach(x => { const q = byId[x.property_id]; if (q) have.add(pk(q.apn, q.county)); }); } }
        const before = rows.length; rows = rows.filter(x => !have.has(pk(x.apn, x.county))); CK.dupes = before - rows.length;
        const { count } = await sb.from('campaign_records').select('id', { count: 'exact', head: true }).eq('campaign_id', cid);
        if ((count || 0) + rows.length > LB.MAX_CODED) return msg(`<b style="color:var(--red)">${esc(LB.tooBigMsg((count || 0) + rows.length))}</b> Pick another pool, or build a week from this pool first. Nothing was added.`);
        if (!rows.length) return msg(`All ${n(before)} passing lots are already in a pool. Nothing to add.`);
      } else { name = $('ckName').value.trim(); if (!name) return toast('Name the campaign'); if (!$('ckDate').value) return toast('Pick a mail date');
        if (/^(POOL|HOLD)\b/i.test(name)) return toast('Use Add to Pool for a pool; a new campaign can\'t start with POOL or HOLD');
        if (rows.length > LB.MAX_CODED) return msg(`<b style="color:var(--red)">${esc(LB.tooBigMsg(rows.length))}</b> Nothing was saved.`);
        const cos = [...new Set(rows.map(x => x.county).filter(Boolean))], sts = [...new Set(rows.map(x => x.state).filter(Boolean))];
        const { data: camp, error } = await sb.from('campaigns').insert({ name, channel: 'mail', county: cos.join(', ') || null, state: sts.join(', ') || null, drop_date: $('ckDate').value, template: $('ckTpl').value || null, cost: 0, source: 'hq', mail_status: 'not_sent' }).select('id').single();
        if (error) throw error; cid = camp.id; }
      const { data: mx } = await sb.from('campaign_records').select('id').eq('campaign_id', cid).order('id', { ascending: false }).limit(1);
      CK.imp = { kind, cid, name, rows, next: 0, stage: 'rows', maxBefore: mx && mx[0] ? mx[0].id : 0, dupes: CK.dupes || 0, tot: { leads: 0, records: 0, skipped_dnm: 0, skipped_not_interested: 0, skipped_recent: 0, duplicate_codes: 0 } }; await save();
    } catch (e) { return msg(`<b style="color:var(--red)">${esc(e.message || e)}</b> Nothing was added.`); } finally { CK.busy = false; }
    return ckImportRun();
  };
  window.ckImportRun = async function () { const I = CK.imp; if (!I || CK.busy) return; CK.busy = true;
    try { while (I.next < I.rows.length) { msg(`Saving lots into "${esc(I.name)}": ${n(I.next)} of ${n(I.rows.length)}… keep this tab open.`);
        const { data, error } = await sb.rpc('import_campaign_list', { cid: I.cid, rows: I.rows.slice(I.next, I.next + 500), src: 'hq', tag: null, skip_dnm: true, skip_ni: true, skip_days: 0 });
        if (error) { await ckDrawImport([]); return msg(`<b style="color:var(--red)">Stopped at ${n(I.next)} of ${n(I.rows.length)}: ${esc(error.message)}</b> The lots saved so far stay. Click Resume import to continue.`); }
        for (const k in I.tot) I.tot[k] += data[k] || 0; I.next = Math.min(I.next + 500, I.rows.length); await save(); }
      I.stage = 'finish'; await save();
    } finally { CK.busy = false; }
    return ckFinish();
  };
  window.ckFinish = async function () { const I = CK.imp; if (!I || CK.busy) return; CK.busy = true;
    try { msg('Assigning offer codes…');
      const { data: fin, error } = await sb.rpc('finish_campaign_import', { cid: I.cid });
      if (error) { await ckDrawImport([]); return msg(`<b style="color:var(--red)">All ${n(I.tot.records)} lots are saved in "${esc(I.name)}", but offer codes still need assigning${/timeout|cancel/i.test(error.message) ? ' (the database timed out)' : ''}: ${esc(error.message)}.</b> Do not mail this campaign yet. Click <b>Finish codes</b> to try again.`); }
      const clash = await LB.blockOnCodeClash(I.cid, I.kind === 'pool' ? { keep: true } : {}); if (clash && !clash.soft && I.kind !== 'pool') { I.stage = 'done'; I.summary = `<b style="color:var(--red)">${esc(clash.msg)}</b>`; await save(); return ckDrawImport([]); }
      msg('Counting letters…'); try { await recountCampaign(I.cid); } catch (e) {}
      const recs = []; for (let f = 0; ; f += 1000) { const { data, error: e2 } = await sb.from('campaign_records').select('id,lead_id,' + OWN_SEL).eq('campaign_id', I.cid).gt('id', I.maxBefore).order('id').range(f, f + 999); if (e2) break; recs.push(...(data || [])); if (!data || data.length < 1000) break; }
      const owners = new Set(recs.map(r => r.lead_id).filter(Boolean)).size, already = Math.max(0, owners - I.tot.leads), T = I.tot;
      I.stage = 'done'; I.summary = (clash ? `<b style="color:${clash.soft ? '#b26a00' : 'var(--red)'}">${esc(clash.msg)}</b><br>` : '') + `<b>${I.kind === 'pool' ? 'Added to' : 'Created'} "${esc(I.name)}": ${n(letterCount(recs))} letters (${n(recs.length)} lots).</b>`
        + `<br>${n(already)} of ${n(owners)} owners were already in DLG HQ; ${n(T.leads)} new contacts.${fin && fin.first_code ? ' Offer codes start ' + esc(fin.first_code) + '.' : ''}`
        + (T.skipped_dnm + T.skipped_not_interested + (I.dupes || 0) ? `<br>Left off: ${n(T.skipped_dnm)} do-not-mail · ${n(T.skipped_not_interested)} said no${I.dupes ? ` · ${n(I.dupes)} already in a pool` : ''}.` : '')
        + ` <a href="#" onclick="go('campaign:${I.cid}');return false">Open campaign →</a>`;
      await save(); window._poolLet = null; ckDrawImport([]);
    } finally { CK.busy = false; }
  };
})();
