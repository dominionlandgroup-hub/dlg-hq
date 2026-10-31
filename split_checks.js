// DLG HQ - Split Finder site checks (run in the browser on landiq.land, loaded on demand).
// For each parcel: road frontage along the public right-of-way (boundary not shared with a neighbor parcel and next to a
// street centerline), who maintains the road, FEMA flood (100-yr, floodway, 500-yr) on a grid of points inside the parcel,
// USGS 1-meter lidar slope / relief / height vs. the road, shape check, recorded-plat flag. Results go to split_parcels.
// Charlotte/Mecklenburg sources are CORS-open. Other counties plug in through SCK.sources.
(function () {
  const FT_PER_DEG = 364173;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function getJ(url, params, tries = 4) {
    const u = url + '?' + new URLSearchParams(params);
    for (let i = 0; ; i++) {
      try {
        const ac = new AbortController(), to = setTimeout(() => ac.abort(), 45000);
        const r = await fetch(u, { signal: ac.signal });
        const j = await r.json(); clearTimeout(to);
        if (j.error) throw new Error(j.error.message || 'service error');
        return j;
      } catch (e) { if (i >= tries - 1) throw e; await sleep(1500 * (i + 1)); }
    }
  }
  // local feet projection around a reference point
  function proj(lat0, lon0) {
    const k = Math.cos(lat0 * Math.PI / 180) * FT_PER_DEG;
    return { f: ([x, y]) => [(x - lon0) * k, (y - lat0) * FT_PER_DEG], b: ([X, Y]) => [X / k + lon0, Y / FT_PER_DEG + lat0] };
  }
  function inRings(pt, rings) { // even-odd over all rings
    let c = false; const [x, y] = pt;
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
    const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
    return { d: Math.hypot(x, y), dx, dy };
  }
  function nearestLine(p, lines) { // lines: [{pts:[[x,y]...], attr}]
    let best = { d: 1e9 };
    for (const l of lines) for (let i = 1; i < l.pts.length; i++) {
      const s = segDist(p, l.pts[i - 1], l.pts[i]);
      if (s.d < best.d) best = { d: s.d, dx: s.dx, dy: s.dy, attr: l.attr };
    }
    return best;
  }
  function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return a / 2; }
  function minBoxFill(rings, area) {
    const pts = rings.flat(); let best = Infinity;
    for (let deg = 0; deg < 90; deg += 3) {
      const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
      let a = Infinity, b = -Infinity, d = Infinity, e = -Infinity;
      for (const [x, y] of pts) { const u = x * c + y * s, v = -x * s + y * c; a = Math.min(a, u); b = Math.max(b, u); d = Math.min(d, v); e = Math.max(e, v); }
      best = Math.min(best, (b - a) * (e - d));
    }
    return area / best;
  }
  const SFHA = /^(A|AE|AH|AO|A99|AR|V|VE)$/;

  const SCK = {
    state: { done: 0, total: 0, errors: [], running: false }, results: [],
    sources: {
      Charlotte: {
        parcels: 'https://gis.charlottenc.gov/arcgis/rest/services/PLN/AllParcelData/MapServer/0/query',
        idField: 'parcelid', extraFields: 'legaldescription',
        streets: 'https://gis.charlottenc.gov/arcgis/rest/services/CountyData/Streets/MapServer/0/query',
        streetFields: 'FULL_NAME,MAINT_BY,SUBDIVISIONNAME',
        isPublic: a => !!(a.MAINT_BY && String(a.MAINT_BY).trim()),
        roadName: a => String(a.FULL_NAME || '').replace(/^[\d\s-]+(?=[A-Z])/i, '').trim(),
        plat: a => /^M\d+-\d+/i.test(String(a.legaldescription || '').trim()),
        platLabel: a => String(a.legaldescription || '').trim(),
        subField: 'SUBDIVISIONNAME',
      },
      Gaston: {
        parcels: 'https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Parcels/MapServer/11/query',
        idField: 'PIN', extraFields: 'PLAT_BOOK,PLAT_PAGE,NBHDNAME',
        streets: 'https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Streets/MapServer/12/query',
        streetFields: 'FULLNAME,OWNER,SUBD',
        isPublic: a => /^(NCDOT|SCDOT|MUN|PUB)$/.test(String(a.OWNER || '')),
        roadName: a => a.FULLNAME,
        plat: a => !!(a.PLAT_BOOK && String(a.PLAT_BOOK).trim() && String(a.PLAT_BOOK).trim() !== '0'),
        platLabel: a => `plat book ${a.PLAT_BOOK} page ${a.PLAT_PAGE}`,
        subField: 'SUBD',
      },
    },
  };
  // Union, Cabarrus, Iredell, Rowan: NC OneMap statewide parcels (geometry, subdivision) + Census TIGER roads.
  // TIGER can't tell public from private reliably: S1100/S1200/S1400 count as public; NCDOT check (v3road) confirms.
  const ONEMAP = 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query';
  const TIGER = ['https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/6/query', 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/8/query'];
  for (const [name, fips] of [['Union', '179'], ['Cabarrus', '025'], ['Iredell', '097'], ['Rowan', '159'], ['GastonOneMap', '071']]) SCK.sources[name] = {
    parcels: ONEMAP, idField: 'parno', whereExtra: `cntyfips='${fips}'`, extraFields: 'subdivisio,legdecfull',
    streets: TIGER, streetFields: 'NAME,MTFCC',
    isPublic: a => /^S1[124]00$/.test(String(a.MTFCC || '')),
    roadName: a => a.NAME,
    plat: a => !!(a.subdivisio && String(a.subdivisio).trim()),
    platLabel: a => String(a.subdivisio || a.legdecfull || '').trim(),
    subField: 'FULLNAME_NONE',
    busy: a => /^S1[12]00$/.test(String(a.MTFCC || '')), busyFields: 'NAME,MTFCC',
  };

  // Streets can be one service or a list (TIGER: secondary + local roads); results are merged.
  async function getStreets(src, params) {
    const L = Array.isArray(src.streets) ? src.streets : [src.streets];
    const js = await Promise.all(L.map(u => getJ(u, params)));
    return { features: js.flatMap(j => (j && j.features) || []) };
  }
  async function parcelGeom(src, id) {
    const j = await getJ(src.parcels, { where: `${src.idField}='${id}'${src.whereExtra ? ' AND ' + src.whereExtra : ''}`, outFields: `${src.idField},${src.extraFields || ''}`.replace(/,$/, ''), returnGeometry: 'true', outSR: '4326', f: 'json' });
    const f = j.features && j.features[0]; if (!f) throw new Error('parcel not found');
    return f;
  }

  async function checkOne(r) {
    const src = SCK.sources[r.county]; if (!src) throw new Error('no sources for ' + r.county);
    const f = await parcelGeom(src, r.parcel);
    const ringsLL = f.geometry.rings;
    const all = ringsLL.flat();
    const lon0 = all.reduce((s, p) => s + p[0], 0) / all.length, lat0 = all.reduce((s, p) => s + p[1], 0) / all.length;
    const P = proj(lat0, lon0);
    const rings = ringsLL.map(rr => rr.map(P.f));
    const area = Math.abs(rings.reduce((s, rr) => s + ringArea(rr), 0));
    const xs = rings.flat().map(p => p[0]), ys = rings.flat().map(p => p[1]);
    const env = (pad) => { const a = P.b([Math.min(...xs) - pad, Math.min(...ys) - pad]), b = P.b([Math.max(...xs) + pad, Math.max(...ys) + pad]); return `${a[0]},${a[1]},${b[0]},${b[1]}`; };
    const envQ = pad => ({ geometry: env(pad), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outSR: '4326', returnGeometry: 'true', f: 'json' });

    const [nb, st, fl] = await Promise.all([
      getJ(src.parcels, { ...envQ(60), outFields: src.idField, resultRecordCount: '400' }),
      getStreets(src, { ...envQ(160), outFields: src.streetFields }),
      getJ('https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query', { ...envQ(20), outFields: 'FLD_ZONE,ZONE_SUBTY', maxAllowableOffset: '0.00001' }).catch(() => null),
    ]);
    const nbLines = [];
    for (const g of nb.features || []) if (String(g.attributes[src.idField]) !== String(r.parcel)) for (const rr of g.geometry.rings) nbLines.push({ pts: rr.map(P.f) });
    const stLines = [];
    for (const g of st.features || []) for (const p of g.geometry.paths || []) stLines.push({ pts: p.map(P.f), attr: g.attributes });

    // frontage: boundary points not shared with a neighbor, within 85 ft of a street centerline and running along it
    let frontPts = [], roads = {}, pub = false;
    for (const rr of rings) for (let i = 1; i < rr.length; i++) {
      const a = rr[i - 1], b = rr[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / 5));
      for (let k = 0; k < n; k++) {
        const p = [a[0] + (b[0] - a[0]) * (k + .5) / n, a[1] + (b[1] - a[1]) * (k + .5) / n];
        const nbd = nearestLine(p, nbLines).d;
        if (nbd < 6) continue;
        const s = nearestLine(p, stLines);
        if (s.d > 85) continue;
        const cos = Math.abs(((b[0] - a[0]) * s.dx + (b[1] - a[1]) * s.dy) / (L * Math.hypot(s.dx, s.dy) || 1));
        if (cos < 0.7) continue;
        frontPts.push(p);
        const nm = src.roadName(s.attr) || '?';
        roads[nm] = (roads[nm] || 0) + L / n;
        if (src.isPublic(s.attr)) pub = true;
      }
    }
    const frontage = Math.round(Object.values(roads).reduce((s, v) => s + v, 0));
    const roadList = Object.entries(roads).sort((a, b) => b[1] - a[1]);
    const subdiv = [...new Set((st.features || []).map(g => g.attributes[src.subField]).filter(Boolean))].slice(0, 2).join(', ');

    // grid inside the parcel
    const sp = Math.max(10, Math.sqrt(area / 70));
    const grid = [];
    for (let x = Math.min(...xs) + sp / 2; x < Math.max(...xs); x += sp) for (let y = Math.min(...ys) + sp / 2; y < Math.max(...ys); y += sp) if (inRings([x, y], rings)) grid.push([x, y]);
    if (grid.length < 4) grid.push(...rings[0].slice(0, 4));

    // flood
    let f100 = 0, fway = false, f500 = 0;
    if (fl && fl.features) {
      const polys = fl.features.map(g => ({ a: g.attributes, rings: (g.geometry.rings || []).map(rr => rr.map(P.f)) }));
      for (const p of grid) {
        let in100 = false, in500 = false;
        for (const q of polys) if (inRings(p, q.rings)) {
          const z = String(q.a.FLD_ZONE || ''), sub = String(q.a.ZONE_SUBTY || '');
          if (SFHA.test(z)) { in100 = true; if (/FLOODWAY/i.test(sub)) fway = true; }
          else if (/0\.2 PCT/i.test(sub)) in500 = true;
        }
        if (in100) f100++; else if (in500) f500++;
      }
    }

    // elevation (USGS 3DEP 1 m lidar)
    const front = frontPts.filter((_, i) => i % 3 === 0).slice(0, 40);
    const ptsLL = grid.concat(front).map(P.b);
    const elev = [];
    for (let i = 0; i < ptsLL.length; i += 150) {
      const chunk = ptsLL.slice(i, i + 150);
      const j = await getJ('https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples', {
        geometry: JSON.stringify({ points: chunk, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryMultipoint',
        returnFirstValueOnly: 'true', interpolation: 'RSP_BilinearInterpolation', f: 'json' });
      const vals = new Array(chunk.length).fill(null);
      for (const s of j.samples || []) vals[s.locationId] = Number(s.value) * 3.28084;
      elev.push(...vals);
    }
    const ge = elev.slice(0, grid.length), fe = elev.slice(grid.length).filter(v => v != null);
    const gv = grid.map((p, i) => [p[0], p[1], ge[i]]).filter(p => p[2] != null && p[2] > -1000);
    let slope = null, relief = null, belowRoad = null, steepShare = null;
    if (gv.length >= 4) {
      const zs = gv.map(p => p[2]); relief = Math.round(Math.max(...zs) - Math.min(...zs));
      // local slope from grid neighbours
      const key = (x, y) => Math.round(x / sp) + ',' + Math.round(y / sp);
      const m = new Map(gv.map(p => [key(p[0], p[1]), p[2]]));
      const loc = [];
      for (const [x, y, z] of gv) {
        const e = m.get(key(x + sp, y)), n = m.get(key(x, y + sp));
        if (e != null && n != null) loc.push(100 * Math.hypot((e - z) / sp, (n - z) / sp));
      }
      if (loc.length) { slope = Math.round(10 * loc.reduce((s, v) => s + v, 0) / loc.length) / 10; steepShare = Math.round(100 * loc.filter(v => v > 15).length / loc.length); }
      if (fe.length) belowRoad = Math.round(fe.reduce((s, v) => s + v, 0) / fe.length - zs.reduce((s, v) => s + v, 0) / zs.length);
    }

    const fill = minBoxFill(rings, area);
    const minA = r.min_lot_sqft || 0, minW = r.min_width_ft || 0;
    const lotsArea = minA ? Math.floor(area / minA) : r.lots_by_area;
    const lotsFront = minW ? Math.floor(frontage / minW) : null;
    const estLots = lotsFront == null ? lotsArea : Math.min(lotsArea, lotsFront);
    const upd = {
      frontage_ft: frontage, frontage_method: 'ROW edge (not shared with a neighbor) within 85 ft of a street centerline',
      road_name: roadList.map(([k, v]) => `${k} (${Math.round(v)} ft)`).join('; ') || null,
      road_public: frontage ? pub : null, est_lots: estLots, lots_by_area: lotsArea, lot_sqft: Math.round(area), acres: Math.round(area / 435.6) / 100,
      shape_ok: fill >= 0.55 && estLots >= 3,
      flood_pct: Math.round(100 * f100 / grid.length), floodway: fway, flood500_pct: Math.round(100 * f500 / grid.length),
      slope_pct: slope,
      subdivision: src.plat && src.plat(f.attributes) ? ((subdiv ? subdiv + ' · ' : '') + 'recorded plat ' + src.platLabel(f.attributes)) : null,
      checks_done: JSON.stringify({ v: 1, at: new Date().toISOString().slice(0, 10), relief_ft: relief, below_road_ft: belowRoad, steep_share_pct: steepShare, shape_fill: Math.round(fill * 100) / 100, grid_pts: grid.length, lots_by_frontage: lotsFront, legal: src.platLabel(f.attributes) || null }),
      updated_at: new Date().toISOString(),
    };
    return upd;
  }

  async function run(rows, workers = 4) {
    const S = SCK.state; S.done = 0; S.total = rows.length; S.errors = []; S.running = true;
    let i = 0;
    async function w() {
      while (i < rows.length) {
        const r = rows[i++];
        try {
          const upd = await checkOne(r);
          if (typeof sb !== 'undefined') {
            const { error } = await sb.from('split_parcels').update(upd).eq('id', r.id);
            if (error) throw new Error(error.message);
          } else SCK.results.push({ dedupe_key: r.dedupe_key, ...upd }); // off-site run: results are imported later
          Object.assign(r, upd);
        } catch (e) { S.errors.push(r.parcel + ': ' + e.message); }
        S.done++;
      }
    }
    await Promise.all(Array.from({ length: workers }, w));
    S.running = false;
    return S;
  }
  SCK.checkOne = checkOne; SCK.run = run;

  // ---- v2 extra checks: creek buffers (USGS NHD streams), wetlands (USFWS NWI), power transmission lines (HIFLD),
  // water-supply watershed (NC DEQ), busy road (speed / highway / thoroughfare). Merged into checks_done JSON.
  const STREAMS = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query';
  const NWI = 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query';
  const HIFLD = 'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0/query';
  const WSW = 'https://services2.arcgis.com/kCu40SDxsCGcuUWO/ArcGIS/rest/services/dwq_wsws_20141126/FeatureServer/0/query';
  SCK.sources.Charlotte.busy = a => Number(a.SPEEDLIMIT) >= 45 || /major|thoroughfare|arterial|freeway|expressway/i.test(String(a.THOROUGHFARETYPE || '') + ' ' + String(a.STREETCLASS || ''));
  SCK.sources.Charlotte.busyFields = 'FULL_NAME,SPEEDLIMIT,THOROUGHFARETYPE,STREETCLASS';
  SCK.sources.Gaston.busy = a => Number(a.MPH) >= 45 || /^(US|NC|I|INTERSTATE)$/i.test(String(a.DESIGNTN || ''));
  SCK.sources.Gaston.busyFields = 'FULLNAME,MPH,DESIGNTN';

  async function checkExtra(r) {
    const src = SCK.sources[r.county]; if (!src) throw new Error('no sources for ' + r.county);
    const f = await parcelGeom(src, r.parcel);
    const all = f.geometry.rings.flat();
    const lon0 = all.reduce((s, p) => s + p[0], 0) / all.length, lat0 = all.reduce((s, p) => s + p[1], 0) / all.length;
    const P = proj(lat0, lon0);
    const rings = f.geometry.rings.map(rr => rr.map(P.f));
    const area = Math.abs(rings.reduce((s, rr) => s + ringArea(rr), 0));
    const xs = rings.flat().map(p => p[0]), ys = rings.flat().map(p => p[1]);
    const env = pad => { const a = P.b([Math.min(...xs) - pad, Math.min(...ys) - pad]), b = P.b([Math.max(...xs) + pad, Math.max(...ys) + pad]); return `${a[0]},${a[1]},${b[0]},${b[1]}`; };
    const envQ = (pad, fields) => ({ geometry: env(pad), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outSR: '4326', returnGeometry: 'true', outFields: fields, f: 'json' });
    const soft = p => p.catch(() => null);
    const [sm, wl, pl, ws, st] = await Promise.all([
      soft(getJ(STREAMS, envQ(120, 'ftype,gnis_name'))),
      soft(getJ(NWI, envQ(10, 'WETLAND_TYPE,ATTRIBUTE'))),
      soft(getJ(HIFLD, envQ(120, 'VOLTAGE,OWNER'))),
      soft(getJ(WSW, { geometry: `${lon0},${lat0}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'class,WSWS_PCA,STREAM_NAM', returnGeometry: 'false', f: 'json' })),
      soft(getStreets(src, envQ(90, src.busyFields))),
    ]);
    const sp = Math.max(10, Math.sqrt(area / 70));
    const grid = [];
    for (let x = Math.min(...xs) + sp / 2; x < Math.max(...xs); x += sp) for (let y = Math.min(...ys) + sp / 2; y < Math.max(...ys); y += sp) if (inRings([x, y], rings)) grid.push([x, y]);
    if (!grid.length) grid.push(...rings[0].slice(0, 4));
    const lines = j => { const L = []; for (const g of (j && j.features) || []) for (const p of g.geometry.paths || []) L.push({ pts: p.map(P.f), attr: g.attributes }); return L; };
    // creek buffer: grid points within 50 ft of a mapped stream (pipes/canals excluded)
    const sLines = lines(sm).filter(l => Number(l.attr.ftype) === 460 || /stream|river/i.test(String(l.attr.ftype || ''))); // 460 = StreamRiver
    const nearStream = sLines.length ? grid.filter(p => nearestLine(p, sLines).d <= 50).length : 0;
    const streamName = sLines.length ? (sLines.map(l => l.attr.gnis_name).find(Boolean) || 'unnamed stream') : null;
    // wetlands (lakes/ponds excluded)
    let wet = 0;
    if (wl && wl.features) {
      const polys = wl.features.filter(g => !/lake|pond|riverine/i.test(String(g.attributes.WETLAND_TYPE || ''))).map(g => (g.geometry.rings || []).map(rr => rr.map(P.f)));
      wet = grid.filter(p => polys.some(q => inRings(p, q))).length;
    }
    // transmission lines within 75 ft of the buildable grid
    const pLines = lines(pl);
    const power = pLines.length && grid.some(p => nearestLine(p, pLines).d <= 75) ? (pLines[0].attr.VOLTAGE > 0 ? pLines[0].attr.VOLTAGE + ' kV' : 'yes') : null;
    // water-supply watershed
    const w = ws && ws.features && ws.features[0] && ws.features[0].attributes;
    const wsClass = w ? `${w.WSWS_PCA || w.class} (${w.STREAM_NAM || ''})` : null;
    const wsLimit = w && /WS-(II|III|IV)/i.test(String(w.class || w.WSWS_PCA)) ? true : false;
    // busy road: street within 85 ft of the parcel edge that is 45+ mph, a highway or a major thoroughfare
    const stL = lines(st); const edge = [];
    for (const rr of rings) for (let i = 1; i < rr.length; i++) edge.push(rr[i]);
    const busyRoads = [...new Set(stL.filter(l => src.busy(l.attr) && edge.some(p => nearestLine(p, [l]).d <= 85)).map(l => src.roadName(l.attr) || '?'))];
    let prev = {}; try { prev = JSON.parse(r.checks_done || '{}') || {}; } catch (e) { }
    return {
      creek_buffer_pct: Math.round(100 * nearStream / grid.length), wetland: wet > 0,
      checks_done: JSON.stringify({ ...prev, v2: new Date().toISOString().slice(0, 10), stream: streamName, wetland_pct: Math.round(100 * wet / grid.length), power_line: power, watershed: wsClass, watershed_limits: wsLimit, busy_road: busyRoads.join(', ') || null }),
      updated_at: new Date().toISOString(),
    };
  }
  SCK.checkExtra = checkExtra;
  // ---- v3 road check: is the frontage road state (NCDOT) or city maintained? Used to clear "Private road?" flags.
  const NCDOT_SMR = 'https://gis11.services.ncdot.gov/arcgis/rest/services/NCDOT_StateMaintainedRoadsQtr/MapServer/0/query';
  const CLT_MAINT = 'https://gis.charlottenc.gov/arcgis/rest/services/CDOT/StreetMaintenanceResponsibility/MapServer/0/query';
  async function checkRoad(r) {
    const src = SCK.sources[r.county]; if (!src) throw new Error('no sources for ' + r.county);
    const f = await parcelGeom(src, r.parcel);
    const all = f.geometry.rings.flat();
    const lon0 = all.reduce((s, p) => s + p[0], 0) / all.length, lat0 = all.reduce((s, p) => s + p[1], 0) / all.length;
    const P = proj(lat0, lon0); const rings = f.geometry.rings.map(rr => rr.map(P.f));
    const xs = rings.flat().map(p => p[0]), ys = rings.flat().map(p => p[1]);
    const a = P.b([Math.min(...xs) - 90, Math.min(...ys) - 90]), b = P.b([Math.max(...xs) + 90, Math.max(...ys) + 90]);
    const q = fields => ({ geometry: `${a[0]},${a[1]},${b[0]},${b[1]}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outSR: '4326', returnGeometry: 'true', outFields: fields, f: 'json' });
    const edge = []; for (const rr of rings) for (let i = 1; i < rr.length; i++) { const p0 = rr[i - 1], p1 = rr[i], n = Math.max(1, Math.round(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 10)); for (let k = 0; k < n; k++) edge.push([p0[0] + (p1[0] - p0[0]) * k / n, p0[1] + (p1[1] - p0[1]) * k / n]); }
    const near = j => { const out = []; for (const g of (j && j.features) || []) for (const p of g.geometry.paths || []) { const L = { pts: p.map(P.f), attr: g.attributes }; if (edge.some(e => nearestLine(e, [L]).d <= 85)) out.push(g.attributes); } return out; };
    const st = near(await getJ(NCDOT_SMR, q('RouteName,StreetName')).catch(() => null));
    let maint = st.length ? 'NCDOT ' + [...new Set(st.map(x => x.RouteName + (x.StreetName ? ' ' + x.StreetName : '')))].slice(0, 2).join('; ') : null;
    if (!maint && r.county === 'Charlotte') { const c = near(await getJ(CLT_MAINT, q('MaintainedBy,WHOLESTNAME')).catch(() => null)).filter(x => x.MaintainedBy); if (c.length) maint = c[0].MaintainedBy + ' ' + (c[0].WHOLESTNAME || ''); }
    let prev = {}; try { prev = JSON.parse(r.checks_done || '{}') || {}; } catch (e) { }
    const upd = { checks_done: JSON.stringify({ ...prev, road_maint: maint, v3road: new Date().toISOString().slice(0, 10) }), updated_at: new Date().toISOString() };
    if (maint) upd.road_public = true;
    return upd;
  }
  SCK.checkRoad = checkRoad;
  // ---- v3 terrain: height vs. the road measured only on the build band (within 150 ft of the frontage), plus that band's slope.
  async function checkTerrain(r) {
    const src = SCK.sources[r.county]; if (!src) throw new Error('no sources for ' + r.county);
    const f = await parcelGeom(src, r.parcel);
    const all = f.geometry.rings.flat();
    const lon0 = all.reduce((s, p) => s + p[0], 0) / all.length, lat0 = all.reduce((s, p) => s + p[1], 0) / all.length;
    const P = proj(lat0, lon0); const rings = f.geometry.rings.map(rr => rr.map(P.f));
    const area = Math.abs(rings.reduce((s, rr) => s + ringArea(rr), 0));
    const xs = rings.flat().map(p => p[0]), ys = rings.flat().map(p => p[1]);
    const a = P.b([Math.min(...xs) - 120, Math.min(...ys) - 120]), b = P.b([Math.max(...xs) + 120, Math.max(...ys) + 120]);
    const st = await getStreets(src, { geometry: `${a[0]},${a[1]},${b[0]},${b[1]}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outSR: '4326', returnGeometry: 'true', outFields: 'OBJECTID', f: 'json' });
    const sL = []; for (const g of st.features || []) for (const p of g.geometry.paths || []) sL.push({ pts: p.map(P.f) });
    // road points: the street centerline itself, at spots nearest the parcel edge (within 85 ft)
    const roadPts = [];
    for (const rr of rings) for (let i = 1; i < rr.length; i++) { const p0 = rr[i - 1], p1 = rr[i], n = Math.max(1, Math.round(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 15));
      for (let k = 0; k < n; k++) { const e = [p0[0] + (p1[0] - p0[0]) * (k + .5) / n, p0[1] + (p1[1] - p0[1]) * (k + .5) / n]; const s = nearestLine(e, sL); if (s.d <= 85) roadPts.push(e); } }
    if (!roadPts.length) { let prev = {}; try { prev = JSON.parse(r.checks_done || '{}') || {}; } catch (e) { } return { checks_done: JSON.stringify({ ...prev, below_road_ft: null, v3terrain: 'no road' }), updated_at: new Date().toISOString() }; }
    const sp = Math.max(8, Math.min(25, Math.sqrt(area / 90)));
    const band = [];
    for (let x = Math.min(...xs) + sp / 2; x < Math.max(...xs); x += sp) for (let y = Math.min(...ys) + sp / 2; y < Math.max(...ys); y += sp)
      if (inRings([x, y], rings) && roadPts.some(q => Math.hypot(q[0] - x, q[1] - y) <= 150)) band.push([x, y]);
    const rp = roadPts.filter((_, i) => i % 2 === 0).slice(0, 40), bp = band.slice(0, 220);
    const pts = rp.concat(bp).map(P.b), elev = [];
    for (let i = 0; i < pts.length; i += 150) {
      const ch = pts.slice(i, i + 150);
      const j = await getJ('https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples', { geometry: JSON.stringify({ points: ch, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryMultipoint', returnFirstValueOnly: 'true', interpolation: 'RSP_BilinearInterpolation', f: 'json' });
      const v = new Array(ch.length).fill(null); for (const s of j.samples || []) v[s.locationId] = Number(s.value) * 3.28084; elev.push(...v);
    }
    const re = elev.slice(0, rp.length).filter(v => v != null && v > -1000), be = bp.map((p, i) => [p[0], p[1], elev[rp.length + i]]).filter(p => p[2] != null && p[2] > -1000);
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    const below = re.length && be.length ? Math.round(mean(re) - mean(be.map(p => p[2]))) : null;
    const key = (x, y) => Math.round(x / sp) + ',' + Math.round(y / sp); const m = new Map(be.map(p => [key(p[0], p[1]), p[2]])); const loc = [];
    for (const [x, y, z] of be) { const e = m.get(key(x + sp, y)), n = m.get(key(x, y + sp)); if (e != null && n != null) loc.push(100 * Math.hypot((e - z) / sp, (n - z) / sp)); }
    let prev = {}; try { prev = JSON.parse(r.checks_done || '{}') || {}; } catch (e) { }
    return { checks_done: JSON.stringify({ ...prev, below_road_ft: below, band_slope_pct: loc.length ? Math.round(10 * mean(loc)) / 10 : null, v3terrain: new Date().toISOString().slice(0, 10) }), updated_at: new Date().toISOString() };
  }
  SCK.checkTerrain = checkTerrain;


  SCK.runWith = async function (rows, fn, workers = 4) {
    const S = SCK.state; S.done = 0; S.total = rows.length; S.errors = []; S.running = true;
    let i = 0;
    async function w() {
      while (i < rows.length) {
        const r = rows[i++];
        try {
          const upd = await fn(r);
          if (typeof sb !== 'undefined') { const { error } = await sb.from('split_parcels').update(upd).eq('id', r.id); if (error) throw new Error(error.message); }
          else SCK.results.push({ dedupe_key: r.dedupe_key, ...upd });
          Object.assign(r, upd);
        } catch (e) { S.errors.push(r.parcel + ': ' + e.message); }
        S.done++;
      }
    }
    await Promise.all(Array.from({ length: workers }, w));
    S.running = false; return S;
  };

  window.SCK = SCK;
})();
