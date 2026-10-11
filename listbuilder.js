// DLG weekly list builder: pulls fresh vacant lots straight from county parcel data around
// Damien's closed deals and builder buy boxes, keeps only buildable lots, removes anyone
// already worked in DLG HQ, and loads the result into a new mail campaign (neutral letter).
(function () {
const LB = window.LB = {};
LB.RULES = {
  size: 1000,             // records per weekly list
  radiusMi: [3, 6, 10],   // search rings around each closed deal, widened only if short
  minAcres: 0.14, maxAcres: 2.2,
  minAvgWidthFt: 50,      // every closed deal is 50 ft+ on average
  minCompact: 0.25,       // below this the parcel is a sliver
  minFrontageFt: 25,      // must touch a public road
  recentDays: 90,         // skip anyone mailed in the last 90 days
  template: 'DLG Neutral Builder Letter.docx',
};
// ---- county parcel sources ----
const NC = { oid: 'objectid', name: 'NC statewide parcels', url: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1',
  fields: 'parno,altparno,ownname,ownfrst,ownlast,mailadd,munit,mcity,mstate,mzip,siteadd,scity,szip,gisacres,improvval,struct,landval,parusedesc,legdecfull,cntyname,stcntyfips',
  countyWhere: c => `cntyname='${c.replace(/'/g, "''")}'`,
  vacantWhere: (a, b) => `(improvval=0 OR improvval IS NULL) AND (struct IS NULL OR struct<>'Y') AND gisacres>=${a} AND gisacres<=${b}`,
  map: a => ({ apn: a.parno, apn2: a.altparno, owner: a.ownname, first: a.ownfrst, last: a.ownlast, mail: [a.mailadd, a.munit].filter(Boolean).join(' '), mcity: a.mcity, mstate: a.mstate, mzip: a.mzip,
    site: a.siteadd, scity: a.scity, szip: a.szip, acres: a.gisacres, built: (a.improvval || 0) > 0 || a.struct === 'Y', use: a.parusedesc, legal: a.legdecfull, county: titleCase(a.cntyname || ''), state: 'NC', fips: a.stcntyfips }) };
const YORK = { oid: 'OBJECTID', name: 'York County SC parcels', url: 'https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Parcels/FeatureServer/0',
  fields: 'ParcelID,Owner1,Owner2,MailAddr1,MailAddr2,MailCity,MailState,MailZip,PropertyAddress,GISSizeAC,deededacres,AprBldgVal,BuildingCount,ImprovedStatus,LandUseDesc,LegalDescription',
  countyWhere: () => '1=1',
  vacantWhere: (a, b) => `(AprBldgVal=0 OR AprBldgVal IS NULL) AND (BuildingCount=0 OR BuildingCount IS NULL) AND GISSizeAC>=${a} AND GISSizeAC<=${b}`,
  map: a => ({ apn: a.ParcelID, owner: [a.Owner1, a.Owner2].filter(Boolean).join(' & '), mail: [a.MailAddr1, a.MailAddr2].filter(Boolean).join(' '), mcity: a.MailCity, mstate: a.MailState, mzip: a.MailZip,
    site: a.PropertyAddress, acres: a.GISSizeAC || a.deededacres, built: (a.AprBldgVal || 0) > 0 || (a.BuildingCount || 0) > 0, use: a.LandUseDesc, legal: a.LegalDescription, county: 'York', state: 'SC', fips: '45091' }) };
LB.source = (state, county) => state === 'NC' ? NC : (state === 'SC' && /^york$/i.test(county || '')) ? YORK : null;

// ---- helpers ----
function titleCase(s) { return String(s || '').toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()).replace(/\bLlc\b/g, 'LLC').replace(/\bInc\b/g, 'Inc').replace(/\bIi\b/g, 'II').replace(/\bIii\b/g, 'III'); }
const ENTITY = /\b(LLC|L L C|INC|CORP|CORPORATION|COMPANY|CO\b|LP\b|LLP|TRUST|TRUSTEE|TRS|ESTATE|EST\b|HEIRS|BANK|PARTNERS|PARTNERSHIP|PROPERTIES|HOLDINGS|INVESTMENTS|ENTERPRISES|GROUP|CHURCH|MINISTR|FELLOWSHIP|ASSOCIATES)\b/i;
LB.names = function (r) {
  const raw = String(r.owner || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  if (ENTITY.test(raw)) return { owner: titleCase(raw), first: '', last: '', greeting: 'Property Owner' };
  let last = r.last, first = r.first;
  const m = raw.match(/^([^,]+),\s*(.+)$/);
  if (!last && m) { last = m[1]; first = m[2]; }
  if (!last) { const p = raw.split(/\s+/); last = p.length > 1 ? p[p.length - 1] : raw; first = p.length > 1 ? p.slice(0, -1).join(' ') : ''; }
  const firstOne = String(first || '').split(/\s*&\s*|\s+AND\s+/i)[0].trim().split(/\s+/)[0] || '';
  const ownerPretty = m ? titleCase(`${m[2]} ${m[1]}`) : titleCase(raw);
  return { owner: ownerPretty, first: titleCase(firstOne), last: titleCase(last), greeting: firstOne ? titleCase(firstOne) : 'Property Owner' };
};
const GOV = /\b(COUNTY OF|COUNTY\b.*\b(BOARD|COMMISSION)|CITY OF|TOWN OF|VILLAGE OF|STATE OF|UNITED STATES|USA\b|U S A|DEPT|DEPARTMENT|BOARD OF EDUCATION|SCHOOL|AUTHORITY|COMMISSION|HOMEOWNERS|HOME OWNERS|HOA\b|PROPERTY OWNERS|OWNERS ASS|ASSOCIATION|ASSN|POA\b|DUKE ENERGY|PROGRESS ENERGY|DOMINION ENERGY|ELECTRIC|MEMBERSHIP CORP|EMC\b|UTILIT|RAILROAD|RAILWAY|WATER (AND|&) SEWER|SANITARY DISTRICT|TELEPHONE|NCDOT|SCDOT|DEPARTMENT OF TRANSPORTATION|HOUSING AUTHORITY|CEMETERY|LAND TRUST|CONSERVANCY|NATURE CONSERVANCY)\b/i;
const REDFLAG = /EASEMENT|DRIVEWAY|DRIVE WAY|R\/W\b|RIGHT[- ]OF[- ]WAY|\bROW\b|COMMON AREA|COMMON PROP|COMMON OPEN|OPEN SPACE|BUFFER|\bSTRIP\b|REMNANT|DRAINAGE|DETENTION|RETENTION|\bPOND\b|UTILITY|CEMETERY|LANDLOCK|LAND LOCK|NO ACCESS|UNBUILDABLE|NON[- ]BUILDABLE|NOT BUILDABLE|SLIVER|\bGAP\b|AMENITY|RECREATION AREA|CONSERVATION|WETLAND|SEWER|PUMP STATION|LIFT STATION|TOWER SITE|CELL TOWER|SUBSTATION/i;
// tags/status in DLG HQ that mean: do not mail
const NEGTAG = /due diligence|\bdd\b|run claude dd|dd done|not sell|overpriced|paid too much|listed|bad lot|\bsold\b|\bdnc\b|do not (mail|call|contact)|opted|opt out|not interested|not_interested|stop|wrong (owner|person)|deceased|hostile/i;

const F = 3.28084;
function proj(lat0) { const c = Math.cos(lat0 * Math.PI / 180); return ([x, y]) => [x * 111320 * c * F, y * 110540 * F]; }
function mainRing(rings) { return rings.reduce((a, b) => (b.length > a.length ? b : a)); }
LB.shape = function (rings) {
  const ring = mainRing(rings), T = proj(ring[0][1]), P = ring.map(T);
  let A = 0, per = 0; for (let i = 0; i < P.length - 1; i++) { A += P[i][0] * P[i + 1][1] - P[i + 1][0] * P[i][1]; per += Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); }
  A = Math.abs(A) / 2; let best = { w: 1e12, l: 0 };
  for (let i = 0; i < P.length - 1; i++) { const dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], L = Math.hypot(dx, dy); if (L < 1) continue; const ux = dx / L, uy = dy / L;
    let a1 = 1e18, a2 = -1e18, b1 = 1e18, b2 = -1e18; for (const [x, y] of P) { const a = x * ux + y * uy, b = -x * uy + y * ux; if (a < a1) a1 = a; if (a > a2) a2 = a; if (b < b1) b1 = b; if (b > b2) b2 = b; }
    const w = Math.min(a2 - a1, b2 - b1), l = Math.max(a2 - a1, b2 - b1); if (w < best.w) best = { w, l }; }
  return { sqft: A, length: Math.round(best.l), avgWidth: Math.round(A / Math.max(best.l, 1)), compact: per ? 4 * Math.PI * A / per / per : 0 };
};
function centroid(rings) { const r = mainRing(rings); let x = 0, y = 0; r.forEach(p => { x += p[0]; y += p[1]; }); return [x / r.length, y / r.length]; }
function inRing(pt, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c; } return c; }
function inPoly(pt, rings) { let c = false; for (const r of rings) if (inRing(pt, r)) c = !c; return c; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, opt, tries = 3) {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(url, opt); const t = await r.text(); if (t[0] === '{' || t[0] === '[') { const j = JSON.parse(t); if (!j.error) return j; if (i === tries - 1) throw new Error(j.error.message || 'error'); } else if (i === tries - 1) throw new Error('HTTP ' + r.status); } catch (e) { if (i === tries - 1) throw e; } await sleep(1500 * (i + 1)); }
}
const miles = (a, b) => { const R = 3958.8, dLa = (b[0] - a[0]) * Math.PI / 180, dLo = (b[1] - a[1]) * Math.PI / 180, s = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };

