// Marketing package for a buyer deal (Nov 2026).
// Builds the emoji builder email from the deal: price, highlights from the Land id DD note, the Land id tour link,
// the Land id pictures saved on the deal, a Street View link, and the BCC lists (24-hour First Look + full list).
// Damien reviews it here; Claude then makes the two Gmail drafts (never sends) with the pictures inside the email.
(function () {
  const $ = id => document.getElementById(id);
  const E = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = n => n == null || n === '' || isNaN(n) ? '' : '$' + Math.round(+n).toLocaleString();
  const low = s => String(s || '').toLowerCase().replace(/\bcounty\b|[^a-z ]/g, '').trim();
  const PHONE = '(980) 217-8806';
  // Google Street View Static API key (restricted to landiq.land and to Street View Static only)
  const GSV_KEY = 'AIzaSyCHG1JzCEQPljj9LSGtEQrubQl8VgX-GmU';
  const bearing = (a, b) => { const r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r), x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r); return Math.round((Math.atan2(y, x) / r + 360) % 360); };
  // find the nearest street-side photo and point the camera at the lot; saves it to the deal's files
  async function streetPhoto(dealId, propId, label, lot) {
    const m = await (await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${lot.lat},${lot.lng}&radius=120&source=outdoor&key=${GSV_KEY}`)).json();
    if (m.status !== 'OK') return { ok: false, why: m.status };
    const h = bearing(m.location, lot);
    const blob = await (await fetch(`https://maps.googleapis.com/maps/api/streetview?size=640x420&scale=2&pano=${m.pano_id}&heading=${h}&fov=80&key=${GSV_KEY}`)).blob();
    const name = `${label} - Google Street View${m.date ? ' (' + m.date + ')' : ''}`, path = `${dealId}/${Date.now()}-${name.replace(/[^\w.\- ()]+/g, '_')}.jpg`;
    const up = await sb.storage.from('deal-files').upload(path, blob, { contentType: 'image/jpeg' }); if (up.error) return { ok: false, why: up.error.message };
    await sb.from('deal_files').insert({ deal_id: dealId, property_id: propId, name, storage_path: path, source: 'hq' });
    return { ok: true, name };
  }
  async function addStreetView(dealId) {
    const { data: d } = await sb.from('deals').select('property_id,extra_property_ids,as_meta,properties(id,apn,address,lat,lng,county,state)').eq('id', dealId).single();
    const ps = [d.properties, ...((d.extra_property_ids || []).length ? ((await sb.from('properties').select('id,apn,address,lat,lng,county,state').in('id', d.extra_property_ids)).data || []) : [])].filter(Boolean);
    const msg = []; for (const p of ps) {
      let lot = p.lat && p.lng ? { lat: +p.lat, lng: +p.lng } : null;
      if (!lot && p.apn && (p.state || 'NC') === 'NC') { const raw = String(p.apn).replace(/[^0-9A-Za-z]/g, ''); const q = await (await fetch('https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1/query', { method: 'POST', body: new URLSearchParams({ where: `UPPER(cntyname)='${String(p.county || '').replace(/\s+county$/i, '').toUpperCase().replace(/'/g, '')}' AND (parno='${raw}' OR altparno='${String(p.apn).replace(/'/g, '')}')`, returnGeometry: 'true', returnCentroid: 'true', outSR: '4326', outFields: 'parno', f: 'json', resultRecordCount: '1' }) })).json(); const g = q.features?.[0]; const ring = g?.geometry?.rings?.[0]; if (ring) lot = { lat: ring.reduce((s, c) => s + c[1], 0) / ring.length, lng: ring.reduce((s, c) => s + c[0], 0) / ring.length }; }
      if (!lot) { msg.push((p.address || p.apn) + ': no map location'); continue; }
      const r = await streetPhoto(dealId, p.id, p.address || ('Parcel ' + p.apn), lot); msg.push((p.address || p.apn) + ': ' + (r.ok ? 'saved' : 'no Street View here (' + r.why + ')'));
    }
    return msg;
  }

  // pull the Land id facts out of the "Claude Land id DD" note (first parcel block = the main lot)
  function ddFacts(notes, apn) {
    const t = String(notes || ''); const i = t.indexOf('LAND ID DUE DILIGENCE'); if (i < 0) return {};
    const body = t.slice(i, t.indexOf('\nClaude ', i + 10) > 0 ? t.indexOf('\nClaude ', i + 10) : undefined);
    const blocks = body.split(/\n(?=\d{3,6} [^\n]* - parcel )/);
    const blk = blocks.find(b => apn && b.includes(apn)) || blocks[1] || body;
    const g = re => (blk.match(re) || [])[1];
    return {
      free: g(/Buildable: ([\d,]+) sq ft builds freely/), plan: g(/\+([\d,]+) sq ft with planning/),
      slopeAvg: g(/Slope: average (\d+)%/), slopeMax: g(/max (\d+)%/),
      floodway: g(/Flood: ([\d.]+)% floodway/), noFlood: g(/([\d.]+)% no floodplain/),
      utilities: /public water and sewer/i.test(blk) ? 'Public water & sewer' : '',
      house: /HOUSE ON THIS LOT/i.test(blk),
      tours: [...body.matchAll(/https:\/\/id\.land\/tour\/[\w-]+/g)].map(m => m[0])
    };
  }

  function priceBand(p) { p = +p || 0; return p < 50000 ? 'Under $50k' : p < 100000 ? '$50k to $100k' : p < 200000 ? '$100k to $200k' : p < 400000 ? '$200k to $400k' : '$400k+'; }
  function sizeBand(a) { a = +a || 0; return a < 0.25 ? 'Under 1/4 acre' : a < 0.5 ? '1/4 to 1/2 acre' : a < 1 ? '1/2 to 1 acre' : a < 5 ? '1 to 5 acres' : '5+ acres'; }
  const okStatus = b => b.email && !/bounced|removed|stopped/i.test(b.bb_status || '');
  const firstEmail = b => String(b.email || '').split(/[;,\s]+/)[0].toLowerCase();

  // First Look = buy-box form buyers whose area, price and lot size fit (empty field = no limit)
  function firstLook(buyers, p, price) {
    const co = low(p.county), city = low(p.city), pb = priceBand(price), sb_ = sizeBand(p.acres);
    return buyers.filter(b => b.bb_submitted_at && okStatus(b)).map(b => {
      const cs = (b.counties || []).map(low), ci = (b.cities || []).map(low);
      const blanket = (b.cities || []).some(x => /area|hour|too many|all /i.test(x));
      const area = (!cs.length && !ci.length) || cs.some(c => c && (c === co || c.startsWith(co) || co.startsWith(c))) || (city && ci.includes(city)) || blanket;
      const priceOk = !(b.price_ranges || []).length || (b.price_ranges || []).includes(pb);
      const sizeOk = !(b.lot_sizes || []).length || (b.lot_sizes || []).includes(sb_);
      const typeOk = !b.lot_type || /vacant|both/i.test(b.lot_type);
      return area && priceOk && sizeOk && typeOk ? { b, why: [area ? 'area' : '', 'price ' + pb, 'size ' + sb_].filter(Boolean).join(' · ') } : null;
    }).filter(Boolean);
  }

  function emailHTML(x, first) {
    const hl = x.highlights.split('\n').map(s => s.trim()).filter(Boolean);
    const pics = x.pics.map((u, i) => `<p style="margin:10px 0"><img src="${E(u.url)}" alt="${E(u.name)}" style="max-width:100%;border-radius:8px"><br><span style="font-size:12px;color:#666">${E(u.name.replace(/^.* - /, ''))}</span></p>`).join('');
    return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">
<p>Hi there,</p>
${first ? '<p>Because you took the time to fill out our buy-box form, you\'re getting a 24-hour first look at this lot before it goes out to our full buyers list.</p>' : ''}
<p>I specialize in sourcing lots for builders, and I have a new ${E(x.kindWord)} in ${E(x.city)} that I wanted to put in front of you first. 👇</p>
<p style="font-size:19px"><b>🏡 ${E(x.address)}</b><br><span style="font-size:13px;color:#666">${E(x.countyLine)}</span></p>
<p style="font-size:24px"><b>💰 Asking Price: ${E(money(x.price))}</b></p>
<p><b>✅ Quick Highlights</b></p><ul>${hl.map(h => `<li>${E(h)}</li>`).join('')}</ul>
${pics}
${x.tour ? `<p>🗺️ Full property details, boundaries &amp; maps:<br>👉 <a href="${E(x.tour)}">View the Land id property tour</a></p>` : ''}
${x.street ? `<p>📍 <a href="${E(x.street)}">See it on Google Street View</a></p>` : ''}
<p>📲 Interested? Reply to this email or call/text ${PHONE}.</p>
<p>Warm regards,<br>Damien Dupee<br>Dominion Land Group<br>1235 East Boulevard, C1 #424<br>Charlotte, NC 28203<br>📞 ${PHONE}</p></div>`;
  }

  async function open(dealId) {
    const { data: d, error } = await sb.from('deals').select('*, properties(*)').eq('id', dealId).single(); if (error) return toast(error.message);
    const p = d.properties || {}; const mp = d.as_meta?.mp || {};
    const f = ddFacts(d.notes, p.apn);
    const xp = (d.extra_property_ids || []).length ? ((await sb.from('properties').select('id,apn,address,acres').in('id', d.extra_property_ids)).data || []) : [];
    const price = d.as_meta?.marketing_price ?? mp.price ?? d.assignment_price ?? ''; // Deal terms → Marketing price first
    const acres = [p.acres, ...xp.map(x => x.acres)].filter(Boolean).reduce((s, a) => s + +a, 0);
    const hl = mp.highlights || [
      acres ? `📐 ${xp.length ? (xp.length + 1) + ' parcels, ' : ''}${(+acres).toFixed(2)} acres total` : '',
      f.utilities ? '💧🚽 ' + f.utilities : '',
      f.free ? `🏗️ About ${f.free} sq ft buildable${f.plan ? ` (+${f.plan} sq ft with planning)` : ''} per Land id` : '',
      f.slopeAvg ? `⛰️ Average slope ${f.slopeAvg}%${f.slopeMax ? ` (max ${f.slopeMax}%)` : ''}` : '',
      f.floodway != null ? (+f.floodway > 0 ? `🌊 FEMA floodway on part of the lot (${f.floodway}%); ${f.noFlood || '?'}% outside any flood zone` : '🌊 No FEMA flood zone') : '',
      f.house ? '🏚️ Existing house on one parcel (teardown)' : '',
      p.zoning ? '📋 Zoning ' + p.zoning : ''
    ].filter(Boolean).join('\n');
    const center = d.as_meta?.lot_center || (p.lat && p.lng ? { lat: p.lat, lng: p.lng } : null);
    const addr = [p.address, p.city, p.state, p.zip].filter(Boolean).join(', ');
    const street = center ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${center.lat},${center.lng}` : (addr ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr) : '');
    const { data: files } = await sb.from('deal_files').select('id,name,storage_path').eq('deal_id', dealId).order('created_at');
    const imgs = (files || []).filter(x => /\.(jpe?g|png|webp)$/i.test(x.storage_path));
    const pick = mp.images || imgs.filter(x => /Land id|Street View/i.test(x.name)).map(x => x.id);
    const signed = {}; for (const x of imgs) { const s = await sb.storage.from('deal-files').createSignedUrl(x.storage_path, 3600); if (s.data) signed[x.id] = s.data.signedUrl; }
    // full buyer rows (buy-box fields) for the BCC lists
    const buyers = []; for (let o = 0; ; o += 1000) { const r = await sb.from('buyers').select('id,name,company,email,kind,bb_status,bb_submitted_at,counties,cities,price_ranges,lot_sizes,lot_type,utilities').order('id').range(o, o + 999); if (r.error || !r.data?.length) break; buyers.push(...r.data); if (r.data.length < 1000) break; }
    window._MP = { d, p, xp, imgs, signed, buyers, street, f };
    window._wideNext = true; openDrawer(`<div class="dhead"><h2 style="margin:0">📣 Marketing package</h2><div class="row" style="flex:0 0 auto;gap:8px"><button class="btn ghost" onclick="openDeal(${dealId})">← Back to deal</button><button class="btn ghost" onclick="closeDrawer()">Close</button></div></div>
      <div class="card"><div class="small muted" style="margin-bottom:8px">Fill or fix anything below, then Save. Claude turns this into two Gmail drafts (24-hour First Look, then the full list) with the pictures inside the email. Nothing is sent until you press Send in Gmail.</div>
      <label class="f">Asking price to builders $ <span class="small muted">(from Deal terms → Marketing price)</span></label><input id="mp_price" type="number" value="${E(price)}" placeholder="e.g. 25000" oninput="MP.preview()">
      <label class="f">Street address line</label><input id="mp_addr" value="${E(mp.address || p.address || d.property_label || '')}" oninput="MP.preview()">
      <label class="f">City</label><input id="mp_city" value="${E(mp.city || p.city || '')}" oninput="MP.preview()">
      <label class="f">Quick highlights (one per line, start each with an emoji)</label><textarea id="mp_hl" style="min-height:120px" oninput="MP.preview()">${E(hl)}</textarea>
      <label class="f">Land id tour link</label><input id="mp_tour" value="${E(mp.tour || f.tours?.[0] || '')}" placeholder="https://id.land/tour/..." oninput="MP.preview()">
      ${(f.tours || []).length > 1 ? `<div class="small muted">Other tours in the notes: ${f.tours.slice(1).map(t => `<a href="${E(t)}" target="_blank" rel="noopener">${E(t.slice(-8))}</a>`).join(' · ')}</div>` : ''}
      <label class="f">Street View</label><div class="small">${street ? `<a href="${E(street)}" target="_blank" rel="noopener">📍 Open Street View</a> (goes in the email as a link)` : 'No location on file'} · <a href="#" onclick="MP.sv(${dealId});return false">📷 Add Street View photos to the pictures</a> <span id="mp_sv" class="muted"></span></div>
      <label class="f">Pictures in the email</label>${imgs.length ? imgs.map(x => `<label class="small" style="display:flex;gap:8px;align-items:center;margin:4px 0"><input type="checkbox" style="width:auto" class="mp_img" value="${x.id}" ${pick.includes(x.id) ? 'checked' : ''} onchange="MP.preview()">${signed[x.id] ? `<img src="${E(signed[x.id])}" style="width:80px;height:56px;object-fit:cover;border-radius:4px">` : ''} ${E(x.name)}</label>`).join('') : '<div class="small muted">No pictures on this deal yet. Run DD / Comps saves the Land id pictures here.</div>'}
      <div id="mp_bcc" class="small" style="margin-top:12px"></div>
      <div class="row" style="margin-top:12px;gap:8px"><button class="btn" id="mp_save" onclick="MP.save(${dealId})">Save package &amp; ask Claude for the drafts</button><button class="btn ghost" onclick="MP.copy()">Copy email</button></div>
      <div id="mp_msg" class="small" style="margin-top:6px"></div></div>
      <div class="card"><h3 class="sec" style="margin-top:0">Preview</h3><div class="small muted" id="mp_subj"></div><div id="mp_prev" style="border:1px solid var(--line);border-radius:8px;padding:12px;background:#fff"></div></div>`);
    preview();
  }

  function state() {
    const M = window._MP, p = M.p;
    const pics = [...document.querySelectorAll('.mp_img:checked')].map(c => { const x = M.imgs.find(i => String(i.id) === c.value); return { id: x.id, name: x.name, url: M.signed[x.id] || '' }; });
    const price = $('mp_price').value === '' ? null : +$('mp_price').value;
    const isHouse = M.f.house && !M.xp.length;
    return { price, address: $('mp_addr').value.trim(), city: $('mp_city').value.trim(), highlights: $('mp_hl').value, tour: $('mp_tour').value.trim(), street: M.street, pics,
      kindWord: isHouse ? 'teardown lot' : 'infill lot', countyLine: [p.county ? p.county + ' County' : '', p.apn ? 'Parcel ' + p.apn : '', ...M.xp.map(x => 'Parcel ' + x.apn)].filter(Boolean).join(' · ') };
  }
  function preview() {
    const M = window._MP; if (!M || !$('mp_prev')) return; const x = state();
    const st = M.p.state || 'NC', subj = `🏡 New Builder Lot | ${x.address}, ${x.city} ${st} | ${money(x.price) || '$—'}`;
    $('mp_subj').innerHTML = `<b>First Look subject:</b> 👀 First Look (24 hrs) | ${E(x.address)}, ${E(x.city)} ${E(st)} | ${E(money(x.price) || '$—')}<br><b>Full list subject:</b> ${E(subj)}`;
    $('mp_prev').innerHTML = emailHTML(x, true);
    const fl = firstLook(M.buyers, { county: M.p.county, city: x.city || M.p.city, acres: M.p.acres }, x.price);
    const flE = new Set(fl.map(o => firstEmail(o.b)));
    const all = [...new Set(M.buyers.filter(okStatus).map(firstEmail))].filter(e => e && !flE.has(e));
    M.fl = [...flE]; M.full = all;
    $('mp_bcc').innerHTML = `<b>👀 First Look BCC (${fl.length})</b> — buy-box form buyers that fit ${E(M.p.county || '')} County, ${E(priceBand(x.price))}, ${E(sizeBand(M.p.acres))}:<br>${fl.map(o => E((o.b.company || o.b.name || '') + ' <' + firstEmail(o.b) + '>')).join(', ') || '<span class="muted">nobody fits yet; the deal goes straight to the full list</span>'}
      <br><b>📬 Full list BCC (next day):</b> ${all.length} DLG HQ buyers, plus your NC Buyers List (Claude adds it and drops clear buy-box mismatches).
      ${x.price ? '' : '<br><b style="color:var(--red)">Add the asking price.</b>'}`;
  }
  async function save(dealId) {
    const x = state(); if (!x.price) return toast('Add the asking price first');
    const btn = $('mp_save'); btn.disabled = true;
    const { data: cur } = await sb.from('deals').select('as_meta').eq('id', dealId).single();
    const mp = { price: x.price, address: x.address, city: x.city, highlights: x.highlights, tour: x.tour, street: x.street, images: x.pics.map(p => p.id), first_look: window._MP.fl, requested_at: new Date().toISOString() };
    const { error } = await sb.from('deals').update({ as_meta: { ...(cur?.as_meta || {}), mp } }).eq('id', dealId);
    btn.disabled = false; if (error) return toast(error.message);
    $('mp_msg').innerHTML = `<b style="color:#1d7a3a">Saved.</b> Tell Claude "make the marketing drafts for ${E(x.address)}". You'll get the First Look draft (${window._MP.fl.length} BCC) and the full-list draft in Gmail with the pictures in the email. Nothing sends until you press Send.`;
  }
  async function copy() {
    const x = state(); const html = emailHTML(x, false);
    try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([document.getElementById('mp_prev').innerText], { type: 'text/plain' }) })]); toast('Email copied. Paste it into Gmail.'); }
    catch (e) { toast('Copy failed: ' + e.message); }
  }
  async function sv(dealId) { const el = $('mp_sv'); if (el) el.textContent = 'Getting Street View…'; try { const m = await addStreetView(dealId); toast(m.join(' · ')); open(dealId); } catch (e) { if (el) el.textContent = 'Street View failed: ' + e.message; } }
  window.MP = { open, preview, save, copy, ddFacts, firstLook, sv, addStreetView };
})();
