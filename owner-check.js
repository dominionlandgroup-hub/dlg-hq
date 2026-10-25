// owner-check.js - checks every mail record against the county's CURRENT ownership record
// before a list can go to the mail house. Added Oct 24, 2026 after letters went to owners
// who had already sold (the statewide NC OneMap layer and old DLG HQ records were months stale).
//
// OwnerCheck.run(records, {estateCampaign, onProgress}) -> results, one per record:
//   {status:'ok'|'sold'|'changed'|'heir'|'unverified', reason, owner, sale, price}
//   sold       = owner name doesn't match and the county shows a deed in the last 24 months, or the
//                property is now owned by a bank / HUD / government / company the list doesn't name
//   changed    = owner name doesn't match (older deed)
//   heir       = name doesn't match but this is an estate / heir letter (addressed to the PR or heir)
//   unverified = the county record couldn't be checked (county not connected, site down, parcel not found)
(function () {
  const DAY = 864e5;
  const fetchJSON = async (url, ms = 20000) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
    try { const r = await fetch(url, { signal: ac.signal }); return await r.json(); } finally { clearTimeout(t); }
  };
  // Some county servers don't allow cross-site requests; ArcGIS supports JSONP for those.
  const jsonp = (url, ms = 20000) => new Promise((res, rej) => {
    const cb = '__oc' + Math.random().toString(36).slice(2); const s = document.createElement('script');
    const done = () => { clearTimeout(t); delete window[cb]; s.remove(); };
    const t = setTimeout(() => { done(); rej(new Error('timeout')); }, ms);
    window[cb] = d => { done(); res(d); };
    s.onerror = () => { done(); rej(new Error('county site did not load')); };
    s.src = url + '&callback=' + cb; document.head.appendChild(s);
  });
  const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const ymd = d => (d && d.length >= 8) ? new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) : null;
  const ep = v => v ? new Date(v) : null;
  const join = (...a) => a.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  // county -> how to read its live ownership record. key(apn) must equal the value read back from rec.
  const COUNTIES = {
    'MECKLENBURG|NC': {
      url: 'https://meckgis.mecklenburgcountync.gov/server/rest/services/TaxParcel_Camaownershipvalues/FeatureServer/0/query',
      field: 'pid', key: a => String(a).replace(/\D/g, '').padStart(8, '0'),
      out: 'pid,full_owner_name,secownerfirstname,secownerlastname,dte_dateofsale,amt_price',
      rec: a => ({ k: a.pid, owner: join(a.full_owner_name, a.secownerfirstname, a.secownerlastname), sale: ep(a.dte_dateofsale), price: a.amt_price })
    },
    'GASTON|NC': {
      url: 'https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Parcels/MapServer/11/query', jsonp: true,
      field: 'PID', key: a => String(a).replace(/\D/g, ''),
      out: 'PID,CURR_NAME1,CURR_NAME2,SALEDATE,SALESAMT',
      rec: a => ({ k: a.PID, owner: join(a.CURR_NAME1, a.CURR_NAME2), sale: ep(a.SALEDATE), price: a.SALESAMT })
    },
    'IREDELL|NC': {
      url: 'https://maps.iredellcountync.gov/server/rest/services/Data/TaxSQL_Parcels/MapServer/0/query',
      field: 'PIN', key: a => String(a).replace(/\D/g, '').slice(0, 10) + '.000', batch: 50,
      out: 'PIN,Name,DeedDate,Sales_Price',
      rec: a => ({ k: a.PIN, owner: a.Name || '', sale: ymd(a.DeedDate), price: a.Sales_Price })
    },
    'CABARRUS|NC': {
      url: 'https://location.cabarruscounty.us/arcgisservices/rest/services/opendata/MapServer/46/query',
      field: 'PIN14', key: a => String(a).replace(/\D/g, '').padEnd(14, '0'), batch: 50,
      out: 'PIN14,AcctName1,AcctName2,SaleYear,SaleMonth,SalePrice',
      rec: a => ({ k: a.PIN14, owner: join(a.AcctName1, a.AcctName2), sale: a.SaleYear ? new Date(a.SaleYear, (a.SaleMonth || 1) - 1, 15) : null, price: a.SalePrice })
    },
    'ROWAN|NC': {
      url: 'https://gis.rowancountync.gov/arcgis/rest/services/Public/RowanTaxParcels/MapServer/0/query',
      field: 'PARCEL_ID', key: a => String(a).trim().toUpperCase(),
      out: 'PARCEL_ID,OWNNAME,OWN2,DATESOLD,SALE_AMT',
      rec: a => ({ k: String(a.PARCEL_ID || '').trim(), owner: join(a.OWNNAME, a.OWN2), sale: ep(a.DATESOLD), price: a.SALE_AMT })
    },
    'BRUNSWICK|NC': {
      url: 'https://bcgis.brunswickcountync.gov/arcgis/rest/services/Layers/TaxParcels/MapServer/0/query',
      field: 'ParcelNumber', key: a => String(a).trim().toUpperCase(),
      out: 'ParcelNumber,Name1,Name2,DeedDate',
      rec: a => ({ k: a.ParcelNumber, owner: join(a.Name1, a.Name2), sale: a.DeedDate ? new Date(a.DeedDate) : null, price: null })
    },
    'ONSLOW|NC': {
      url: 'https://gismaps.onslowcountync.gov/server/rest/services/WEB_PUBLICATIONS/County_Map_Layers/MapServer/0/query',
      field: 'PARID', key: a => String(a).replace(/\D/g, '').padStart(6, '0'),
      out: 'PARID,OWNER1,OWNER2,SALEDATE,SALEPRICE',
      rec: a => { let d = null; if (a.SALEDATE) { const [dd, mm, yy] = a.SALEDATE.split('-'); d = new Date((+yy > 30 ? 1900 : 2000) + +yy, MON[mm], +dd); } return { k: a.PARID, owner: join(a.OWNER1, a.OWNER2), sale: d, price: a.SALEPRICE }; }
    },
    'YORK|SC': {
      url: 'https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Parcels/FeatureServer/0/query',
      field: 'ParcelID', key: a => String(a).replace(/\D/g, ''),
      out: 'ParcelID,Owner1,Owner2,DateSold',
      rec: a => ({ k: a.ParcelID, owner: join(a.Owner1, a.Owner2), sale: ep(a.DateSold), price: null })
    }
  };
  // Union's public map has no owner names, only a qualified-sales table (grantor/grantee). A sale found
  // there removes the record; no sale found leaves it "unverified" (non-qualified transfers aren't listed).
  const UNION_SALES = 'https://gis.unioncountync.gov/server/rest/services/Property_Tax_Live/Platted_Parcels/MapServer/1/query';
  const STOP = new Set(['THE', 'INC', 'LLC', 'AND', 'TRUST', 'TRUSTEE', 'TRUSTEES', 'ESTATE', 'REVOCABLE', 'LIVING', 'FAMILY', 'HEIRS', 'LIFE', 'ETAL', 'ETUX', 'JR', 'SR', 'III', 'MRS', 'MR', 'CO', 'OF']);
  const toks = s => String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !STOP.has(t));
  const nameMatch = (lead, owner) => {
    const O = String(owner || '').toUpperCase(); const L = [lead.full_name, lead.first_name, lead.last_name].filter(Boolean).join(' ');
    const lt = toks(lead.last_name || lead.full_name).length ? toks(lead.last_name || lead.full_name) : toks(L);
    if (!lt.length) return true;
    if (lt.some(t => O.includes(t))) return true;
    const flat = L.toUpperCase().replace(/[^A-Z]/g, ''); // "Desouza" vs "DE SOUZA", "Dehernandez" vs "HERNANDEZ"
    return toks(O).some(t => t.length > 3 && flat.includes(t));
  };
  const INSTITUTION = /\b(BANK|TRUST COMPANY|MORTGAGE|FEDERAL|FANNIE|FREDDIE|SECRETARY OF HOUSING|HUD|VETERANS|CREDIT UNION|LLC|INC|CORP|HOMES|PROPERTIES|HOLDINGS|BUILDERS|DEVELOPMENT|INVESTMENTS?|PARTNERS|COUNTY OF|CITY OF|STATE OF)\b/i;
  const ESTATE_TAGS = /estate|inherit|heir|probate|deceased/i;

  async function query(cfg, keys) {
    const out = {}; const size = cfg.batch || 100;
    for (let i = 0; i < keys.length; i += size) {
      const where = `${cfg.field} in ('${keys.slice(i, i + size).map(k => k.replace(/'/g, "''")).join("','")}')`;
      const url = `${cfg.url}?where=${encodeURIComponent(where)}&outFields=${cfg.out}&returnGeometry=false&f=json`;
      let j, err;
      for (let tries = 0; tries < 3 && !j; tries++) { // county servers are slow sometimes: retry twice
        try { j = cfg.jsonp ? await jsonp(url, 30000) : await fetchJSON(url, 30000); if (j.error) { err = new Error(j.error.message || 'county query failed'); j = null; } }
        catch (e) { err = new Error(e.name === 'AbortError' ? 'timed out' : e.message); }
        if (!j && tries < 2) await new Promise(r => setTimeout(r, 1500));
      }
      if (!j) throw err || new Error('county query failed');
      for (const f of j.features || []) { const r = cfg.rec(f.attributes); out[String(r.k).trim()] = r; }
    }
    return out;
  }

  // records: [{lead:{full_name,first_name,last_name,tags,created_at}, prop:{apn,county,state}}]
  async function run(records, opts = {}) {
    const res = new Array(records.length); const groups = {};
    records.forEach((r, i) => {
      // Not a property mailing (e.g. letters to estate attorneys): nothing to check against the county.
      if (!r.prop || (!r.prop.apn && !r.prop.address)) { res[i] = { status: 'ok', reason: 'No property on this record (not a property mailing)' }; return; }
      const st = String(r.prop?.state || '').toUpperCase() || 'NC'; const co = String(r.prop?.county || '').replace(/ county$/i, '').trim().toUpperCase();
      (groups[co + '|' + st] = groups[co + '|' + st] || []).push(i);
    });
    const now = Date.now(); let done = 0; const total = records.length;
    const tick = n => { done += n; opts.onProgress && opts.onProgress(done, total); };
    tick(res.filter(Boolean).length);
    for (const [g, idx] of Object.entries(groups)) {
      const cfg = COUNTIES[g]; const county = g.split('|')[0];
      const titled = county ? county[0] + county.slice(1).toLowerCase() : 'Unknown';
      if (g === 'UNION|NC') {
        try {
          const keys = {}; idx.forEach(i => { const a = String(records[i].prop?.apn || ''); keys[a.trim()] = 1; keys[a.replace(/\D/g, '')] = 1; });
          const ks = Object.keys(keys).filter(Boolean); const sales = {};
          for (let i = 0; i < ks.length; i += 80) {
            const where = `parcel_number in ('${ks.slice(i, i + 80).join("','")}')`;
            const j = await fetchJSON(`${UNION_SALES}?where=${encodeURIComponent(where)}&outFields=parcel_number,date_of_sale,grantor,grantee,net_selling_price&returnGeometry=false&f=json`);
            if (j.error) throw new Error(j.error.message);
            for (const f of j.features || []) { const a = f.attributes; const p = a.parcel_number; if (!sales[p] || a.date_of_sale > sales[p].date_of_sale) sales[p] = a; }
          }
          idx.forEach(i => {
            const a = String(records[i].prop?.apn || ''); const s = sales[a.trim()] || sales[a.replace(/\D/g, '')];
            if (s && !nameMatch(records[i].lead || {}, s.grantee)) res[i] = { status: 'sold', reason: `Union County: sold ${new Date(s.date_of_sale).toLocaleDateString()} to ${s.grantee}`, owner: s.grantee, sale: new Date(s.date_of_sale), price: s.net_selling_price };
            else res[i] = { status: 'unverified', reason: 'Union County only publishes qualified sales, not current owners; no sale found' };
          });
        } catch (e) { idx.forEach(i => res[i] = { status: 'unverified', reason: 'Union County site did not answer: ' + e.message }); }
        tick(idx.length); continue;
      }
      if (!cfg) { idx.forEach(i => res[i] = { status: 'unverified', reason: `${titled} County isn't connected to the owner check yet` }); tick(idx.length); continue; }
      let cur;
      try { cur = await query(cfg, [...new Set(idx.map(i => cfg.key(records[i].prop?.apn || '')))]); }
      catch (e) { idx.forEach(i => res[i] = { status: 'unverified', reason: `${titled} County site did not answer (${e.message})` }); tick(idx.length); continue; }
      idx.forEach(i => {
        const r = records[i]; const c = cur[cfg.key(r.prop?.apn || '')];
        if (!c) { res[i] = { status: 'unverified', reason: `Parcel ${r.prop?.apn || '(none)'} not found in ${titled} County records` }; return; }
        const base = { owner: c.owner, sale: c.sale, price: c.price };
        if (nameMatch(r.lead || {}, c.owner)) { res[i] = { status: 'ok', ...base }; return; }
        const recent = c.sale && (now - c.sale.getTime()) < 730 * DAY;
        const deed = c.sale ? ` (deed ${c.sale.toLocaleDateString()}${c.price ? ', $' + Number(c.price).toLocaleString() : ''})` : '';
        const heir = opts.estateCampaign || ESTATE_TAGS.test([].concat(r.lead?.tags || []).join(' '));
        if (heir && !recent && !INSTITUTION.test(c.owner)) { res[i] = { status: 'heir', reason: `County owner is ${c.owner}; letter goes to the heir / PR`, ...base }; return; }
        if (recent || INSTITUTION.test(c.owner)) res[i] = { status: 'sold', reason: `${titled} County: now owned by ${c.owner}${deed}`, ...base };
        else res[i] = { status: 'changed', reason: `${titled} County: owner is ${c.owner}${deed}, not the name on our list`, ...base };
      });
      tick(idx.length);
    }
    return res;
  }
  window.OwnerCheck = { run, COUNTIES, nameMatch };
})();
