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
  maxTouchesPerYear: 3,   // 3 letters in 12 months, then they rest until a year has passed
  costPerPiece: 0.55,     // postage + print per letter
  rampSize: 500, rampUntil: '2026-10-01', // ramp finished: full 1,000 a week (Damien, Oct 11)
  countyCapPct: 0.30,     // no county gets more than 30% of a list
  churchShare: 0.10,      // church-owned lots: Mecklenburg only, at most 10% of a list
  marketShare: 0.40,      // water & sewer markets get 2 of every 5 picks (Mecklenburg church lots first)
  maxSlopePct: 10,       // average ground slope across the lot (NC 3-ft LiDAR); infill builders grade to ~2%
  minLandValue: 15000,
  // water & sewer markets (Damien, Oct 2026): pulled every week; only lots inside a public sewer area are mailed here
  sewerMarkets: [
    { county: 'Mecklenburg', state: 'NC' },
    { county: 'Gaston', state: 'NC', zips: ['28052', '28054', '28056', '28120', '28098'] }, // Gastonia, Mount Holly, Lowell
    { county: 'Iredell', state: 'NC', zips: ['28625', '28677', '28115', '28117'] },         // Statesville, Mooresville
    { county: 'Lincoln', state: 'NC', zips: ['28037', '28092'] },                          // Denver, Lincolnton
    { county: 'Rowan', state: 'NC', zips: ['28144', '28146', '28147'] },                   // Salisbury
  ],    // county land value floor (lots with no value on file are kept)
  template: 'DLG Letter 1 - Blessings.docx',
  // split test: every list is cut into random halves (even by county), one campaign per letter
  letters: [{ label: 'Letter 1', template: 'DLG Letter 1 - Blessings.docx' }, { label: 'Letter 2', template: 'DLG Letter 2 - Blessings.docx' }],
  targetStages: [10, 11, 12, 13, 14, 15, 16], // under contract / escrow + closed
  skipCounties: ['Oconee, SC', 'Charleston, SC', 'Lee, FL'], // not mailing these (Damien, Oct 2026)
};
// ---- county parcel sources ----
const NC = { oid: 'objectid', name: 'NC statewide parcels', url: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1',
  fields: 'parno,altparno,ownname,ownfrst,ownlast,mailadd,munit,mcity,mstate,mzip,siteadd,scity,szip,gisacres,improvval,struct,landval,parusedesc,legdecfull,cntyname,stcntyfips',
  countyWhere: c => `cntyname='${c.replace(/'/g, "''")}'`,
  vacantWhere: (a, b) => `(improvval=0 OR improvval IS NULL) AND (struct IS NULL OR struct<>'Y') AND gisacres>=${a} AND gisacres<=${b}`,
  map: a => ({ landval: a.landval, apn: a.parno, apn2: a.altparno, owner: a.ownname, first: a.ownfrst, last: a.ownlast, mail: [a.mailadd, a.munit].filter(Boolean).join(' '), mcity: a.mcity, mstate: a.mstate, mzip: a.mzip,
    site: a.siteadd, scity: a.scity, szip: a.szip, acres: a.gisacres, built: (a.improvval || 0) > 0 || a.struct === 'Y', use: a.parusedesc, legal: a.legdecfull, county: titleCase(a.cntyname || ''), state: 'NC', fips: a.stcntyfips }) };
const YORK = { oid: 'OBJECTID', name: 'York County SC parcels', url: 'https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Parcels/FeatureServer/0',
  fields: 'ParcelID,AprLandVal,Owner1,Owner2,MailAddr1,MailAddr2,MailCity,MailState,MailZip,PropertyAddress,GISSizeAC,deededacres,AprBldgVal,BuildingCount,ImprovedStatus,LandUseDesc,LegalDescription',
  countyWhere: () => '1=1',
  vacantWhere: (a, b) => `(AprBldgVal=0 OR AprBldgVal IS NULL) AND (BuildingCount=0 OR BuildingCount IS NULL) AND GISSizeAC>=${a} AND GISSizeAC<=${b}`,
  map: a => ({ landval: a.AprLandVal, apn: a.ParcelID, owner: [a.Owner1, a.Owner2].filter(Boolean).join(' & '), mail: [a.MailAddr1, a.MailAddr2].filter(Boolean).join(' '), mcity: a.MailCity, mstate: a.MailState, mzip: a.MailZip,
    site: a.PropertyAddress, acres: a.GISSizeAC || a.deededacres, built: (a.AprBldgVal || 0) > 0 || (a.BuildingCount || 0) > 0, use: a.LandUseDesc, legal: a.LegalDescription, county: 'York', state: 'SC', fips: '45091' }) };
