// DLG HQ - Weekly List. Builds Damien's infill blind-offer list with his rules, one county at a time, into Spot Check.
// Steps: 1 Pull + check lots  2 Comps  3 MLS check (upload the Canopy export)  4 Water + zoning  5 Spot Check  6 Mail list.
// Rules (Damien, Nov 2026): infill only; real comp within 1/2 mile or no letter; comp $50K+ ($10K fee floor); $100K+ comps first;
// no lots bought in the last 2 years (an LLC/company buyer with no price counts as a sale); no waterfront; nothing active,
// coming soon or under contract on the MLS; no commercial / office / industrial zoning; offer = 70% of comp.
// Everything runs in this browser tab. Leave the tab open while a step runs. Work is saved to Spot Check as each county finishes.
(function () {
  const W = window.WK = { log: [], busy: false, stat: {} };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc2 = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const say = m => { W.log.unshift(new Date().toLocaleTimeString() + '  ' + m); if (W.log.length > 400) W.log.pop(); const el = document.getElementById('wk_log'); if (el) el.textContent = W.log.join('\n'); };
  const RULES = W.RULES = { compMi: 0.5, compFloor: 50000, topComp: 100000, offerPct: 0.7, recentDays: 730, compSince: 730, minWidthFt: 47, minAcres: 0.08, maxAcres: 5.05, minFrontFt: 25 };
  const NC_COUNTIES = ['Mecklenburg', 'Gaston', 'Lincoln', 'Cabarrus', 'Iredell', 'Rowan', 'Union', 'Stanly', 'Montgomery', 'Catawba', 'Cleveland', 'Davidson', 'Randolph', 'Brunswick', 'Columbus', 'Onslow', 'Pender', 'Duplin', 'Wilson'];
  const SC_COUNTIES = ['York', 'Lancaster'];
  W.counties = [...NC_COUNTIES, ...SC_COUNTIES];
  async function gj(u, opt, tries = 4) { for (let i = 0; i < tries; i++) { try { const r = await fetch(u, { ...(opt || {}), signal: AbortSignal.timeout(60000) }); const j = await r.json(); if (!j.error) return j; } catch (e) { } await sleep(1500 * (i + 1)); } return null; }

  // ---------- buy boxes (from the Buyers table) ----------
  const SIZE = { 'under 1/4 acre': [0, 0.25], '1/4 to 1/2 acre': [0.25, 0.5], '1/2 to 1 acre': [0.5, 1], '1 to 5 acres': [1, 5] };
  const PRICE = s => { const m = String(s).replace(/,/g, '').match(/\$?(\d+)\s*k/i); return m ? +m[1] * 1000 : null; };
  W.spec = async () => { const { data } = await sb.from('buyers').select('id,name,company,kind,counties,cities,zips,lot_sizes,price_ranges,utilities,deal_breakers,bb_submitted_at,min_acres,max_acres').or('bb_submitted_at.not.is.null,kind.eq.buyer').limit(3000); // buyers who sent a buy box, plus past buyers
    return (data || []).filter(b => (b.counties || []).length || (b.zips || []).length || (b.cities || []).length).map(b => {
      let sizes = (b.lot_sizes || []).map(s => SIZE[String(s).toLowerCase()]).filter(Boolean); if (!sizes.length) sizes = [[+b.min_acres || 0, +b.max_acres || 1]];
      const zips = (Array.isArray(b.zips) ? b.zips : String(b.zips || '').match(/\b\d{5}\b/g) || []).map(String);
      return { id: b.id, who: b.company || b.name, form: !!b.bb_submitted_at, counties: b.counties || [], zips, cities: (b.cities || []).map(c => String(c).toUpperCase()), sizes,
        mp: Math.max(0, ...(b.price_ranges || []).map(PRICE).filter(Boolean)) || null }; }); };
  const ncity = s => String(s || '').toUpperCase().replace(/^(INCLUDING|AND)\s+/, '').replace(/[^A-Z]/g, '');
  const fitsFor = (spec, r) => { const out = [], z = String(r.zip || '').slice(0, 5), city = ncity(r.city);
    for (const b of spec) { if (!b.sizes.some(([a, c]) => r.ac >= a - 0.005 && r.ac <= c + 0.005)) continue; let ok;
      if (b.zips.length) ok = b.zips.includes(z); else if (b.cities.length) ok = b.cities.some(c => ncity(c) === city); else ok = b.counties.includes(r.c);
      if (ok) out.push(b.id); } return out; };

  // ---------- owner / parcel filters ----------
  const ENTITY = /\b(LLC|L L C|INC|CORP|CORPORATION|COMPANY|CO\b|LP\b|LLP|BANK|PARTNERS|PARTNERSHIP|PROPERTIES|HOLDINGS|INVESTMENTS?|ENTERPRISES|GROUP|ASSOCIATES|LTD|PLLC|PA\b|CAPITAL|VENTURES|REALTY|FUND|MANAGEMENT|MGMT|RENTALS?|ACQUISITIONS?)\b/i;
  const OKENT = /\b(TRUST|TRUSTEE|TRS|ESTATE|EST\b|HEIRS|LIVING TRUST|REVOCABLE|CHURCH|MINISTR|BAPTIST|METHODIST|PRESBYTERIAN|FELLOWSHIP|TABERNACLE|CONGREGATION)\b/i;
  const GOV = /\b(COUNTY OF|CITY OF|TOWN OF|VILLAGE OF|STATE OF|UNITED STATES|USA\b|DEPT|DEPARTMENT|BOARD OF|SCHOOL|AUTHORITY|COMMISSION|HOMEOWNERS|HOME OWNERS|HOA\b|PROPERTY OWNERS|OWNERS ASS|ASSOCIATION|ASSN|POA\b|HOUSING|REDEVELOPMENT|UNIVERSITY|COLLEGE|HOSPITAL|RAILROAD|RAILWAY|DUKE ENERGY|POWER|ELECTRIC|UTILIT|WATER|SEWER|NCDOT|DOT\b|CEMETERY|LODGE|CLUB\b|LEGION|VFW|HABITAT)\b/i;
  const BUILDER = /\b(BUILDERS?|BUILDING|CONSTRUCTION|HOMES|HOMEBUILDERS?|DEVELOPMENT|DEVELOPERS?|COMMUNITIES|RESIDENTIAL|LAND CO|LOTS|NVR|PULTE|LENNAR|HORTON|MERITAGE|TAYLOR MORRISON|TRUE HOMES|EASTWOOD|MATTAMY|SHEA|TOLL BROTHERS|KB HOME|DREAM FINDERS|SMITH DOUGLAS|STANLEY MARTIN)\b/i;
  const REDFLAG = /EASEMENT|DRIVEWAY|DRIVE WAY|R\/W\b|RIGHT[- ]OF[- ]WAY|\bROW\b|COMMON AREA|COMMON PROP|COMMON OPEN|OPEN SPACE|BUFFER|\bSTRIP\b|REMNANT|DRAINAGE|DETENTION|RETENTION|\bPOND\b|UTILITY|CEMETERY|LANDLOCK|LAND LOCK|NO ACCESS|UNBUILDABLE|NON[- ]BUILDABLE|NOT BUILDABLE|SLIVER|\bGAP\b|AMENITY|RECREATION AREA|CONSERVATION|WETLAND|SEWER|PUMP STATION|LIFT STATION|TOWER SITE|CELL TOWER|SUBSTATION|WATERFRONT/i;
  const COMM = /COMM|INDUS|OFFICE|RETAIL|STORE|WAREH|MANUF|HOTEL|MOTEL|RESTAUR|SERVICE ST|GAS STA|SCHOOL|EXEMPT|GOVERN|UTILIT|PARKING|CEMET|MOBILE HOME PARK|APART|MEDICAL|REC AREA|COUNTY PROPERTY|FLOODWAY|NO BUILD|GREENWAY|NON PERC|LEACHFIELD|UNSUITABLE|FLOOD PLAIN/i;

  // ---------- geometry ----------
  const F3 = 3.28084;
  const proj = lat0 => { const c = Math.cos(lat0 * Math.PI / 180); return ([x, y]) => [x * 111320 * c, y * 110540]; };
  const mainRing = rs => rs.reduce((a, b) => b.length > a.length ? b : a);
  const dps = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
  const inRing = (pt, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c; } return c; };
  function shape(rings) { const ring = mainRing(rings), T = proj(ring[0][1]), P = ring.map(T); let A = 0, per = 0; for (let i = 0; i < P.length - 1; i++) { A += P[i][0] * P[i + 1][1] - P[i + 1][0] * P[i][1]; per += Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); } A = Math.abs(A) / 2;
    let best = { w: 1e12, l: 0 }; for (let i = 0; i < P.length - 1; i++) { const dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], L = Math.hypot(dx, dy); if (L < 0.5) continue; const ux = dx / L, uy = dy / L; let a1 = 1e18, a2 = -1e18, b1 = 1e18, b2 = -1e18; for (const [x, y] of P) { const a = x * ux + y * uy, b = -x * uy + y * ux; a1 = Math.min(a1, a); a2 = Math.max(a2, a); b1 = Math.min(b1, b); b2 = Math.max(b2, b); } const w = Math.min(a2 - a1, b2 - b1), l = Math.max(a2 - a1, b2 - b1); if (w < best.w) best = { w, l }; }
    return { w: Math.round(A / Math.max(best.l, 1) * F3), compact: per ? 4 * Math.PI * A / per / per : 0, acres: A / 4046.86 }; }
  function measure(rings, roads) { const ring = mainRing(rings), T = proj(ring[0][1]), P = ring.map(T);
    let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9; ring.forEach(([x, y]) => { mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); });
    const pd = 0.0012, box = (a, b) => !(Math.max(a[0], b[0]) < mnx - pd || Math.min(a[0], b[0]) > mxx + pd || Math.max(a[1], b[1]) < mny - pd || Math.min(a[1], b[1]) > mxy + pd);
    const rs = []; for (const g of roads) for (let i = 0; i < g.length - 1; i++) if (box(g[i], g[i + 1])) rs.push([T(g[i]), T(g[i + 1])]);
    let fr = 0, near = 1e9; for (let i = 0; i < P.length - 1; i++) { const a = P[i], b = P[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / 2));
      for (let k = 0; k < n; k++) { const p = [a[0] + (b[0] - a[0]) * (k + .5) / n, a[1] + (b[1] - a[1]) * (k + .5) / n]; let best = 1e9; for (const s of rs) { const d = dps(p, s[0], s[1]); if (d < best) best = d; } if (best <= 20) fr += L / n; if (best < near) near = best; } }
    return { fr: Math.round(fr * F3), near: near >= 1e9 ? -1 : Math.round(near) }; }
  const TILE = 0.01, rc = new Map(), fc = new Map(), tk = (x, y) => Math.floor(x / TILE) + ':' + Math.floor(y / TILE);
  const roadsTile = k => { if (!rc.has(k)) rc.set(k, LB._tileRoads(k).then(x => x || []).catch(() => [])); return rc.get(k); };
  const floodTile = k => { if (!fc.has(k)) fc.set(k, LB._tileFlood(k).then(x => x || []).catch(() => [])); return fc.get(k); };
  const tilesFor = rings => { const s = new Set(); mainRing(rings).forEach(([x, y]) => s.add(tk(x, y))); return [...s]; };
  function floodShare(rings, fl) { if (!fl.length) return 0; const ring = mainRing(rings); let x = 0, y = 0; ring.forEach(p => { x += p[0]; y += p[1]; }); const cen = [x / ring.length, y / ring.length];
    const pts = [cen, ...ring.filter((_, i) => i % Math.max(1, Math.floor(ring.length / 12)) === 0).map(p => [(p[0] * 2 + cen[0]) / 3, (p[1] * 2 + cen[1]) / 3])]; let n = 0; for (const p of pts) if (fl.some(fr => fr.some(r => inRing(p, r)))) n++; return n / pts.length; }
  const STRUCT = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0/query';
  async function structCheck(rings) { const q = new URLSearchParams({ geometry: JSON.stringify({ rings, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPolygon', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', returnCountOnly: 'true', f: 'json' });
    const j = await gj(STRUCT, { method: 'POST', body: q }, 3); return j && j.count > 0 ? 'building footprint on the lot (federal structures map)' : null; }

  // ---------- county parcel sources ----------
  const zipCache = {};
  async function zipIndex(zips) { const key = zips.join(','); if (zipCache[key]) return zipCache[key];
    const j = await gj(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query?where=ZCTA5+IN+(${zips.map(z => "'" + z + "'").join(',')})&outFields=ZCTA5&returnGeometry=true&outSR=4326&geometryPrecision=5&f=json`);
    return zipCache[key] = ((j && j.features) || []).map(f => ({ z: f.attributes.ZCTA5, r: f.geometry.rings })); }
  const YCITY = { '29730': 'ROCK HILL', '29732': 'ROCK HILL', '29733': 'ROCK HILL', '29745': 'YORK', '29710': 'CLOVER', '29708': 'FORT MILL', '29715': 'FORT MILL', '29707': 'FORT MILL', '29702': 'BLACKSBURG', '29704': 'CATAWBA', '29717': 'HICKORY GROVE', '29726': 'MC CONNELLS', '29742': 'SHARON', '29743': 'SMYRNA' };
  const LCITY = { '29720': 'LANCASTER', '29707': 'INDIAN LAND', '29058': 'HEATH SPRINGS', '29067': 'KERSHAW', '29744': 'VAN WYCK', '29715': 'FORT MILL', '29721': 'LANCASTER', '28173': 'WAXHAW' };
  const SRC = {
    NC: c => ({ url: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1/query', oid: 'objectid', state: 'NC',
      fields: 'saledate,parno,altparno,ownname,ownfrst,ownlast,mailadd,munit,mcity,mstate,mzip,siteadd,scity,szip,gisacres,improvval,struct,landval,parusedesc,legdecfull,cntyname',
      where: `cntyname='${c}' AND (improvval=0 OR improvval IS NULL) ${c === 'Catawba' ? '' : "AND (struct IS NULL OR struct<>'Y')"} AND ${c === 'Columbus' ? 'gisacres>=0.000125 AND gisacres<=0.00789' : c === 'Cleveland' ? '1=1' : `gisacres>=${RULES.minAcres} AND gisacres<=${RULES.maxAcres}`}`,
      map: f => { const a = f.attributes; return { p: a.parno, own: a.ownname, of: a.ownfrst, ol: a.ownlast, ma: [a.mailadd, a.munit].filter(Boolean).join(' '), mc: a.mcity, ms: a.mstate, mz: a.mzip, a: a.siteadd, city: a.scity, zip: a.szip,
        ac: c === 'Cleveland' ? shape(f.geometry.rings).acres : (a.gisacres || 0) * (c === 'Columbus' ? 640 : 1), lv: a.landval, use: a.parusedesc, legal: a.legdecfull, sd: a.saledate && new Date(a.saledate).getUTCFullYear() >= 1950 ? a.saledate : null }; } }),
    York: () => ({ url: 'https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Parcels/FeatureServer/0/query', oid: 'OBJECTID', state: 'SC', zips: YCITY, struct: true,
      fields: 'TAXMAPID,ParcelID,Owner1,Owner2,MailAddr1,MailAddr2,MailApt,MailCity,MailState,MailZip,PropertyAddress,GISSizeAC,deededacres,AprBldgVal,BuildingCount,AprLandVal,LandUseDesc,LegalDescription,DateSold',
      where: `(AprBldgVal=0 OR AprBldgVal IS NULL) AND (BuildingCount=0 OR BuildingCount IS NULL) AND GISSizeAC>=${RULES.minAcres} AND GISSizeAC<=${RULES.maxAcres}`,
      map: f => { const a = f.attributes; return { p: a.TAXMAPID || a.ParcelID, own: [a.Owner1, a.Owner2].filter(Boolean).join(' & '), ma: [a.MailAddr1, a.MailAddr2, a.MailApt].filter(Boolean).join(' '), mc: a.MailCity, ms: a.MailState, mz: a.MailZip, a: a.PropertyAddress,
        ac: a.GISSizeAC || a.deededacres, lv: a.AprLandVal, use: a.LandUseDesc, legal: a.LegalDescription, sd: a.DateSold || null }; } }),
    Lancaster: () => ({ url: 'https://services3.arcgis.com/rJcpRneDUBgTeCT3/arcgis/rest/services/LC_Parcels/FeatureServer/0/query', oid: 'FID', state: 'SC', zips: LCITY, struct: true, structFirst: true,
      fields: 'PIN,ACRES,GIS_Acres,OWNER_NAME,O_NAME_CON,OWNER_ADDR,OWNER_CITY,OWNER_STAT,OWNER_ZIP,PROP_LOCAT,SALE_YEAR,SALE_MONTH,SALE_DAY,CLASS',
      where: `ACRES>=${RULES.minAcres} AND ACRES<=${RULES.maxAcres}`,
      map: f => { const a = f.attributes, yy = +a.SALE_YEAR, Y = isFinite(yy) && yy > 0 ? (yy < 100 ? (yy <= 30 ? 2000 + yy : 1900 + yy) : yy) : null;
        return { p: a.PIN, own: [a.OWNER_NAME, (a.O_NAME_CON || '').trim()].filter(Boolean).join(' '), ma: a.OWNER_ADDR, mc: a.OWNER_CITY, ms: a.OWNER_STAT, mz: a.OWNER_ZIP, a: a.PROP_LOCAT, ac: a.GIS_Acres || a.ACRES, lv: 0, use: '', legal: '',
          sd: Y ? Date.UTC(Y, Math.max(0, (+a.SALE_MONTH || 1) - 1), +a.SALE_DAY || 1) : null }; } }) };
  const srcFor = c => c === 'York' ? SRC.York() : c === 'Lancaster' ? SRC.Lancaster() : SRC.NC(c);

  async function pull(c, S) { const out = []; let off = 0;
    for (;;) { const q = new URLSearchParams({ where: S.where, outFields: S.fields, returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', resultOffset: off, resultRecordCount: 2000, orderByFields: S.oid, f: 'json' });
      const j = await gj(S.url, { method: 'POST', body: q }); if (!j) throw new Error(c + ': the county parcel map stopped answering at ' + off + ' parcels. Run this county again.');
      const fs = (j.features || []).filter(f => f.geometry && f.geometry.rings); out.push(...fs); W.stat[c] = 'pulling ' + out.length.toLocaleString();
      if (!j.exceededTransferLimit && (j.features || []).length < 2000) break; if (!(j.features || []).length) break; off += (j.features || []).length; await sleep(250); }
    return out; }

  // ---------- step 1: pull + check one county ----------
  W.county = async (c, list) => {
    const spec = await W.spec(), S = srcFor(c), cut = {}, drop = w => cut[w] = (cut[w] || 0) + 1;
    say(c + ': pulling vacant parcels…'); const feats = await pull(c, S); say(c + ': ' + feats.length.toLocaleString() + ' vacant parcels');
    const zi = S.zips ? await zipIndex(Object.keys(S.zips)) : null;
    const since = Date.now() - RULES.recentDays * 864e5, keep = [];
    for (const f of feats) { const a = S.map(f), own = String(a.own || '').trim();
      if (!a.p) { drop('no parcel id'); continue; } if (!own) { drop('no owner'); continue; }
      if (GOV.test(own)) { drop('government / HOA / utility'); continue; } if (BUILDER.test(own)) { drop('builder / developer'); continue; }
      if (ENTITY.test(own) && !OKENT.test(own)) { drop('LLC / company owner'); continue; }
      if (REDFLAG.test(a.legal || '') || REDFLAG.test(a.use || '')) { drop('easement / common area / buffer / waterfront words'); continue; }
      if (COMM.test(a.use || '')) { drop('commercial / non-residential use'); continue; }
      if (a.sd && a.sd >= since) { drop('bought in the last 2 years'); continue; } if (!a.ma) { drop('no mailing address'); continue; }
      const ring = mainRing(f.geometry.rings); let x = 0, y = 0; ring.forEach(p => { x += p[0]; y += p[1]; }); const lng = x / ring.length, lat = y / ring.length;
      const r = { c, p: String(a.p), a: a.a || '', city: a.city || '', zip: String(a.zip || '').slice(0, 5), o: own, of: a.of || '', ol: a.ol || '', ma: a.ma, mc: a.mc || '', ms: a.ms || '', mz: String(a.mz || '').slice(0, 5),
        ac: Math.round((+a.ac || 0) * 100) / 100, lv: a.lv || 0, sd: a.sd ? new Date(a.sd).toISOString().slice(0, 10) : '', use: a.use || '', lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
      if (zi) { const z = zi.find(z => z.r.some(rg => inRing([lng, lat], rg))); r.zip = z ? z.z : ''; r.city = S.zips[r.zip] || ''; }
      const fits = fitsFor(spec, r); if (!fits.length) { drop('outside every buy box'); continue; }
      const sh = shape(f.geometry.rings); if (sh.w < RULES.minWidthFt) { drop('under ' + RULES.minWidthFt + ' ft wide'); continue; } if (sh.compact < 0.2) { drop('sliver shape'); continue; }
      r.w = sh.w; r.f = fits; r._g = f.geometry.rings; keep.push(r); }
    say(c + ': ' + keep.length.toLocaleString() + ' fit a buy box after owner / shape / 2-year checks');
    if (S.structFirst) { let q = 0; const bw = async () => { while (q < keep.length) { const r = keep[q++]; r.hs = await structCheck(r._g).catch(() => null); } }; await Promise.all(Array.from({ length: 10 }, bw)); }
    let i = 0, done = 0; const work = async () => { while (i < keep.length) { const r = keep[i++]; try { const ts = tilesFor(r._g); const [rd, fl] = await Promise.all([Promise.all(ts.map(roadsTile)), Promise.all(ts.map(floodTile))]);
      const m = measure(r._g, rd.flat()); r.fr = m.fr; r.near = m.near; r.fl = Math.round(floodShare(r._g, fl.flat()) * 100) / 100;
      if (!r.hs && r.fr >= RULES.minFrontFt) r.hs = S.struct ? await structCheck(r._g).catch(() => null) : await LB.houseCheck({ r: { state: S.state, county: c, mail: r.ma, site: r.a }, rings: r._g }).catch(() => null);
    } catch (e) { r.err = 1; } done++; if (done % 50 === 0) W.stat[c] = 'measuring ' + done + ' / ' + keep.length; } };
    await Promise.all(Array.from({ length: 6 }, work));
    keep.forEach(r => delete r._g); say(c + ': road, flood and house checks done'); W.stat[c] = 'saving';
    const st = await load(c, S.state, keep, list, spec); st.cut = cut; W.stat[c] = 'done: ' + st.loaded + ' saved, ' + st.auto + ' cut by checks';
    say(c + ': saved ' + st.loaded + ' lots to Spot Check (' + st.auto + ' cut by the checks, ' + Object.values(st.dropped).reduce((a, b) => a + b, 0) + ' skipped as already worked / mailed / tagged)');
    return st; };

  // ---------- already worked, mailed, tagged, suppressed ----------
  const NEGTAG = /due diligence|\bdd\b|run claude dd|dd done|not sell|overpriced|paid too much|listed|bad lot|\bsold\b|\bdnc\b|do not (mail|call|contact)|opted|opt out|not interested|not_interested|stop|wrong (owner|person)|deceased|hostile/i;
  const normAddr = (a, z) => String(a || '').toUpperCase().replace(/\s+\d{5}(-\d{4})?$/, '').replace(/[^A-Z0-9]/g, '') + String(z || '').replace(/\D/g, '').slice(0, 5);
  const apnKey = a => String(a || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^0+/, '');
  let BLOCKS = null;
  async function blocks() { if (BLOCKS) return BLOCKS; const owner = await LB.ownerBlocks(90), sup = await LB.suppressedApns(), openP = new Set(), openL = new Set();
    for (let o = 0; ; o += 1000) { const { data } = await sb.from('deals').select('property_id,lead_id,status').range(o, o + 999); (data || []).forEach(d => { if (!['won', 'lost', 'cancelled', 'dead'].includes(String(d.status || '').toLowerCase())) { if (d.property_id) openP.add(d.property_id); if (d.lead_id) openL.add(d.lead_id); } }); if (!data || data.length < 1000) break; }
    return BLOCKS = { owner, sup, openP, openL }; }
  async function propBlocks(rows, B) { const bad = new Map(), since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    for (let i = 0; i < rows.length; i += 150) { const ch = rows.slice(i, i + 150).map(r => r.p);
      const { data: props } = await sb.from('properties').select('id,apn,county,tags,property_owners(lead_id,leads(id,status,tags,do_not_mail))').in('apn', ch);
      const pids = (props || []).map(p => p.id), recent = new Set();
      if (pids.length) { const { data: rec } = await sb.from('campaign_records').select('property_id,campaigns(drop_date,created_at,mail_status)').in('property_id', pids);
        (rec || []).forEach(x => { const c = x.campaigns; if (!c || c.mail_status === 'not_sent') return; const d = c.drop_date || (c.created_at || '').slice(0, 10); if (d && d >= since) recent.add(x.property_id); }); }
      (props || []).forEach(p => { const leads = (p.property_owners || []).map(o => o.leads).filter(Boolean);
        const why = recent.has(p.id) ? 'mailed in the last 90 days' : B.openP.has(p.id) || leads.some(l => B.openL.has(l.id)) ? 'open deal in DLG HQ' : (p.tags || []).some(t => NEGTAG.test(t)) ? 'tagged: ' + (p.tags || []).find(t => NEGTAG.test(t)) : leads.some(l => l.do_not_mail) ? 'do not mail' : leads.some(l => (l.tags || []).some(t => NEGTAG.test(t))) ? 'owner tagged in DLG HQ' : leads.some(l => !['record', null, undefined].includes(l.status)) ? 'already worked in DLG HQ' : null;
        if (why) bad.set(String(p.apn) + '|' + String(p.county || '').toLowerCase().replace(/ county$/, ''), why); }); await sleep(50); }
    return bad; }
  async function load(county, state, rows, list, spec) {
    const B = await blocks(), pb = await propBlocks(rows, B), st = { loaded: 0, dropped: {}, auto: 0, flag: 0 }, drop = w => st.dropped[w] = (st.dropped[w] || 0) + 1;
    const FORM = new Set(spec.filter(b => b.form).map(b => b.id)), SPECIFIC = new Set(spec.filter(b => b.zips.length || b.cities.length).map(b => b.id));
    const pr = r => { const f = r.f || []; return f.filter(id => FORM.has(id) && SPECIFIC.has(id)).length * 10 + f.filter(id => FORM.has(id)).length * 2 + f.length; };
    const seen = new Set(), seenOwner = new Set(), out = [];
    for (const r of [...rows].sort((a, b) => pr(b) - pr(a))) { if (seen.has(r.p)) continue; seen.add(r.p); const ok = normAddr(r.ma, r.mz);
      const pw = pb.get(r.p + '|' + county.toLowerCase()); if (pw) { drop(pw); continue; }
      if (B.sup.has(String(r.p)) || B.sup.has(apnKey(r.p))) { drop('suppression list'); continue; }
      const ow = ok.length > 8 ? B.owner.get(ok) : null; if (ow) { drop(ow); continue; }
      let auto = null, flag = null;
      if (r.err) flag = 'Road check did not finish - look at the aerial.';
      else if (r.fr < RULES.minFrontFt && (r.near < 0 || r.near > 30)) auto = r.near < 0 ? 'No public road on the map near this lot.' : 'No road frontage: nearest public road is ' + r.near + ' m (' + Math.round(r.near * 3.281) + ' ft) away. Likely behind houses.';
      else if (r.fr < RULES.minFrontFt) flag = 'Only about ' + r.fr + ' ft touching a public road on the map (needs ' + RULES.minFrontFt + ' ft). Could be a flag lot.';
      if (!auto && r.hs) auto = 'House check: ' + r.hs + '.';
      if (!auto && r.fl >= 0.5) auto = 'Mostly in a FEMA flood zone (' + Math.round(r.fl * 100) + '%).'; else if (!flag && r.fl >= 0.2) flag = 'Part of the lot is in a flood zone (' + Math.round(r.fl * 100) + '%).';
      const key = ok.length > 8 ? ok : ('P' + r.p), dup = seenOwner.has(key); if (!auto) seenOwner.add(key);
      if (dup && !auto) flag = (flag ? flag + ' ' : '') + 'Same owner has another lot on this list (one letter per owner).';
      if (auto) st.auto++; else if (flag) st.flag++;
      out.push({ list, county, state, apn: r.p, data: r, auto_cut: auto, flag, priority: (auto ? 0 : 100) + pr(r) }); }
    for (let i = 0; i < out.length; i += 500) { const { error } = await sb.from('spot_lots').upsert(out.slice(i, i + 500), { onConflict: 'list,county,apn', ignoreDuplicates: true }); if (error) throw new Error(error.message); st.loaded += Math.min(500, out.length - i); await sleep(100); }
    return st; }

  // ---------- rows helper ----------
  async function rowsOf(list, county, live, cols = 'id,county,apn,decision,auto_cut,flag,comp,priority,data') { const out = []; let maxId = 0;
    for (;;) { let r = sb.from('spot_lots').select(cols).eq('list', list).gt('id', maxId).order('id').limit(1000); if (county) r = r.eq('county', county); if (live) r = r.is('auto_cut', null).or('decision.is.null,decision.eq.good');
      const { data, error } = await r; if (error) throw new Error(error.message); if (!data.length) break; maxId = data[data.length - 1].id; out.push(...data); } return out; }
  async function addFlag(id, cur, txt, key) { if ((cur || '').includes(key)) return false; await sb.from('spot_lots').update({ flag: ((cur || '') + ' ' + txt).trim() }).eq('id', id); return true; }
  const cutLot = (id, why) => sb.from('spot_lots').update({ auto_cut: why, decision: null, decided_at: null }).eq('id', id);

  // ---------- step 2: comps ----------
  W.comps = async (list, counties) => {
    const { data: ct } = await sb.from('hub_targets').select('data,updated_at').eq('key', 'comps').single();
    const sinceC = new Date(Date.now() - RULES.compSince * 864e5).toISOString().slice(0, 10);
    const C = (ct && ct.data || []).filter(c => c[2] >= 5000 && (!c[4] || c[4] >= sinceC)); say('Comps: using ' + C.length.toLocaleString() + ' land sales (MLS + county deeds), saved ' + (ct ? ct.updated_at.slice(0, 10) : '—'));
    const G = {}, gk = (la, lo) => Math.floor(la * 20) + '|' + Math.floor(lo * 20); C.forEach(c => { (G[gk(c[0], c[1])] = G[gk(c[0], c[1])] || []).push(c); });
    const mi = (a, b, c, d) => { const R = 3958.8, t = x => x * Math.PI / 180, dl = t(c - a), dn = t(d - b), h = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
    const near = (la, lo) => { const out = [], i = Math.floor(la * 20), j = Math.floor(lo * 20); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) (G[(i + a) + '|' + (j + b)] || []).forEach(c => out.push(c)); return out; };
    const med = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
    const usd = v => '$' + Math.round(v).toLocaleString(), off = c => Math.floor(RULES.offerPct * c / 500) * 500;
    const auto = d => { if (d.lat == null || d.lng == null) return null; const ac = +d.ac || null;
      const cand = near(+d.lat, +d.lng).map(c => ({ c, m: mi(+d.lat, +d.lng, c[0], c[1]) })).filter(x => x.m <= RULES.compMi && (!ac || !x.c[3] || (x.c[3] / ac >= 0.5 && x.c[3] / ac <= 2))).sort((a, b) => a.m - b.m);
      if (!cand.length) return null; const w25 = cand.filter(x => x.m <= 0.25); let pick, conf;
      if (w25.length >= 3) { pick = w25.slice(0, 3); conf = 'High'; } else if (cand.length >= 2) { pick = cand.slice(0, 3); conf = 'Medium'; } else if (w25.length === 1) { pick = w25; conf = 'Medium'; } else { pick = cand.slice(0, 1); conf = 'Low'; }
      return { v: med(pick.map(x => x.c[2])), conf, n: pick.length, d: pick[0].m, desc: pick.map(x => (x.c[5] || 'sale') + ' (' + x.c[6] + '): ' + usd(x.c[2]) + (x.c[3] ? ', ' + (+x.c[3]).toFixed(2) + ' ac' : '') + ', ' + x.m.toFixed(2) + ' mi').join(' | ') }; };
    const tot = { ready: 0, none: 0, under: 0, top: 0 };
    for (const cn of counties) { const rows = await rowsOf(list, cn, false); const up = [];
      for (const r of rows) { const eng = r.auto_cut && (/^No comp yet/.test(r.auto_cut) || /^Only one comp/.test(r.auto_cut) || /under \$50K/.test(r.auto_cut)); if (r.auto_cut && !eng) continue; if (eng) r.auto_cut = null;
        const d = { ...(r.data || {}) }; let comp = null, src = '';
        if (r.comp) { comp = +r.comp; src = 'your comp'; } else { const a = auto(d); if (a) { comp = a.v; src = 'auto'; Object.assign(d, { ac_conf: a.conf, ac_n: a.n, cm: 'Auto comp (' + a.conf + '): ' + a.desc, cp: Math.round(a.v), cd: +a.d.toFixed(2), off: off(a.v) }); } else ['cp', 'cm', 'off', 'cd', 'ac_conf', 'ac_n'].forEach(k => delete d[k]); }
        d.ac_src = src || 'none'; let auto_cut = null, pr = Math.min(r.priority || 0, 159);
        if (!comp) { auto_cut = 'No comp yet - no letter (your rule: real comp only)'; tot.none++; }
        else if (d.ac_conf === 'Low' && src === 'auto') { auto_cut = 'Only one comp, 1/4 to 1/2 mile away - not close enough, no letter (your rule)'; tot.none++; }
        else if (comp < RULES.compFloor) { auto_cut = 'Comp ' + usd(comp) + ' is under $50K - fee would be under $10K (your rule)'; tot.under++; }
        else { if (comp >= RULES.topComp) { pr = Math.max(pr, 100) + 60; tot.top++; } tot.ready++; }
        up.push({ id: r.id, list, county: cn, apn: r.apn, data: d, auto_cut, priority: pr, decision: auto_cut ? null : r.decision }); }
      for (let i = 0; i < up.length; i += 250) { const { error } = await sb.from('spot_lots').upsert(up.slice(i, i + 250), { onConflict: 'id' }); if (error) throw new Error(error.message); }
      say('Comps: ' + cn + ' done (' + up.length + ' lots priced)'); }
    say('Comps done: ' + tot.ready + ' with a close comp of $50K+ (' + tot.top + ' are $100K+), ' + tot.none + ' with no close comp, ' + tot.under + ' under $50K'); return tot; };

  // ---------- step 3: MLS check (Canopy export: active, coming soon, under contract land) ----------
  const AB = { ROAD: 'RD', STREET: 'ST', DRIVE: 'DR', LANE: 'LN', AVENUE: 'AVE', COURT: 'CT', CIRCLE: 'CIR', BOULEVARD: 'BLVD', PLACE: 'PL', TRAIL: 'TRL', PARKWAY: 'PKWY', TERRACE: 'TER', HIGHWAY: 'HWY', MOUNT: 'MT', SAINT: 'ST', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W' };
  const DROP = new Set(['RD', 'ST', 'DR', 'LN', 'AVE', 'AV', 'CT', 'CIR', 'BLVD', 'PL', 'TRL', 'TR', 'WAY', 'WY', 'PKWY', 'TER', 'LOOP', 'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'HWY', 'HW', 'EXT', 'RUN', 'PT', 'XING', 'CV', 'COVE', 'BND', 'HOLW', 'RDG', 'TRCE', 'SQ', 'ALY', 'NC', 'SC', 'LOT', 'TBD', 'AC', 'ACRES', 'ACREAGE', 'VAC', 'NA']);
  const toks = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).map(x => AB[x] || x).filter(x => !DROP.has(x) && !/^\d+$/.test(x) && !/^\d{5}$/.test(x));
  const cty = s => String(s || '').toUpperCase().replace(/[^A-Z ]/g, '').replace(/ (CITY|TOWN|FD|FIRE)$/, '').replace(/^MOUNT /, 'MT ').trim();
  function parseCSV(t) { const rows = []; let row = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const ch = t[i]; if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; } else if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; } else f += ch; } if (f || row.length) { row.push(f); rows.push(row); } return rows; }
  W.mls = async (list, files) => {
    const L = []; for (const file of files) { const rows = parseCSV(await file.text()); const h = rows.shift().map(x => x.trim().toLowerCase()); const ix = n => h.findIndex(x => x === n);
      const iM = ix('mls #'), iS = ix('status'), iN = ix('st #'), iNm = ix('st name'), iSf = ix('st suffix'), iC = ix('city'), iA = h.findIndex(x => x === 'address');
      if (iM < 0 || iS < 0) throw new Error(file.name + ': this does not look like a Canopy export (no "MLS #" and "Status" columns).');
      rows.forEach(r => { if (!r[iM]) return; let num = iN >= 0 ? r[iN] : '', name = iNm >= 0 ? (r[iNm] + ' ' + (iSf >= 0 ? r[iSf] : '')) : '';
        if (iA >= 0 && !name.trim()) { const m = String(r[iA]).replace(/\s+#.*$/, '').match(/^(\d+[A-Z]?)\s+(.*)$/); num = m ? m[1] : ''; name = m ? m[2] : r[iA]; }
        L.push({ ml: r[iM], st: r[iS], num: String(num || '').trim(), name: name.trim(), city: r[iC] || '' }); }); }
    const live = L.filter(x => !/withdrawn|expired|closed|sold|cancel/i.test(x.st)); say('MLS: ' + live.length.toLocaleString() + ' active / coming soon / under contract listings read');
    const byNum = {}, bySt = {}; live.forEach(x => { const t = toks(x.name); if (!t.length) return; const o = { ...x, t, c: cty(x.city), addr: (x.num + ' ' + x.name).trim() };
      if (/^[1-9]\d*[A-Z]?$/.test(x.num)) (byNum[x.num] = byNum[x.num] || []).push(o); (bySt[t.join(' ') + '|' + o.c] = bySt[t.join(' ') + '|' + o.c] || []).push(o); });
    const pre = (a, b) => b.length <= a.length && b.every((x, i) => a[i] === x), stw = s => /under|pending|uc/i.test(s) ? 'Under contract' : /coming/i.test(s) ? 'Coming soon' : 'Active';
    let cut = 0, flagged = 0; const rows = await rowsOf(list, null, true, 'id,county,flag,data');
    for (const r of rows) { const d = r.data || {}, a = String(d.a || '').toUpperCase().trim(), m = a.match(/^(\d+[A-Z]?)\s+(.*)$/), lc = cty(d.city); let t = toks(m ? m[2] : a);
      if (lc) { const ct = lc.split(' '); if (t.slice(-ct.length).join(' ') === lc) t = t.slice(0, -ct.length); } if (!t.length) continue;
      if (m && /^[1-9]/.test(m[1])) { const h = (byNum[m[1]] || []).filter(x => pre(t, x.t) && (!lc || !x.c || x.c === lc)); if (h.length) { await cutLot(r.id, 'On the MLS now (' + stw(h[0].st) + ', MLS #' + h[0].ml + ', ' + h[0].addr + ') - no letter'); cut++; continue; } }
      const sh = lc ? bySt[t.join(' ') + '|' + lc] : null; if (sh && await addFlag(r.id, r.flag, 'Possible MLS listing on this street: ' + sh[0].addr + ', ' + sh[0].city + ' (MLS #' + sh[0].ml + ', ' + stw(sh[0].st).toLowerCase() + ') - check before mailing.', sh[0].ml)) flagged++; }
    say('MLS check done: ' + cut + ' lots cut (same address as a listing), ' + flagged + ' flagged (listing on the same street).'); return { cut, flagged }; };

  // ---------- step 4: water + zoning ----------
  const NHD = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12/query';
  const pt = (r, extra) => new URLSearchParams({ geometry: JSON.stringify({ x: +r.data.lng, y: +r.data.lat, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPoint', spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'false', f: 'json', ...extra });
  const ZONE = {
    Mecklenburg: [{ u: 'https://gis.charlottenc.gov/arcgis/rest/services/PLN/Zoning/MapServer/0/query', who: 'City of Charlotte', code: a => a.ZoneDes, cls: a => a.ZoneClass }],
    Cabarrus: [36, 37, 38, 39, 40, 41, 35].map(L => ({ u: 'https://location.cabarruscounty.us/arcgisservices/rest/services/opendata/MapServer/' + L + '/query', who: 'Cabarrus County', code: a => a[Object.keys(a).find(k => /^(ZONING|ZONE|ZONE_CODE|ZONECLASS|DISTRICT)$/i.test(k)) || Object.keys(a).find(k => /zon/i.test(k))] })),
    Iredell: [3, 1, 2, 6, 4, 0].map(L => ({ u: 'https://maps.iredellcountync.gov/server/rest/services/Data/Zoning/MapServer/' + L + '/query', who: 'Iredell County', code: a => a.ZONING })),
    Gaston: [{ u: 'https://cogserver.gastonianc.gov/serverweb/rest/services/Planning/Zoning_UDO/MapServer/0/query', who: 'City of Gastonia', code: a => a.ZONING }] };
  const NONRES_CLASS = /OFFICE|INDUSTRIAL|BUSINESS|INSTITUTIONAL|ACTIVITY CENTER|COMMERCIAL|TRANSIT|UPTOWN|RESEARCH|CAMPUS/;
  const NONRES_CODE = /^(GC|C-?\d|CC|CD|CBD|O-?I|OI|O-?\d|I-?\d|LI|HI|B-?\d|BP|LC|NS|CG|OFC|ML-?\d|INST|MU-?C|CMX|TC)\b/;
  W.waterZoning = async (list) => { const rows = (await rowsOf(list, null, true, 'id,county,flag,data')).filter(r => r.data && r.data.lat); say('Water + zoning: checking ' + rows.length.toLocaleString() + ' lots');
    const st = { water: 0, nearLake: 0, zoneCut: 0, zoneFlag: 0 }; let i = 0, done = 0;
    const work = async () => { while (i < rows.length) { const r = rows[i++], d = r.data, ac = +d.ac || 0.5, half = Math.sqrt(ac * 4046.86) * 0.707;
      try { const near = Math.round(40 + half); let j = await gj(NHD + '?' + pt(r, { distance: near, units: 'esriSRUnit_Meter', where: 'FTYPE IN (390,436,493) AND AREASQKM>=0.01', outFields: 'GNIS_NAME,AREASQKM,FTYPE' }), null, 3);
        if (j && j.features && j.features.length) { const a = j.features[0].attributes, nm = a.GNIS_NAME || (a.FTYPE == 390 ? 'a lake/pond' : a.FTYPE == 436 ? 'a reservoir' : 'an estuary');
          await cutLot(r.id, 'Waterfront: ' + nm + ' (' + (+a.AREASQKM).toFixed(2) + ' sq km) within ' + near + ' m of the lot center (USGS water map)'); st.water++; done++; continue; }
        const far = Math.round(250 + half); j = await gj(NHD + '?' + pt(r, { distance: far, units: 'esriSRUnit_Meter', where: 'FTYPE IN (390,436) AND AREASQKM>=1', outFields: 'GNIS_NAME' }), null, 3);
        if (j && j.features && j.features.length && await addFlag(r.id, r.flag, 'Near ' + (j.features[0].attributes.GNIS_NAME || 'a large lake') + ' (within about ' + far + ' m) - look at the aerial: if it touches the water, Cut it.', 'Near ')) st.nearLake++;
        for (const z of (ZONE[r.county] || [])) { const zj = await gj(z.u + '?' + pt(r, { outFields: '*' }), null, 2); const a = zj && zj.features && zj.features[0] && zj.features[0].attributes; if (!a) continue;
          const code = String(z.code(a) || '').toUpperCase(), cls = z.cls ? String(z.cls(a) || '').toUpperCase() : '';
          if ((cls && NONRES_CLASS.test(cls) && !/RESIDENTIAL/.test(cls)) || (!cls && NONRES_CODE.test(code))) { await cutLot(r.id, 'Zoned ' + code + (cls ? ' (' + cls.toLowerCase() + ')' : '') + ' - not residential, DLG does not buy commercial (' + z.who + ' zoning map)'); st.zoneCut++; }
          else if (/MANUFACTURED/.test(cls)) { if (await addFlag(r.id, r.flag, 'Zoned ' + code + ' (manufactured home district) - may be a mobile home park space, check before mailing.', 'manufactured')) st.zoneFlag++; }
          else if (/^(UMU|PD|DE|MX)/.test(code) && !/RESIDENTIAL/.test(cls)) { if (await addFlag(r.id, r.flag, 'Zoned ' + code + ' (mixed use / planned) - make sure a house is allowed.', 'Zoned ' + code)) st.zoneFlag++; }
          break; }
      } catch (e) { } done++; if (done % 100 === 0) say('Water + zoning: ' + done + ' / ' + rows.length); } };
    await Promise.all(Array.from({ length: 4 }, work));
    say('Water + zoning done: ' + st.water + ' waterfront cut, ' + st.nearLake + ' near a big lake (flagged), ' + st.zoneCut + ' non-residential zoning cut, ' + st.zoneFlag + ' zoning flags. Zoning maps used: Charlotte, Cabarrus, Iredell, Gastonia.'); return st; };

  // ---------- step 6: mail list (one row per owner, Excel) ----------
  W.mailList = async (list) => { const rows = (await rowsOf(list, null, true, 'id,county,state,apn,decision,comp,priority,data')).sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const seen = new Set(), out = []; const nm = d => { if (d.of || d.ol) return [d.of, d.ol]; const n = String(d.o || '').split(/\s*&\s*|\s+AND\s+/i)[0].trim(); const p = n.split(/\s+/); return /,/.test(n) ? [n.split(',')[1].trim().split(' ')[0], n.split(',')[0]] : [p.slice(1, 2).join(' '), p[0]]; };
    for (const r of rows) { const d = r.data || {}, comp = r.comp != null ? +r.comp : +d.cp; if (!comp) continue; const k = normAddr(d.ma, d.mz) || r.apn; if (seen.has(k)) continue; seen.add(k); const [fn, ln] = nm(d);
      out.push({ 'First Name': fn || '', 'Last Name': ln || '', 'Owner': d.o || '', 'Mail Address': d.ma || '', 'Mail City': d.mc || '', 'Mail State': d.ms || '', 'Mail Zip': d.mz || '', 'Property Address': d.a || '', 'Property City': d.city || '', 'County': r.county, 'State': r.state, 'Parcel': r.apn, 'Acres': d.ac || '', 'Offer': Math.floor(RULES.offerPct * comp / 500) * 500, 'Comp': Math.round(comp) }); }
    const cols = Object.keys(out[0] || { 'First Name': '' }); const qv = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const csv = [cols.join(',')].concat(out.map(o => cols.map(c => c === 'Parcel' ? '="' + o[c] + '"' : qv(o[c])).join(','))).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = 'Mail list ' + list + ' (' + out.length + ' letters).csv'; document.body.appendChild(a); a.click(); a.remove();
    say('Mail list downloaded: ' + out.length.toLocaleString() + ' letters (one per owner, highest comps first).'); return out.length; };

  // ---------- page ----------
  const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d.toISOString().slice(0, 10); };
  async function run(label, fn) { if (W.busy) return alert('A step is still running. Wait for it to finish.'); W.busy = true; draw(); try { await fn(); } catch (e) { say('STOPPED: ' + e.message); } W.busy = false; draw(); }
  function draw() { const el = document.getElementById('wk_steps'); if (!el) return; el.querySelectorAll('button').forEach(b => b.disabled = W.busy); const s = document.getElementById('wk_stat'); if (s) s.innerHTML = Object.entries(W.stat).map(([k, v]) => `<b>${esc2(k)}</b>: ${esc2(v)}`).join(' · '); }
  window.vWeekly = async function () {
    W.list = W.list || ('carolinas-' + nextMonday());
    $('view').innerHTML = `<div class="card"><h3 style="margin:0 0 6px">Build the weekly list</h3>
      <div class="small muted">Your rules: infill lots in a builder buy box · real comp within ½ mile or no letter · comp $50K+ (fee $10K+) · $100K+ comps first · not bought in the last 2 years · no waterfront · not on the MLS (active, coming soon or under contract) · no commercial zoning · offer 70% of comp · one letter per owner · skips anyone already worked, tagged, opted out or mailed in the last 90 days. Keep this tab open while a step runs.</div>
      <div style="margin:10px 0"><label class="small">List name <input id="wk_list" value="${esc2(W.list)}" style="width:230px"></label> <span class="small muted">(lots land in Spot Check under this name)</span></div>
      <div id="wk_steps">
      <div class="card" style="margin:8px 0"><b>1. Pull and check lots</b> <span class="small muted">county parcel maps → owner, size, shape, road frontage, flood, house and 2-year checks. About 10-40 minutes a county.</span><div style="margin:6px 0;display:flex;flex-wrap:wrap;gap:6px 12px">${W.counties.map(c => `<label class="small"><input type="checkbox" class="wk_c" value="${c}"> ${c}</label>`).join('')}</div><button class="btn sm" id="wk_pull">Pull checked counties</button></div>
      <div class="card" style="margin:8px 0"><b>2. Comps and offers</b> <span class="small muted">closest land sales within ½ mile, offer = 70%.</span><br><button class="btn sm" id="wk_comps">Run comps</button></div>
      <div class="card" style="margin:8px 0"><b>3. MLS check</b> <span class="small muted">In Canopy, search Lots/Acres/Farms in your counties with status Active, Coming Soon, Under Contract (Show and No Show). Check up to 2,500, Export → "Single Line Export". Do it twice if there are more than 2,500 (sort by price, export the top half, then the bottom half). Pick the file(s) here.</span><br><input type="file" id="wk_mlsf" accept=".csv" multiple> <button class="btn sm" id="wk_mls">Run MLS check</button></div>
      <div class="card" style="margin:8px 0"><b>4. Water and zoning</b> <span class="small muted">USGS water map; Charlotte, Cabarrus, Iredell and Gastonia zoning maps.</span><br><button class="btn sm" id="wk_wz">Run water + zoning</button></div>
      <div class="card" style="margin:8px 0"><b>5. Look it over</b> <span class="small muted">Spot Check → pick this list → "Every lot: table + Excel". Read the rows with a check note; Cut anything you don't want.</span><br><button class="btn sm ghost" id="wk_spot">Open Spot Check</button></div>
      <div class="card" style="margin:8px 0"><b>6. Mail list</b> <span class="small muted">Downloads an Excel (CSV) of every lot that will mail: one letter per owner, first and last name split, offer and comp. Send it to Paul and Brandon with the letter.</span><br><button class="btn sm" id="wk_mail">Download mail list</button></div>
      </div><div class="small" id="wk_stat" style="margin:6px 0"></div><pre id="wk_log" class="small" style="background:var(--bg);padding:8px;border-radius:8px;max-height:320px;overflow:auto;white-space:pre-wrap">${esc2(W.log.join('\n'))}</pre></div>`;
    const L = () => (W.list = $('wk_list').value.trim());
    $('wk_pull').onclick = () => { const cs = [...document.querySelectorAll('.wk_c:checked')].map(x => x.value); if (!cs.length) return alert('Check at least one county.'); run('pull', async () => { for (const c of cs) { try { await W.county(c, L()); } catch (e) { say(c + ' STOPPED: ' + e.message); } } }); };
    $('wk_comps').onclick = () => run('comps', async () => { const cs = [...new Set((await rowsOf(L(), null, false, 'id,county')).map(r => r.county))]; await W.comps(L(), cs); });
    $('wk_mls').onclick = () => { const fs = [...$('wk_mlsf').files]; if (!fs.length) return alert('Pick the Canopy export file first.'); run('mls', () => W.mls(L(), fs)); };
    $('wk_wz').onclick = () => run('wz', () => W.waterZoning(L()));
    $('wk_spot').onclick = () => { if (window.SC) { SC.list = L(); SC.view = 'table'; } go('spot'); };
    $('wk_mail').onclick = () => run('mail', () => W.mailList(L()));
    draw(); };
})();
