// DLG HQ - Split Finder county builder (run by Claude from the browser console; not loaded by the app).
// Pulls a county's vacant parcels, finds each parcel's zoning district (point in polygon), measures area, and keeps
// parcels big enough for 3+ lots under that district's minimum lot size. Frontage/flood/slope come after, from split_checks.js.
(function () {
  const SPB = window.SPB = { log: [], state: '' };
  const sleep = ms => new Promise(res => { const ch = new MessageChannel(); const t0 = performance.now(); ch.port1.onmessage = () => { performance.now() - t0 >= ms ? res() : ch.port2.postMessage(0); }; ch.port2.postMessage(0); });
  async function getJ(url, params, tries = 4) {
    const body = new URLSearchParams(params);
    for (let i = 0; i < tries; i++) {
      try {
        const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 90000);
        const r = await fetch(url, { method: 'POST', body, signal: ac.signal }); clearTimeout(t);
        const j = await r.json(); if (j.error) throw new Error(j.error.message || 'error'); return j;
      } catch (e) { if (i === tries - 1) throw e; await sleep(1500 * (i + 1)); }
    }
  }
  async function all(url, where, fields, extra = {}) {
    const out = [];
    for (let off = 0; off < 200000; off += 1000) {
      const j = await getJ(url, { where, outFields: fields, returnGeometry: 'true', outSR: '4326', maxAllowableOffset: '0.00002', resultOffset: off, resultRecordCount: 1000, orderByFields: extra.order || 'OBJECTID', f: 'json', ...extra.params });
      out.push(...(j.features || [])); SPB.state = `${url.split('/services/')[1]} ${out.length}`;
      if (!j.features || j.features.length < 1000) break;
    }
    return out;
  }
  const FT = 364000;
  function ringArea(r, lat0) { const k = Math.cos(lat0 * Math.PI / 180); let s = 0; for (let i = 1; i < r.length; i++) s += (r[i - 1][0] * k * FT) * (r[i][1] * FT) - (r[i][0] * k * FT) * (r[i - 1][1] * FT); return s / 2; }
  function inRing(p, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { if (((r[i][1] > p[1]) !== (r[j][1] > p[1])) && (p[0] < (r[j][0] - r[i][0]) * (p[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) c = !c; } return c; }
  function inRings(p, rings) { let c = false; for (const r of rings) if (inRing(p, r)) c = !c; return c; }

  // cfg: { county, parcels: {url, where, fields, row: attrs => {...}}, zoning: [{url, where, fields, jur, code: attrs => str}] }
  SPB.prescreen = async function (cfg) {
    SPB.state = 'zoning';
    const zones = [];
    for (const z of cfg.zoning) {
      const fs = await all(z.url, z.where || '1=1', z.fields, { order: z.order || 'OBJECTID' });
      for (const f of fs) { if (!f.geometry || !f.geometry.rings) continue; const code = String(z.code(f.attributes) || '').trim(); if (!code) continue; const rings = f.geometry.rings; const xs = rings.flat().map(p => p[0]), ys = rings.flat().map(p => p[1]); zones.push({ jur: typeof z.jur === 'function' ? z.jur(f.attributes) : z.jur, code, rings, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], pri: z.pri || 0 }); }
    }
    const grid = new Map(); const G = 0.01;
    for (const z of zones) for (let x = Math.floor(z.bb[0] / G); x <= Math.floor(z.bb[2] / G); x++) for (let y = Math.floor(z.bb[1] / G); y <= Math.floor(z.bb[3] / G); y++) { const k = x + ',' + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(z); }
    SPB.state = 'parcels';
    const ps = await all(cfg.parcels.url, cfg.parcels.where, cfg.parcels.fields, { order: cfg.parcels.order || 'OBJECTID' });
    const rows = [];
    for (const f of ps) {
      if (!f.geometry || !f.geometry.rings) continue;
      const pts = f.geometry.rings[0]; const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length, lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const area = Math.abs(f.geometry.rings.reduce((s, r) => s + ringArea(r, lat), 0));
      let hit = null;
      for (const z of grid.get(Math.floor(lon / G) + ',' + Math.floor(lat / G)) || []) if (lon >= z.bb[0] && lon <= z.bb[2] && lat >= z.bb[1] && lat <= z.bb[3] && inRings([lon, lat], z.rings) && (!hit || z.pri > hit.pri)) hit = z;
      rows.push({ ...cfg.parcels.row(f.attributes), lat: +lat.toFixed(6), lng: +lon.toFixed(6), sqft: Math.round(area), jur: hit ? hit.jur : null, zone: hit ? hit.code : null });
    }
    SPB.state = 'done ' + rows.length; SPB.rows = rows; SPB.zonesN = zones.length;
    return rows;
  };
})();
