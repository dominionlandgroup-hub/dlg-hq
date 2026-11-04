// DLG HQ - List Checker (Nov 2026). Drop a PropStream CSV and every lot is checked in the browser against free public
// maps (county parcels, FEMA flood, USGS elevation, NCDOT/Census roads, building footprints, water bodies).
// No Claude, no credits. Passing lots go straight to the Import page. Results are saved in this browser, so a
// closed tab picks up where it left off.
(function () {
  const RULES = 'Road frontage (50 ft+ on a public road; NC: state-maintained, or a town street inside city limits; SC: any public road) · no flag/long strips · 50%+ in the flood zone · 15%+ slope · house or building on the lot (possible encroachment) · under 0.1 acre · under 40 ft wide · triangles / odd shapes · waterfront';
  let CK = null; // {name, cols, rows, map, res, run}
  const KEY = n => 'ck:' + n;
  const pick = (cols, ...names) => { const lc = cols.map(c => c.toLowerCase().trim()); for (const n of names) { const i = lc.indexOf(n.toLowerCase()); if (i >= 0) return cols[i]; } for (const n of names) { const i = lc.findIndex(c => c.includes(n.toLowerCase())); if (i >= 0) return cols[i]; } return ''; };
  const loadRC = () => window.RC ? Promise.resolve() : new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'tools/rc.js?v=2'; s.onload = ok; s.onerror = () => no(new Error('checker script did not load')); document.head.appendChild(s); });
  const save = () => { try { localStorage.setItem(KEY(CK.name), JSON.stringify(CK.res)); } catch (e) {} };

  window.vChecker = async function () {
    $('view').innerHTML = `<div class="card"><h3 style="margin-top:0">List Checker</h3>
      <div class="small muted" style="margin-bottom:10px">Drop a PropStream CSV. Every lot is checked against the county parcel map and public maps, then you send the lots that pass to Import. Runs in this browser, no Claude needed. Leave the tab open while it runs (about 2 lots a second); if it closes, open the same file again and it picks up where it stopped.</div>
      <div class="small" style="margin-bottom:10px"><b>Checks:</b> ${RULES}</div>
      <input type="file" id="ckFile" accept=".csv" onchange="ckLoad()">
      <div id="ckMap" style="margin-top:12px"></div><div id="ckOut" style="margin-top:12px"></div></div>`;
  };

  window.ckLoad = function () {
    const f = $('ckFile').files[0]; if (!f) return;
    Papa.parse(f, { header: true, skipEmptyLines: true, complete: res => {
      const cols = res.meta.fields || [];
      const map = { apn: pick(cols, 'APN', 'Parcel Number', 'Parcel ID', 'PIN'), county: pick(cols, 'County', 'Property County'), state: pick(cols, 'State', 'Property State'),
        owner: pick(cols, 'Owner 1 Full Name', 'Owner Name', 'Owner 1 Name', 'Owner'), mail: pick(cols, 'Mailing Address', 'Mail Address'), mzip: pick(cols, 'Mailing Zip', 'Mail Zip') };
      let prev = {}; try { prev = JSON.parse(localStorage.getItem(KEY(f.name)) || '{}'); } catch (e) {}
      CK = { name: f.name, cols, rows: res.data, map, res: prev, run: false };
      const sel = k => `<select id="ck_${k}"><option value="">(none)</option>${cols.map(c => `<option ${c === map[k] ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
      $('ckMap').innerHTML = `<b>${res.data.length.toLocaleString()} lots in ${esc(f.name)}</b>${Object.keys(prev).length ? ` <span class="small muted">(${Object.keys(prev).length.toLocaleString()} already checked earlier; those are kept)</span>` : ''}
        <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px">
          <label class="f">Parcel number (APN) ${sel('apn')}</label><label class="f">County ${sel('county')}</label><label class="f">State ${sel('state')}</label>
          <label class="f">Owner ${sel('owner')}</label><label class="f">Mailing address ${sel('mail')}</label><label class="f">Mailing zip ${sel('mzip')}</label></div>
        <button class="btn" style="margin-top:10px" id="ckGo" onclick="ckRun()">Check all lots</button> <button class="btn ghost" onclick="ckStop()">Pause</button>`;
      ckShow();
    } });
  };

  window.ckStop = () => { if (CK) CK.run = false; };
  window.ckRun = async function () {
    if (!CK || CK.run) return; for (const k of Object.keys(CK.map)) CK.map[k] = $('ck_' + k)?.value || '';
    if (!CK.map.apn || !CK.map.county) return alert('Pick the parcel number and county columns first.');
    try { await loadRC(); } catch (e) { return alert(e.message); }
    CK.run = true; const todo = CK.rows.map((r, i) => [r, i]).filter(([, i]) => !CK.res[i] || CK.res[i].error); let j = 0, n = 0;
    const one = async ([r, i]) => { const row = { properties: { apn: String(r[CK.map.apn] || '').trim(), county: String(r[CK.map.county] || '').replace(/ county$/i, '').trim().replace(/\b\w/g, c => c.toUpperCase()).replace(/\B\w+/g, w => w.toLowerCase()), state: String(r[CK.map.state] || '').trim().toUpperCase() } };
      let o; for (let t = 0; t < 3; t++) { try { o = await RC.check(row); break; } catch (e) { o = { error: String(e.message || e).slice(0, 80) }; await new Promise(z => setTimeout(z, 1500 * (t + 1))); } }
      CK.res[i] = o; if (++n % 25 === 0) { save(); ckShow(); } };
    const w = async () => { while (CK.run && j < todo.length) await one(todo[j++]); };
    await Promise.all(Array.from({ length: 8 }, w)); CK.run = false; save(); ckShow();
  };

  const ownKey = r => { const a = String(r[CK.map.mail] || '').toLowerCase().replace(/[^a-z0-9]/g, ''); return a ? a + '|' + String(r[CK.map.mzip] || '').slice(0, 5) : 'o' + String(r[CK.map.owner] || '').toLowerCase(); };
  const why = o => !o ? '' : o.pass ? '' : o.fail || ('could not check: ' + (o.error || ''));
  window.ckShow = function () {
    if (!CK) return; const done = Object.keys(CK.res).length, R = CK.rows.map((r, i) => [r, CK.res[i]]);
    const pass = R.filter(([, o]) => o && o.pass), fail = R.filter(([, o]) => o && !o.pass);
    const reasons = {}; fail.forEach(([, o]) => { const k = why(o).replace(/^hold: |^aerial: /, ''); reasons[k] = (reasons[k] || 0) + 1; });
    const letters = new Set(pass.map(([r]) => ownKey(r))).size;
    $('ckOut').innerHTML = `<div style="height:8px;background:var(--line,#eee);border-radius:4px;overflow:hidden"><div style="height:100%;width:${CK.rows.length ? Math.round(100 * done / CK.rows.length) : 0}%;background:#5c2977"></div></div>
      <div class="small" style="margin-top:6px">${done.toLocaleString()} of ${CK.rows.length.toLocaleString()} checked${CK.run ? ' · running…' : ''}</div>
      <div class="pstats" style="grid-template-columns:repeat(3,1fr);margin-top:10px">
        <div><div class="small muted">Pass</div><b style="font-size:22px;color:#1d7a3a">${pass.length.toLocaleString()}</b><div class="small muted">${letters.toLocaleString()} letters (one per owner)</div></div>
        <div><div class="small muted">Removed</div><b style="font-size:22px;color:var(--red)">${fail.length.toLocaleString()}</b></div>
        <div><div class="small muted">Not checked yet</div><b style="font-size:22px">${(CK.rows.length - done).toLocaleString()}</b></div></div>
      ${fail.length ? `<details style="margin-top:10px" open><summary><b>Why lots were removed</b></summary><table class="small" style="margin-top:6px">${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="right num">${v.toLocaleString()}</td></tr>`).join('')}</table></details>` : ''}
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" ${pass.length ? '' : 'disabled'} onclick="ckToImport()">Send ${pass.length.toLocaleString()} passing lots to Import</button>
        <button class="btn ghost" ${fail.length ? '' : 'disabled'} onclick="ckDownload(false)">Download removed lots (with reasons)</button></div>
      ${fail.length ? `<details style="margin-top:10px"><summary class="small">See removed lots</summary><table class="small" style="margin-top:6px"><tr><th>Owner</th><th>APN</th><th>Reason</th><th>Acres</th><th>Frontage ft</th></tr>${fail.slice(0, 300).map(([r, o]) => `<tr><td>${esc(r[CK.map.owner] || '')}</td><td>${esc(r[CK.map.apn] || '')}</td><td>${esc(why(o))}</td><td>${o.acres ?? ''}</td><td>${o.frontFt ?? ''}</td></tr>`).join('')}</table></details>` : ''}`;
  };

  const csvOf = (list, extra) => Papa.unparse(list.map(([r, o]) => ({ ...r, ...(extra ? { 'Check result': o.pass ? 'pass' : why(o), 'Acres (county map)': o.acres ?? '', 'Road frontage ft': o.frontFt ?? '', 'Flood %': o.floodPct ?? '', 'Slope %': o.slope ?? '' } : { 'Acres (county map)': o.acres ?? '' }) })));
  window.ckDownload = function (passing) { const R = CK.rows.map((r, i) => [r, CK.res[i]]).filter(([, o]) => o && (passing ? o.pass : !o.pass));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csvOf(R, true)], { type: 'text/csv' })); a.download = CK.name.replace(/\.csv$/i, '') + (passing ? ' - passed.csv' : ' - removed.csv'); a.click(); };
  // Hands the passing lots to the Import page as if the file had been picked there.
  window.ckToImport = async function () {
    const R = CK.rows.map((r, i) => [r, CK.res[i]]).filter(([, o]) => o && o.pass); const file = new File([csvOf(R, false)], CK.name.replace(/\.csv$/i, '') + ' - checked.csv', { type: 'text/csv' });
    await go('import'); for (let t = 0; t < 40 && !$('impFile'); t++) await new Promise(z => setTimeout(z, 100));
    const dt = new DataTransfer(); dt.items.add(file); $('impFile').files = dt.files; $('impFile').dispatchEvent(new Event('change'));
    $('view').insertAdjacentHTML('afterbegin', `<div class="card small" style="border-left:4px solid #1d7a3a">${R.length.toLocaleString()} checked lots loaded from the List Checker. Name the campaign (or pick the POOL), add the counties, then save.</div>`);
  };
})();