// ---- roads + flood, fetched once per ~1.4 mile tile ----
const TILE = 0.02, roadCache = new Map(), floodCache = new Map();
const tileKey = (lng, lat) => Math.floor(lng / TILE) + ':' + Math.floor(lat / TILE);
// the free road map allows only a couple of requests at a time: queue them, space them out, retry
let opQueue = Promise.resolve();
function overpass(q) {
  const run = async () => {
    const hosts = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
    for (let a = 0; a < 6; a++) { const host = hosts[a % hosts.length];
      try { const r = await fetch(host + '?data=' + encodeURIComponent(q)); const t = await r.text(); if (t[0] === '{') { await sleep(400); return JSON.parse(t); } } catch (e) {}
      await sleep(2500 * (a + 1)); }
    return null; };
  const p = opQueue.then(run); opQueue = p.catch(() => null); return p;
}
async function tileRoads(k) {
  if (roadCache.has(k)) return roadCache.get(k);
  const p = (async () => { const [tx, ty] = k.split(':').map(Number), pad = 0.003, w = tx * TILE - pad, s = ty * TILE - pad, e = (tx + 1) * TILE + pad, n = (ty + 1) * TILE + pad;
    const q = `[out:json][timeout:90];way["highway"](${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)});out geom;`;
    const j = await overpass(q); if (!j) return null;
    const bad = /footway|path|cycleway|steps|pedestrian|bridleway|proposed|construction|track|corridor|platform|abandoned|raceway/;
    return j.elements.filter(x => x.geometry && !bad.test(x.tags.highway) && !/driveway|parking_aisle|drive-through/.test(x.tags.service || '') && x.tags.access !== 'private').map(x => x.geometry.map(p => [p.lon, p.lat])); })();
  roadCache.set(k, p); return p;
}
async function tileFlood(k) {
  if (floodCache.has(k)) return floodCache.get(k);
  const p = (async () => { const [tx, ty] = k.split(':').map(Number), w = tx * TILE, s = ty * TILE;
    const u = `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=${w},${s},${w + TILE},${s + TILE}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&where=SFHA_TF%3D'T'&outFields=FLD_ZONE&returnGeometry=true&outSR=4326&geometryPrecision=6&f=json`;
    try { const j = await getJSON(u); return (j.features || []).map(f => f.geometry.rings); } catch (e) { return null; } })();
  floodCache.set(k, p); return p;
}
LB.frontage = function (rings, roads) {
  const ring = mainRing(rings), T = proj(ring[0][1]);
  let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9; ring.forEach(([x, y]) => { if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; });
  const pd = 0.0006, segs = [];
  for (const g of roads) for (let i = 0; i < g.length - 1; i++) { const a = g[i], b = g[i + 1]; if (Math.max(a[0], b[0]) < mnx - pd || Math.min(a[0], b[0]) > mxx + pd || Math.max(a[1], b[1]) < mny - pd || Math.min(a[1], b[1]) > mxy + pd) continue; segs.push([T(a), T(b)]); }
  if (!segs.length) return 0;
  const dps = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
  const P = ring.map(T); let fr = 0;
  for (let i = 0; i < P.length - 1; i++) { const a = P[i], b = P[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / 5));
    for (let k = 0; k < n; k++) { const p = [a[0] + (b[0] - a[0]) * (k + .5) / n, a[1] + (b[1] - a[1]) * (k + .5) / n]; let best = 1e9; for (const s of segs) { const d = dps(p, s[0], s[1]); if (d < best) best = d; if (best < 35) break; } if (best < 35) fr += L / n; } }
  return Math.round(fr / 2); // both sides of a road strip count once
};
function floodShare(rings, flood) {
  const ring = mainRing(rings); const pts = [centroid(rings), ...ring.filter((_, i) => i % Math.max(1, Math.floor(ring.length / 12)) === 0)];
  let n = 0; for (const p of pts) if (flood.some(fr => inPoly(p, fr))) n++; return n / pts.length;
}