LB._tileRoads = (...a) => tileRoads(...a); LB._tileFlood = (...a) => tileFlood(...a);
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
const BUILDER = /\b(BUILDERS?|BUILDING|CONSTRUCTION|HOMES|HOMEBUILDERS?|DEVELOPMENT|DEVELOPERS?|DEVELOP|COMMUNITIES|RESIDENTIAL|REALTY|LAND CO|LAND COMPANY|LAND GROUP|LAND HOLDINGS|LOTS|SUBDIVISION|NVR|PULTE|LENNAR|D R HORTON|DR HORTON|MERITAGE|TAYLOR MORRISON|TRUE HOMES|MATTAMY|EASTWOOD|CENTURY COMMUNITIES|DREAM FINDERS|SMITH DOUGLAS|STANLEY MARTIN|DAN RYAN|MUNGO|ADAMS HOMES|LGI)\b/i;
const CHURCH = /\b(CHURCH(?! (ST|STREET|RD|ROAD|AVE|LN|DR)\b)|MINISTR|FELLOWSHIP|TABERNACLE|CONGREGATION|BAPTIST|METHODIST|PRESBYTERIAN|EPISCOPAL|LUTHERAN|PENTECOSTAL|HOLINESS|AME ZION|DIOCESE|CATHOLIC|HOUSE OF PRAYER)/i;
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
  for (let i = 0; i < tries; i++) { try { const r = await fetch(url, { ...(opt || {}), signal: AbortSignal.timeout(45000) }); const t = await r.text(); if (t[0] === '{' || t[0] === '[') { const j = JSON.parse(t); if (!j.error) return j; if (i === tries - 1) throw new Error(j.error.message || 'error'); } else if (i === tries - 1) throw new Error('HTTP ' + r.status); } catch (e) { if (i === tries - 1) throw e; } await sleep(1500 * (i + 1)); }
}
const miles = (a, b) => { const R = 3958.8, dLa = (b[0] - a[0]) * Math.PI / 180, dLo = (b[1] - a[1]) * Math.PI / 180, s = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };

// ---- roads + flood, fetched once per ~1.4 mile tile ----
const TILE = 0.01, roadCache = new Map(), floodCache = new Map();
const tileKey = (lng, lat) => Math.floor(lng / TILE) + ':' + Math.floor(lat / TILE);
// the free road map allows only a couple of requests at a time: queue them, space them out, retry
let opQueue = Promise.resolve();
function overpass(q) {
  const run = async () => {
    const hosts = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
    for (let a = 0; a < 6; a++) { const host = hosts[a % hosts.length];
      try { const r = await fetch(host + '?data=' + encodeURIComponent(q), { signal: AbortSignal.timeout(30000) }); const t = await r.text(); if (t[0] === '{') { await sleep(300); return JSON.parse(t); } } catch (e) {}
      await sleep(2000 * (a + 1)); }
    return null; };
  const p = opQueue.then(run); opQueue = p.catch(() => null); return p;
}
async function tileRoads(k) {
  if (roadCache.has(k)) return roadCache.get(k);
  // US Census TIGER roads: public roads only (primary, secondary, local, frontage roads); private drives, alleys and trails excluded
  const p = (async () => { const [tx, ty] = k.split(':').map(Number), pad = 0.002, w = tx * TILE - pad, s = ty * TILE - pad, e = (tx + 1) * TILE + pad, n = (ty + 1) * TILE + pad;
    const base = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/';
    const q = `/query?geometry=${w},${s},${e},${n}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&where=MTFCC+IN+('S1100','S1200','S1400','S1640')&outFields=MTFCC&returnGeometry=true&outSR=4326&geometryPrecision=6&f=json`;
    try { const js = await Promise.all([2, 6, 8].map(l => getJSON(base + l + q)));
      return js.flatMap(j => (j.features || []).flatMap(f => (f.geometry && f.geometry.paths) || [])); } catch (e) { return null; } })();
  roadCache.set(k, p); return p;
}
async function tileFlood(k) {
  if (floodCache.has(k)) return floodCache.get(k);
  const p = (async () => { const [tx, ty] = k.split(':').map(Number), w = tx * TILE, s = ty * TILE;
    const u = `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=${w},${s},${w + TILE},${s + TILE}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&where=SFHA_TF%3D'T'&outFields=FLD_ZONE&returnGeometry=true&outSR=4326&geometryPrecision=6&f=json`;
    try { const j = await getJSON(u); return (j.features || []).map(f => f.geometry.rings); } catch (e) { return null; } })();
  floodCache.set(k, p); return p;
}
const sewerCache = new Map();
async function tileSewer(k) { // NC public sewer service areas (state map, 2004): a hint, not a filter
  if (sewerCache.has(k)) return sewerCache.get(k);
  const p = (async () => { const [tx, ty] = k.split(':').map(Number), w = tx * TILE, s = ty * TILE;
    const u = `https://services.nconemap.gov/secure/rest/services/NC1Map_Water_Sewer_2004/MapServer/2/query?geometry=${w},${s},${w + TILE},${s + TILE}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=sssyname&returnGeometry=true&outSR=4326&geometryPrecision=5&f=json`;
    try { const j = await getJSON(u, undefined, 2); return (j.features || []).map(f => f.geometry.rings); } catch (e) { return null; } })();
  sewerCache.set(k, p); return p;
}
// ---- slope from NC statewide LiDAR ground elevation (3 ft grid) ----
const DEM = 'https://services.nconemap.gov/secure/rest/services/Elevation/DEM03/ImageServer/getSamples';
function gridPoints(rings) { const ring = mainRing(rings); let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9; ring.forEach(([x, y]) => { if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; });
  const pts = []; for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) { const pt = [mnx + (mxx - mnx) * i / 6, mny + (mxy - mny) * j / 6]; if (inRing(pt, ring)) pts.push(pt); }
  if (pts.length < 4) { pts.push(centroid(rings)); ring.filter((_, i) => i % Math.max(1, Math.floor(ring.length / 6)) === 0).forEach(p => pts.push([(p[0] * 3 + centroid(rings)[0]) / 4, (p[1] * 3 + centroid(rings)[1]) / 4])); }
  return pts.slice(0, 25); }