// ---- targets: closed deals + buy boxes ----
LB.targets = async function () {
  const { data: deals } = await sb.from('deals').select('id,property_label,properties(lat,lng,county,state)').eq('stage_id', 16).limit(1000);
  const pts = [], missing = new Set(), counties = new Map();
  (deals || []).forEach(d => { const p = d.properties || {}; if (!p.state || !p.county) return; const key = p.state + '|' + p.county;
    if (!LB.source(p.state, p.county)) { missing.add(`${p.county} County, ${p.state}`); return; }
    if (p.lat && p.lng) pts.push({ lat: p.lat, lng: p.lng, county: p.county, state: p.state, why: 'closed deal' });
    else counties.set(key, { county: p.county, state: p.state, why: 'closed deal (no map point)' }); });
  const { data: buyers } = await sb.from('buyers').select('id,name,company,counties,zips,min_acres,max_acres').limit(2000);
  (buyers || []).forEach(b => (b.counties || []).forEach(c => { const st = /^(york|lancaster|chester|charleston|berkeley|dorchester|horry|greenville|spartanburg)$/i.test(c) ? 'SC' : 'NC';
    if (!LB.source(st, c)) { missing.add(`${c} County, ${st}`); return; }
    const key = st + '|' + c; if (!counties.has(key)) counties.set(key, { county: c, state: st, why: 'buy box: ' + (b.company || b.name) }); }));
  return { pts, counties: [...counties.values()], missing: [...missing] };
};