function planeSlope(pts, z, lat0) { const T = proj(lat0); const P = pts.map(T); const n = P.length; if (n < 3) return null;
  const mx = P.reduce((a, p) => a + p[0], 0) / n, my = P.reduce((a, p) => a + p[1], 0) / n, mz = z.reduce((a, v) => a + v, 0) / n;
  let sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0; for (let i = 0; i < n; i++) { const dx = P[i][0] - mx, dy = P[i][1] - my, dz = z[i] - mz; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; sxz += dx * dz; syz += dy * dz; }
  const det = sxx * syy - sxy * sxy; if (Math.abs(det) < 1e-9) return null; const a = (sxz * syy - syz * sxy) / det, b = (syz * sxx - sxz * sxy) / det;
  return { pct: Math.round(100 * Math.hypot(a, b) * 10) / 10, relief: Math.round(Math.max(...z) - Math.min(...z)) }; }
LB.slopes = async function (cands) { // fills c.slope for NC lots, 15 lots per request, 4 requests at a time
  const nc = cands.filter(c => c.r.state === 'NC' && c.slope === undefined); const groups = []; for (let i = 0; i < nc.length; i += 15) groups.push(nc.slice(i, i + 15));
  const one = async g => { const all = [], own = []; g.forEach((c, k) => { const pts = gridPoints(c.rings); c._pts = pts; pts.forEach(p => { all.push(p); own.push(k); }); });
    try { const body = new URLSearchParams({ geometry: JSON.stringify({ points: all, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryMultipoint', returnFirstValueOnly: 'true', f: 'json' });
      const j = await getJSON(DEM, { method: 'POST', body }, 2); const z = new Array(all.length).fill(null); (j.samples || []).forEach(sm => { const v = parseFloat(sm.value); if (isFinite(v) && v > -100) z[sm.locationId] = v; });
      g.forEach((c, k) => { const idx = own.map((o, i) => o === k ? i : -1).filter(i => i >= 0 && z[i] !== null); c.slope = idx.length >= 3 ? planeSlope(idx.map(i => all[i]), idx.map(i => z[i]), c.c[1]) : null; });
    } catch (e) { g.forEach(c => { c.slope = null; }); } };
  for (let i = 0; i < groups.length; i += 4) await Promise.all(groups.slice(i, i + 4).map(one));
};
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
  // closed deals plus everything under contract / in escrow (New Inventory through Take Down)
  const { data: deals } = await sb.from('deals').select('id,stage_id,status,property_label,properties(lat,lng,county,state)').in('stage_id', LB.RULES.targetStages).limit(2000);
  const pts = [], missing = new Set(), counties = new Map();
  (deals || []).forEach(d => { const p = d.properties || {}; if (!p.state || !p.county) return; const key = p.state + '|' + p.county;
    if (d.stage_id !== 16 && ['lost', 'dead'].includes(d.status)) return;
    if (LB.RULES.skipCounties.some(c => c.toLowerCase() === (p.county + ', ' + p.state).toLowerCase())) return;
    d.why = d.stage_id === 16 ? 'closed deal' : 'under contract / escrow';
    if (!LB.source(p.state, p.county)) { missing.add(`${p.county} County, ${p.state}`); return; }
    if (p.lat && p.lng) pts.push({ lat: p.lat, lng: p.lng, county: p.county, state: p.state, why: d.why });
    else counties.set(key, { county: p.county, state: p.state, why: d.why + ' (no map point)' }); });
  const { data: buyers } = await sb.from('buyers').select('id,name,company,counties,zips,min_acres,max_acres').limit(2000);
  (buyers || []).forEach(b => (b.counties || []).forEach(c => { const st0 = /^(york|lancaster|chester|charleston|berkeley|dorchester|horry|greenville|spartanburg)$/i.test(c) ? 'SC' : 'NC'; if (LB.RULES.skipCounties.some(x => x.toLowerCase() === (c + ', ' + st0).toLowerCase())) return; const st = /^(york|lancaster|chester|charleston|berkeley|dorchester|horry|greenville|spartanburg)$/i.test(c) ? 'SC' : 'NC';
    if (!LB.source(st, c)) { missing.add(`${c} County, ${st}`); return; }
    const key = st + '|' + c; if (!counties.has(key)) counties.set(key, { county: c, state: st, why: 'buy box: ' + (b.company || b.name) }); }));
  return { pts, counties: [...counties.values()], missing: [...missing] };
};

// ---- ZIP code outlines (US Census ZCTA) ----
async function zipRings(zip) { try { const j = await getJSON(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query?where=ZCTA5%3D'${zip}'&outFields=ZCTA5&returnGeometry=true&outSR=4326&geometryPrecision=5&f=json`); const f = (j.features || [])[0]; return f ? f.geometry.rings : null; } catch (e) { return null; } }
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
    const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10), touches = new Map();
    if (pids.length) { const { data: rec } = await sb.from('campaign_records').select('property_id,campaigns(drop_date,created_at,mail_status)').in('property_id', pids);
      (rec || []).forEach(r => { if (!r.campaigns || r.campaigns.mail_status === 'not_sent') return; // only letters that actually went out
        const d = r.campaigns.drop_date || (r.campaigns.created_at || '').slice(0, 10); if (d && d >= since) recent.add(r.property_id);
        if (d && d >= yearAgo) touches.set(r.property_id, (touches.get(r.property_id) || 0) + 1); }); }
    (props || []).forEach(p => {
      const why = recent.has(p.id) ? `mailed in the last ${LB.RULES.recentDays} days`
        : (touches.get(p.id) || 0) >= LB.RULES.maxTouchesPerYear ? 'resting: mailed ' + LB.RULES.maxTouchesPerYear + ' times this year'
        : (p.tags || []).some(t => NEGTAG.test(t)) ? 'tagged on the property: ' + p.tags.find(t => NEGTAG.test(t))
        : (p.property_owners || []).map(o => o.leads).filter(Boolean).map(l => l.do_not_mail ? 'do not mail' : (l.tags || []).find(t => NEGTAG.test(t)) ? 'tagged: ' + (l.tags || []).find(t => NEGTAG.test(t)) : !['record', null, undefined].includes(l.status) ? 'already worked (' + String(l.status).replace('_', ' ') + ')' : null).find(Boolean);
      if (why) bad.set(String(p.apn) + '|' + String(p.county || '').toLowerCase(), why); });
  }
  return bad;
}

// ---- owner-level checks (by mailing address), so one owner's "no" or recent letter covers all their lots ----
const normAddr = (a, z) => String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '') + String(z || '').replace(/\D/g, '').slice(0, 5);
LB.ownerBlocks = async function (days, log) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10), yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const block = new Map(); const touches = new Map();
  // 1) letters that went to the mail house: last 90 days = skip; 3+ in 12 months = resting
  const { data: camps } = await sb.from('campaigns').select('id,mail_status,drop_date').gte('drop_date', yearAgo).neq('mail_status', 'not_sent').limit(1000);
  for (const c of camps || []) for (let o = 0; ; o += 1000) { const { data } = await sb.from('campaign_records').select('leads(mail_address,mail_zip)').eq('campaign_id', c.id).range(o, o + 999);
    (data || []).forEach(x => { const k = normAddr(x.leads?.mail_address, x.leads?.mail_zip); if (k.length <= 8) return; touches.set(k, (touches.get(k) || 0) + 1); if (c.drop_date >= since && !block.has(k)) block.set(k, 'same owner mailed in the last ' + days + ' days'); });
    if (!data || data.length < 1000) break; }
  touches.forEach((n, k) => { if (n >= LB.RULES.maxTouchesPerYear && !block.has(k)) block.set(k, 'resting: owner mailed ' + LB.RULES.maxTouchesPerYear + ' times this year'); });
  // 2) contacts who responded, said no, are in due diligence, or are do-not-mail
  const add = (l, why) => { const k = normAddr(l.mail_address, l.mail_zip); if (k.length > 8 && !block.has(k)) block.set(k, why); };
  for (let o = 0; ; o += 1000) { const { data } = await sb.from('leads').select('mail_address,mail_zip,status').neq('status', 'record').range(o, o + 999); (data || []).forEach(l => add(l, 'owner already worked in DLG HQ')); if (!data || data.length < 1000) break; }
  for (let o = 0; ; o += 1000) { const { data } = await sb.from('leads').select('mail_address,mail_zip').eq('do_not_mail', true).range(o, o + 999); (data || []).forEach(l => add(l, 'owner is do-not-mail')); if (!data || data.length < 1000) break; }
  for (let o = 0; ; o += 1000) { const { data } = await sb.from('leads').select('mail_address,mail_zip,tags').not('tags', 'eq', '{}').range(o, o + 999); (data || []).forEach(l => { if ((l.tags || []).some(t => NEGTAG.test(t))) add(l, 'owner tagged in DLG HQ (DD or negative)'); }); if (!data || data.length < 1000) break; }
  log && log(`${block.size.toLocaleString()} owners blocked by mailing address (recent letters, resting, responded, tagged or do-not-mail).`);
  return block;
};
LB.suppressedApns = async function () { const set = new Set(); for (let o = 0; ; o += 1000) { const { data } = await sb.from('suppression').select('apn').not('apn', 'is', null).range(o, o + 999); (data || []).forEach(x => set.add(String(x.apn))); if (!data || data.length < 1000) break; } return set; };
// ---- main ----
LB.run = async function (opt = {}) {
  const R = { ...LB.RULES, ...opt };
  if (!opt.noRamp && R.rampUntil && new Date() < new Date(R.rampUntil + 'T00:00:00') && R.size > R.rampSize) R.size = R.rampSize;
  const st = LB.status = { phase: 'starting', log: [], cut: {}, held: 0, picked: 0, size: R.size, started: new Date().toISOString() };
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
      if (cands.length >= R.size * 8) break;
    }
    for (const c of T.counties) { if (cands.length >= R.size * 8) break; const src = LB.source(c.state, c.county);
      const fs = await pullArea(src, src.countyWhere(c.county) + ' AND ' + src.vacantWhere(R.minAcres, R.maxAcres), null, 3000, log); fs.forEach(f => addFeat(src, f, c.why));
      log(`${c.county} County ${c.state} (${c.why}): ${fs.length.toLocaleString()} lots pulled.`); }
    // water & sewer markets: always pulled; ranked alongside the closest ring so they get their share
    const marketKey = (c, st) => (st + '|' + c).toLowerCase(); st.markets = {};
    for (const m of (opt.targets ? [] : R.sewerMarkets)) { if (R.skipCounties.some(x => x.toLowerCase() === (m.county + ', ' + m.state).toLowerCase())) continue; const src = LB.source(m.state, m.county); if (!src) continue;
      let n = 0; const before = cands.length;
      if (m.zips && m.zips.length) {
        for (const z of m.zips) { const zr = await zipRings(z); if (!zr) { log('Could not load ZIP ' + z); continue; }
          let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9; zr.flat().forEach(([x, y]) => { if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; });
          const fs = await pullArea(src, src.countyWhere(m.county) + ' AND ' + src.vacantWhere(R.minAcres, R.maxAcres), { geometry: `${mnx},${mny},${mxx},${mxy}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' }, 4000, log);
          fs.forEach(f => { if (inPoly(centroid(f.geometry.rings), zr)) addFeat(src, f, 'water & sewer market (' + z + ')'); }); }
      } else { const fs = await pullArea(src, src.countyWhere(m.county) + ' AND ' + src.vacantWhere(R.minAcres, R.maxAcres), null, 6000, log); fs.forEach(f => addFeat(src, f, 'water & sewer market')); }
      for (let i = before; i < cands.length; i++) { cands[i].sewerMarket = true; cands[i].dist = Math.min(cands[i].dist, 1.5); }
      // lots already pulled from deal rings in a sewer market are held to the sewer rule too
      cands.forEach(c => { if (marketKey(c.r.county, c.r.state) === marketKey(m.county, m.state) && (!m.zips || c.sewerMarket)) c.sewerMarket = true; });
      n = cands.length - before; st.markets[m.county + (m.zips ? ' (' + m.zips.join(', ') + ')' : '')] = n; log(`${m.county} County water & sewer market: ${n.toLocaleString()} lots pulled.`); }
    // Gaston outside the listed ZIPs: only mail it if it came from a deal ring (not a sewer-market pull)
    cands.sort((a, b) => a.dist - b.dist);
    st.pool = cands.length;
    // fast checks first
    st.phase = 'checking lots'; const pass1 = [];
    const normOwner = o => String(o || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const ownerCount = new Map(); cands.forEach(c => { const k = normOwner(c.r.owner); if (k) ownerCount.set(k, (ownerCount.get(k) || 0) + 1); });
    const { data: buyers } = await sb.from('buyers').select('name,company').limit(5000);
    const buyerNames = new Set((buyers || []).flatMap(b => [b.company, b.name]).map(normOwner).filter(x => x && x.length > 4));
    for (const c of cands) { const r = c.r, nm = LB.names(r);
      if (c.dist < 0.03) { cutAdd('your own deal lot'); continue; }
      if (BUILDER.test(r.owner || '')) { cutAdd('builder / developer owner'); continue; }
      if (buyerNames.has(normOwner(r.owner))) { cutAdd('one of your buyers'); continue; }
      if (CHURCH.test(r.owner || '')) { if (!/^mecklenburg$/i.test(r.county)) { cutAdd('church lot outside Mecklenburg'); continue; } c.church = true; c.dist = 0; } // Mecklenburg church lots go to the front
      if (!c.church && (ownerCount.get(normOwner(r.owner)) || 0) >= 4) { cutAdd('owns 4+ lots nearby (developer inventory)'); continue; }
      if (!nm || !r.mail || !r.mcity || !r.mstate || !r.mzip) { cutAdd('no mailing address'); continue; }
      if (r.built) { cutAdd('has a building'); continue; }
      if (R.minLandValue && r.landval > 0 && r.landval < R.minLandValue) { cutAdd('land value under $' + R.minLandValue.toLocaleString()); continue; }
      if (GOV.test(r.owner || '')) { cutAdd('government / HOA / utility owner'); continue; }
      const flag = (String(r.legal || '') + ' ' + String(r.use || '')).match(REDFLAG); if (flag) { cutAdd('red flag in records: ' + flag[0].toLowerCase()); continue; }
      const sh = LB.shape(c.rings); c.sh = sh; const ac = sh.sqft / 43560;
      if (ac < R.minAcres * 0.85 || ac > R.maxAcres * 1.15) { cutAdd('mapped size out of range'); continue; }
      if (sh.avgWidth < R.minAvgWidthFt) { cutAdd('too narrow (under ' + R.minAvgWidthFt + ' ft wide)'); continue; }
      if (sh.compact < R.minCompact) { cutAdd('sliver / odd shape'); continue; }
      c.nm = nm; pass1.push(c); }
    log(`${pass1.length.toLocaleString()} lots passed size, width, shape, owner and red-flag checks.`);
    // mix: water & sewer market lots take 2 of every 5 slots, closest-to-deals lots the other 3
    { const ot = pass1.filter(c => !c.sewerMarket), byC = new Map();
      pass1.filter(c => c.sewerMarket).sort((a, b) => (b.church ? 1 : 0) - (a.church ? 1 : 0) || a.dist - b.dist).forEach(c => { const g = byC.get(c.r.county) || []; g.push(c); byC.set(c.r.county, g); });
      const mk = [], gs = [...byC.values()]; for (let k = 0; gs.some(g => k < g.length); k++) gs.forEach(g => { if (k < g.length) mk.push(g[k]); }); // the markets take turns
      const per5 = Math.round(5 * (R.marketShare || 0)); pass1.length = 0; let i = 0, j = 0;
      while (i < mk.length || j < ot.length) { for (let k = 0; k < per5 && i < mk.length; k++) pass1.push(mk[i++]); for (let k = 0; k < 5 - per5 && j < ot.length; k++) pass1.push(ot[j++]); } }
    // DLG HQ check + roads + flood, closest lots first, in batches (only checks as many as it needs)
    st.phase = 'checking owners'; const ownerBlock = await LB.ownerBlocks(R.recentDays, log); const supp = await LB.suppressedApns();
    const pickedOwners = new Set(); let churchN = 0;
    const final = [], perCounty = new Map(), multiCounty = !opt.noCountyCap && new Set(pass1.map(c => c.r.county)).size > 1; let i = 0;
    const cap = Math.max(1, Math.ceil(R.size * R.countyCapPct));
    for (let b = 0; b < pass1.length && final.length < R.size; b += 600) {
      st.phase = 'checking DLG HQ'; const batch = pass1.slice(b, b + 600); const worked = await workedSet(batch, log);
      st.phase = 'checking slope'; await LB.slopes(batch.filter(c => !worked.get(String(c.r.apn) + '|' + c.r.county.toLowerCase())));
      st.phase = 'checking roads and flood';
      for (const c of batch) { if (final.length >= R.size) break;
        const w = worked.get(String(c.r.apn) + '|' + c.r.county.toLowerCase()) || (c.r.apn2 && worked.get(String(c.r.apn2) + '|' + c.r.county.toLowerCase()));
        if (w) { cutAdd(w.startsWith('tagged') ? 'tagged in DLG HQ (DD or negative)' : (w.startsWith('mailed') || w.startsWith('resting')) ? w : 'already worked in DLG HQ'); continue; }
        if (supp.has(String(c.r.apn)) || (c.r.apn2 && supp.has(String(c.r.apn2)))) { cutAdd('on the suppression list'); continue; }
        const ok_ = normAddr(c.r.mail, c.r.mzip); if (pickedOwners.has(ok_)) { cutAdd('same owner already on this list (one letter per owner)'); continue; }
        const ob = ownerBlock.get(ok_); if (ob) { cutAdd(ob.startsWith('owner tagged') ? 'tagged in DLG HQ (DD or negative)' : ob); continue; }
        if (multiCounty && (perCounty.get(c.r.county) || 0) >= cap) { st.held++; continue; } // county already has its 30%
        if (c.church && churchN >= Math.ceil(R.size * (R.churchShare || 0))) { st.held++; continue; }
        if (c.slope && c.slope.pct > R.maxSlopePct) { cutAdd('too steep (over ' + R.maxSlopePct + '% slope)'); continue; }
        i++; const k = tileKey(c.c[0], c.c[1]); st.tile = k; const t0 = Date.now(); const [roads, flood] = await Promise.all([tileRoads(k), tileFlood(k)]); st.lastTileMs = Date.now() - t0; st.checked = i;
        if (flood === null) { cutAdd('flood map unavailable (skipped to be safe)'); continue; }
        if (flood.length && floodShare(c.rings, flood) >= 0.25) { cutAdd('in a FEMA flood zone'); continue; }
        if (roads === null) { cutAdd('road map unavailable (skipped to be safe)'); continue; }
        const fr = LB.frontage(c.rings, roads); c.front = fr;
        if (fr < R.minFrontageFt) { cutAdd('no road frontage'); continue; }
        if (c.r.state === 'NC') { const sw = await tileSewer(k); c.sewer = sw === null ? 'unknown' : sw.some(fr => inPoly(c.c, fr)) ? 'likely public sewer' : 'likely septic'; } else c.sewer = 'unknown';
        if (c.sewerMarket && c.sewer !== 'likely public sewer') { cutAdd('no public sewer (water & sewer market)'); continue; }
        perCounty.set(c.r.county, (perCounty.get(c.r.county) || 0) + 1);
        pickedOwners.add(ok_); if (c.church) churchN++;
        final.push(c); st.picked = final.length; if (i % 100 === 0) log(`Checked ${i} lots for road and flood, ${final.length} picked.`); }
    }
    st.final = final; st.byCounty = Object.fromEntries(perCounty);
    log(`Picked ${final.length.toLocaleString()} lots.` + (final.length < R.size ? ` Short of ${R.size}: widen the area or connect more county data.` : ''));
    return st;
  } catch (e) { st.error = e.message; log('Stopped: ' + e.message); throw e; } finally { st.phase = st.error ? 'error' : 'checked'; }
};

// ---- load into a DLG HQ campaign ----
async function loadCampaign(name, final, opt = {}) {
  const st = LB.status, R = { ...LB.RULES, ...opt };
  const drop = opt.drop || (() => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d.toISOString().slice(0, 10); })();
  const { data: camp, error } = await sb.from('campaigns').insert({ name, channel: 'mail', drop_date: drop, template: R.template, source: 'hq' }).select().single(); if (error) throw error;
  const rows = final.map(c => { const r = c.r, n = c.nm; return { full_name: n.owner, first_name: n.first || null, last_name: n.last || null, mail_address: titleCase(String(r.mail).replace(/\s+\d{5}(-\d{4})?$/, '')), mail_city: titleCase(r.mcity), mail_state: String(r.mstate || '').toUpperCase(), mail_zip: String(r.mzip || '').slice(0, 10),
    apn: String(r.apn), address: r.site ? titleCase(r.site) : null, city: r.scity ? titleCase(r.scity) : null, state: r.state, zip: r.szip || null, county: r.county, acres: +(c.sh.sqft / 43560).toFixed(3), lat: c.c[1], lng: c.c[0] }; });
  let rec = 0; const res = [];
  for (let i = 0; i < rows.length; i += 100) { const { data, error } = await sb.rpc('import_campaign_list', { cid: camp.id, rows: rows.slice(i, i + 100), src: 'county', tag: 'Weekly List', skip_dnm: true, skip_ni: true, skip_days: 0 }); if (error) throw error; res.push(data); rec += data.records; st.loaded = rec; }
  await sb.rpc('finish_campaign_import', { cid: camp.id });
  await sb.from('campaigns').update({ records: rec, cost: +(rec * (R.costPerPiece || 0.55)).toFixed(2) }).eq('id', camp.id);
  // stamp FIPS, check results and the buildable tag on each property
  const byKey = new Map(final.map(c => [String(c.r.apn) + '|' + c.r.county.toLowerCase(), c]));
  for (let from = 0; ; from += 1000) { const { data } = await sb.from('campaign_records').select('property_id,properties(id,apn,county,fields)').eq('campaign_id', camp.id).range(from, from + 999); if (!data || !data.length) break;
    for (let i = 0; i < data.length; i += 25) await Promise.all(data.slice(i, i + 25).map(x => { const p = x.properties; if (!p) return; const c = byKey.get(String(p.apn) + '|' + String(p.county || '').toLowerCase()); if (!c) return;
      return sb.from('properties').update({ fips: c.r.fips || null, fields: { ...(p.fields || {}), buildable: { checked: new Date().toISOString().slice(0, 10), avg_width_ft: c.sh.avgWidth, length_ft: c.sh.length, road_frontage_ft: c.front, flood: 'not in SFHA', sewer: c.sewer, slope_pct: c.slope ? c.slope.pct : null, relief_ft: c.slope ? c.slope.relief : null, land_value: c.r.landval || null, source: LB.source(c.r.state, c.r.county).name } } }).eq('id', p.id); }));
    if (data.length < 1000) break; }
  const skipped = res.reduce((a, d) => a + d.skipped_dnm + d.skipped_not_interested + d.skipped_recent, 0);
  return { campaign: camp.id, name, records: rec, skipped };
}
LB.toCampaign = async function (name, opt = {}) {
  const st = LB.status, R = { ...LB.RULES, ...opt }; if (!st || !st.final) throw new Error('Run the list first');
  const drop = opt.drop || (() => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d.toISOString().slice(0, 10); })();
  const L = (!opt.single && R.letters && R.letters.length > 1) ? R.letters : [{ label: '', template: opt.template || R.template }];
  // random halves, even by county
  const groups = new Map(); st.final.forEach(c => { const g = groups.get(c.r.county) || []; g.push(c); groups.set(c.r.county, g); });
  const parts = L.map(() => []); let turn = 0;
  for (const g of groups.values()) { for (let i = g.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [g[i], g[j]] = [g[j], g[i]]; } g.forEach(c => { parts[turn % L.length].push(c); turn++; }); }
  const base = opt.kind === 'buybox' ? null : true; const out = [];
  for (let i = 0; i < L.length; i++) { st.phase = 'loading into DLG HQ' + (L[i].label ? ' (' + L[i].label + ')' : '');
    const nm = (name && !base ? name : LB.listName(opt.kind || 'weekly', parts[i].length, drop, opt.who)) + (L[i].label ? ' · ' + L[i].label : '');
    out.push(await loadCampaign(nm, parts[i], { ...opt, drop, template: L[i].template })); }
  const rec = out.reduce((a, x) => a + x.records, 0), skipped = out.reduce((a, x) => a + x.skipped, 0);
  st.campaign = out[0].campaign; st.campaigns = out; st.report = LB.report(st, rec, skipped) + (out.length > 1 ? ' Split test: ' + out.map(x => `${x.name} (${x.records})`).join(' and ') + '.' : ''); st.phase = 'done';
  await sb.from('activity').insert({ kind: 'note', body: 'List built: ' + st.report });
  return { campaign: out[0].campaign, campaigns: out, records: rec, skipped };
};
// ---- unique list names ----
LB.listName = function (kind, size, drop, who) { const d = new Date((drop || new Date().toISOString().slice(0, 10)) + 'T12:00:00');
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const wk = Math.ceil(((t - new Date(Date.UTC(t.getUTCFullYear(), 0, 1))) / 864e5 + 1) / 7); const code = `${t.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return kind === 'buybox' ? `BB ${code} · ${who} · ${size} lots · mail ${date}` : `WL ${code} · Builder Lots · ${size} · mail ${date}`; };
// ---- Pebble import file (same records and offer codes as DLG HQ) ----
LB.pebbleCSV = async function (campaignId) { const all = [];
  for (let o = 0; ; o += 1000) { const { data } = await sb.from('campaign_records').select('offer_code,leads(full_name,first_name,last_name,mail_address,mail_city,mail_state,mail_zip),properties(apn,address,city,state,zip,county,fips,acres)').eq('campaign_id', campaignId).range(o, o + 999); all.push(...(data || [])); if (!data || data.length < 1000) break; }
  const { data: c } = await sb.from('campaigns').select('name').eq('id', campaignId).single();
  const rows = all.map(r => { const l = r.leads || {}, p = r.properties || {}; return { 'Owner Name': l.full_name || '', 'First Name': l.first_name || '', 'Last Name': l.last_name || '', 'Mailing Address': l.mail_address || '', 'Mailing City': l.mail_city || '', 'Mailing State': l.mail_state || '', 'Mailing Zip': l.mail_zip || '',
    'Property Address': p.address || '', 'Property City': /^\d{5}$/.test(p.city || '') ? '' : (p.city || ''), 'Property State': p.state || '', 'Property Zip': p.zip || '', 'County': p.county || '', 'FIPS': p.fips || '', 'APN': p.apn || '', 'Acres': p.acres != null ? String(+(+p.acres).toFixed(2)) : '', 'Offer Code': r.offer_code || '' }; });
  const esc_ = v => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v; const cols = Object.keys(rows[0] || { 'Owner Name': '' });
  const csv = [cols.join(','), ...rows.map(r => cols.map(k => esc_(r[k])).join(','))].join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = (c?.name || 'list').replace(/[^\w .-]+/g, '') + ' - Pebble import.csv'; document.body.appendChild(a); a.click(); a.remove();
  return rows.length; };
// ---- list for one builder's buy box (runs when a new buy box comes in) ----
LB.forBuyer = async function (buyerId, size = 250) {
  const { data: b, error } = await sb.from('buyers').select('*').eq('id', buyerId).single(); if (error) throw error;
  const SC = /^(york|lancaster|chester|charleston|berkeley|dorchester|horry|greenville|spartanburg|oconee|pickens|anderson)$/i;
  const counties = [], missing = [];
  (b.counties || []).forEach(c => { const st = SC.test(c) ? 'SC' : 'NC'; if (LB.source(st, c)) counties.push({ county: c, state: st, why: 'buy box: ' + (b.company || b.name) }); else missing.push(`${c} County, ${st}`); });
  if (!counties.length) throw new Error('No county data connected for this buy box' + (missing.length ? ': ' + missing.join(', ') : ''));
  const opt = { size, noRamp: true, noCountyCap: true, targets: { pts: [], counties, missing } };
  if (b.min_acres) opt.minAcres = +b.min_acres; if (b.max_acres) opt.maxAcres = +b.max_acres;
  await LB.run(opt);
  return LB.toCampaign(null, { ...opt, kind: 'buybox', who: b.company || b.name });
};
const R_MAX = () => LB.RULES.maxSlopePct;
LB.report = function (st, rec, skipped) {
  const cutN = Object.values(st.cut).reduce((a, b) => a + b, 0) + (skipped || 0);
  const lines = Object.entries(st.cut).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v.toLocaleString()} ${k}`);
  if (skipped) lines.push(`${skipped} removed at import (do-not-mail or said no)`);
  const sewer = (st.final || []).filter(c => c.sewer === 'likely public sewer').length;
  const sl = (st.final || []).map(c => c.slope && c.slope.pct).filter(v => v != null); const flat = sl.filter(v => v <= 5).length;
  const churches = (st.final || []).filter(c => c.church).length;
  const counties = Object.entries(st.byCounty || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  return `${rec.toLocaleString()} records picked from ${Number(st.pool || 0).toLocaleString()} vacant lots. ${cutN.toLocaleString()} lots cut before mailing (they would have cost about ${(cutN * 0.55).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} at $0.55): ${lines.join('; ')}.` + (counties ? ` By county: ${counties}.` : '') + (st.held ? ` ${st.held.toLocaleString()} good lots held back by the 30% county cap.` : '') + (churches ? ` ${churches} church-owned lots.` : '') + ` ${sewer} of ${rec} look to be inside a public sewer area (2004 state map).` + (sl.length ? ` Slope: ${flat} of ${sl.length} checked are 5% or flatter, all are ${R_MAX()}% or less.` : '') + (st.missing && st.missing.length ? ` Pull county data for: ${st.missing.join(', ')}.` : '');
};
})();