// ---- pull parcels from the county ----
async function pullArea(src, where, geo, cap, log) {
  const out = []; let off = 0;
  while (out.length < cap) {
    const q = new URLSearchParams({ where, outFields: src.fields, returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', resultOffset: off, resultRecordCount: 2000, orderByFields: src.oid, f: 'json', ...(geo || {}) });
    let j; try { j = await getJSON(src.url + '/query', { method: 'POST', body: q }); } catch (e) { log('Could not reach ' + src.name + ': ' + e.message); break; }
    const fs = (j.features || []).filter(f => f.geometry && f.geometry.rings); out.push(...fs);
    if (!j.exceededTransferLimit || !(j.features || []).length) break; off += (j.features || []).length;
  }
  return out;
}

// ---- DLG HQ: who has already been worked ----
async function workedSet(cands, log) {
  const bad = new Map(); const apns = [...new Set(cands.flatMap(c => [c.r.apn, c.r.apn2].filter(Boolean).map(String)))];
  const since = new Date(Date.now() - LB.RULES.recentDays * 864e5).toISOString().slice(0, 10);
  for (let i = 0; i < apns.length; i += 150) {
    const chunk = apns.slice(i, i + 150);
    const { data: props } = await sb.from('properties').select('id,apn,county,tags,property_owners(lead_id,leads(id,status,tags,do_not_mail,not_interested_at))').in('apn', chunk);
    const pids = (props || []).map(p => p.id);
    const recent = new Set();
    if (pids.length) { const { data: rec } = await sb.from('campaign_records').select('property_id,campaigns(drop_date,created_at)').in('property_id', pids);
      (rec || []).forEach(r => { const d = r.campaigns?.drop_date || (r.campaigns?.created_at || '').slice(0, 10); if (d && d >= since) recent.add(r.property_id); }); }
    (props || []).forEach(p => {
      const why = recent.has(p.id) ? `mailed in the last ${LB.RULES.recentDays} days`
        : (p.tags || []).some(t => NEGTAG.test(t)) ? 'tagged on the property: ' + p.tags.find(t => NEGTAG.test(t))
        : (p.property_owners || []).map(o => o.leads).filter(Boolean).map(l => l.do_not_mail ? 'do not mail' : (l.tags || []).find(t => NEGTAG.test(t)) ? 'tagged: ' + (l.tags || []).find(t => NEGTAG.test(t)) : !['record', null, undefined].includes(l.status) ? 'already worked (' + String(l.status).replace('_', ' ') + ')' : null).find(Boolean);
      if (why) bad.set(String(p.apn) + '|' + String(p.county || '').toLowerCase(), why); });
  }
  return bad;
}

// ---- main ----
LB.run = async function (opt = {}) {
  const R = { ...LB.RULES, ...opt }, st = LB.status = { phase: 'starting', log: [], cut: {}, picked: 0, started: new Date().toISOString() };
  const log = m => { st.log.push(new Date().toLocaleTimeString() + '  ' + m); console.log('[LB]', m); };
  const cutAdd = (why) => { st.cut[why] = (st.cut[why] || 0) + 1; };
  try {
    st.phase = 'targets'; const T = opt.targets || await LB.targets();
    log(`Targets: ${T.pts.length} closed-deal spots, ${T.counties.length} buy-box/closed-deal counties.` + (T.missing.length ? ` No county data connected for: ${T.missing.join(', ')}.` : ''));
    st.missing = T.missing;
    const seen = new Set(), cands = [];
    const addFeat = (src, f, why) => { const r = src.map(f.attributes); const k = r.state + '|' + r.apn; if (!r.apn || seen.has(k)) return; seen.add(k);
      const c = centroid(f.geometry.rings); const d = T.pts.length ? Math.min(...T.pts.map(p => miles([p.lat, p.lng], [c[1], c[0]]))) : 99; cands.push({ r, rings: f.geometry.rings, c, dist: d, why }); };
    st.phase = 'pulling county data';
    for (const ring of R.radiusMi) {
      for (const p of T.pts) { const src = LB.source(p.state, p.county);
        const fs = await pullArea(src, src.vacantWhere(R.minAcres, R.maxAcres), { geometry: `${p.lng},${p.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', distance: ring, units: 'esriSRUnit_StatuteMile' }, 6000, log);
        fs.forEach(f => addFeat(src, f, p.why)); }
      log(`Within ${ring} miles of closed deals: ${cands.length.toLocaleString()} vacant lots in the size range.`);
      if (cands.length >= R.size * 4) break;
    }
    for (const c of T.counties) { if (cands.length >= R.size * 8) break; const src = LB.source(c.state, c.county);
      const fs = await pullArea(src, src.countyWhere(c.county) + ' AND ' + src.vacantWhere(R.minAcres, R.maxAcres), null, 3000, log); fs.forEach(f => addFeat(src, f, c.why));
      log(`${c.county} County ${c.state} (${c.why}): ${fs.length.toLocaleString()} lots pulled.`); }
    cands.sort((a, b) => a.dist - b.dist);
    st.pool = cands.length;
    // fast checks first
    st.phase = 'checking lots'; const pass1 = [];
    for (const c of cands) { const r = c.r, nm = LB.names(r);
      if (!nm || !r.mail || !r.mcity || !r.mstate || !r.mzip) { cutAdd('no mailing address'); continue; }
      if (r.built) { cutAdd('has a building'); continue; }
      if (GOV.test(r.owner || '')) { cutAdd('government / HOA / utility owner'); continue; }
      const flag = (String(r.legal || '') + ' ' + String(r.use || '')).match(REDFLAG); if (flag) { cutAdd('red flag in records: ' + flag[0].toLowerCase()); continue; }
      const sh = LB.shape(c.rings); c.sh = sh; const ac = sh.sqft / 43560;
      if (ac < R.minAcres * 0.85 || ac > R.maxAcres * 1.15) { cutAdd('mapped size out of range'); continue; }
      if (sh.avgWidth < R.minAvgWidthFt) { cutAdd('too narrow (under ' + R.minAvgWidthFt + ' ft wide)'); continue; }
      if (sh.compact < R.minCompact) { cutAdd('sliver / odd shape'); continue; }
      c.nm = nm; pass1.push(c); }
    log(`${pass1.length.toLocaleString()} lots passed size, width, shape, owner and red-flag checks.`);
    // DLG HQ check
    st.phase = 'checking DLG HQ'; const worked = await workedSet(pass1, log); const pass2 = [];
    for (const c of pass1) { const w = worked.get(String(c.r.apn) + '|' + c.r.county.toLowerCase()) || (c.r.apn2 && worked.get(String(c.r.apn2) + '|' + c.r.county.toLowerCase())); if (w) { cutAdd(w.startsWith('tagged') ? 'tagged in DLG HQ (DD or negative)' : w.startsWith('mailed') ? w : 'already worked in DLG HQ'); continue; } pass2.push(c); }
    log(`${pass2.length.toLocaleString()} left after removing people already worked, tagged or recently mailed.`);
    // road + flood (one lookup per tile)
    st.phase = 'checking roads and flood'; const final = []; let i = 0, noRoadData = 0;
    for (const c of pass2) { if (final.length >= R.size) break; i++;
      const k = tileKey(c.c[0], c.c[1]); const [roads, flood] = await Promise.all([tileRoads(k), tileFlood(k)]);
      if (flood === null) { cutAdd('flood map unavailable (skipped to be safe)'); continue; }
      if (flood.length && floodShare(c.rings, flood) >= 0.25) { cutAdd('in a FEMA flood zone'); continue; }
      if (roads === null) { noRoadData++; cutAdd('road map unavailable (skipped to be safe)'); continue; }
      const fr = LB.frontage(c.rings, roads); c.front = fr;
      if (fr < R.minFrontageFt) { cutAdd('no road frontage'); continue; }
      final.push(c); st.picked = final.length; if (i % 50 === 0) log(`Checked ${i} lots for road and flood, ${final.length} picked.`); }
    st.final = final;
    log(`Picked ${final.length.toLocaleString()} lots.` + (final.length < R.size ? ` Short of ${R.size}: widen the area or connect more county data.` : ''));
    return st;
  } catch (e) { st.error = e.message; log('Stopped: ' + e.message); throw e; } finally { st.phase = st.error ? 'error' : 'checked'; }
};

// ---- load into a DLG HQ campaign ----
LB.toCampaign = async function (name, opt = {}) {
  const st = LB.status, R = { ...LB.RULES, ...opt }; if (!st || !st.final) throw new Error('Run the list first');
  const drop = opt.drop || (() => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d.toISOString().slice(0, 10); })();
  const { data: camp, error } = await sb.from('campaigns').insert({ name, channel: 'mail', drop_date: drop, template: R.template, source: 'hq' }).select().single(); if (error) throw error;
  const rows = st.final.map(c => { const r = c.r, n = c.nm; return { full_name: n.owner, first_name: n.first || null, last_name: n.last || null, mail_address: titleCase(r.mail), mail_city: titleCase(r.mcity), mail_state: String(r.mstate || '').toUpperCase(), mail_zip: String(r.mzip || '').slice(0, 10),
    apn: String(r.apn), address: r.site ? titleCase(r.site) : null, city: r.scity ? titleCase(r.scity) : null, state: r.state, zip: r.szip || null, county: r.county, acres: +(c.sh.sqft / 43560).toFixed(3), lat: c.c[1], lng: c.c[0] }; });
  let rec = 0; const res = [];
  for (let i = 0; i < rows.length; i += 100) { const { data, error } = await sb.rpc('import_campaign_list', { cid: camp.id, rows: rows.slice(i, i + 100), src: 'county', tag: 'Weekly List', skip_dnm: true, skip_ni: true, skip_days: R.recentDays }); if (error) throw error; res.push(data); rec += data.records; st.loaded = rec; }
  await sb.rpc('finish_campaign_import', { cid: camp.id });
  // stamp FIPS, check results and the buildable tag on each property
  const byKey = new Map(st.final.map(c => [String(c.r.apn) + '|' + c.r.county.toLowerCase(), c]));
  for (let from = 0; ; from += 1000) { const { data } = await sb.from('campaign_records').select('property_id,properties(id,apn,county,fields)').eq('campaign_id', camp.id).range(from, from + 999); if (!data || !data.length) break;
    for (let i = 0; i < data.length; i += 25) await Promise.all(data.slice(i, i + 25).map(x => { const p = x.properties; if (!p) return; const c = byKey.get(String(p.apn) + '|' + String(p.county || '').toLowerCase()); if (!c) return;
      return sb.from('properties').update({ fips: c.r.fips || null, fields: { ...(p.fields || {}), buildable: { checked: new Date().toISOString().slice(0, 10), avg_width_ft: c.sh.avgWidth, length_ft: c.sh.length, road_frontage_ft: c.front, flood: 'not in SFHA', source: LB.source(c.r.state, c.r.county).name } } }).eq('id', p.id); }));
    if (data.length < 1000) break; }
  const skipped = res.reduce((a, d) => a + d.skipped_dnm + d.skipped_not_interested + d.skipped_recent, 0);
  st.campaign = camp.id; st.report = LB.report(st, rec, skipped);
  await sb.from('activity').insert({ kind: 'note', body: 'Weekly list built: ' + st.report });
  return { campaign: camp.id, records: rec, skipped };
};
LB.report = function (st, rec, skipped) {
  const cutN = Object.values(st.cut).reduce((a, b) => a + b, 0) + (skipped || 0);
  const lines = Object.entries(st.cut).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v.toLocaleString()} ${k}`);
  if (skipped) lines.push(`${skipped} removed at import (do-not-mail, said no, or mailed recently)`);
  return `${rec.toLocaleString()} records picked from ${Number(st.pool || 0).toLocaleString()} vacant lots. ${cutN.toLocaleString()} cut, about ${(cutN * 0.55).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} in postage not spent: ${lines.join('; ')}.` + (st.missing && st.missing.length ? ` Pull county data for: ${st.missing.join(', ')}.` : '');
};
})();
