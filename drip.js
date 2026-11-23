// DLG HQ - Builder Texts: the buy-box text drip (sql/builder_drip.sql + supabase/functions/builder-drip).
// The DLG Builder Hub's "Start texts" button opens landiq.land/?drip_add=<json>#drip; this page shows the builder
// and Damien presses Start texts to confirm. Texts go out from (980) 217-8806, weekdays 9-6 Eastern, day 0/3/7/14,
// and stop on any reply, STOP, a buy box submission, or the suppression list.
(function () {
  const d10 = p => String(p || '').replace(/\D/g, '').slice(-10);
  const fmt = p => { const d = d10(p); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || ''); };
  const when = t => t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  const LABEL = { active: 'Texting', paused: 'Paused', replied: 'Replied', stopped: 'Stopped', buybox: 'Filled out buy box', done: 'All 4 sent', error: 'Error' };

  // pick up a builder handed over from the Builder Hub (kept until Damien starts or skips it)
  try {
    const q = new URLSearchParams(location.search).get('drip_add');
    if (q) { sessionStorage.setItem('drip_add', q); history.replaceState(null, '', location.pathname + (location.hash || '#drip')); }
  } catch (e) { }
  function pending() { try { const s = sessionStorage.getItem('drip_add'); return s ? JSON.parse(s) : null; } catch (e) { return null; } }

  window.vDrip = async function () {
    const v = $('view'); v.innerHTML = '<div class="card muted">Loading builder texts…</div>';
    const { data: rows, error } = await sb.from('builder_drip').select('*').order('enrolled_at', { ascending: false });
    if (error) { v.innerHTML = '<div class="card">Builder Texts isn\'t set up yet: run <b>sql/builder_drip.sql</b> in Supabase and deploy the <b>builder-drip</b> edge function. (' + esc(error.message) + ')</div>'; return; }
    const p = pending();
    const have = p && rows.find(r => d10(r.phone) === d10(p.phone));
    const add = p ? `<div class="card" style="border-left:4px solid var(--acc,#d9601a)">
      <h3 style="margin:0 0 6px">Start texts to ${esc(p.company || '')}?</h3>
      ${have ? `<p>This number is already in Builder Texts (${esc(LABEL[have.status] || have.status)}).</p><button class="btn" onclick="dripSkip()">OK</button>` : `
      <p class="muted" style="margin:0 0 8px">4 texts from (980) 217-8806: today, then day 3, day 7 and day 14, weekdays 9-6. Stops when they reply, text STOP or fill out the buy box. More than one person at this builder? Start texts again with the other number; when anyone at the company replies, every number stops.</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:end">
        <label>First name<br><input id="dpFirst" value="${esc(p.first || '')}" placeholder="blank = Hi there"></label>
        <label>Phone<br><input id="dpPhone" value="${esc(fmt(p.phone))}"></label>
        <label>County<br><input id="dpCounty" value="${esc(p.county || '')}"></label>
      </div>
      <p class="muted" style="margin:8px 0">First text: <i id="dpPrev"></i></p>
      <label style="display:flex;gap:6px;align-items:center;margin:0 0 10px"><input type="checkbox" id="dpOk"> I confirmed this number is the builder (not a landlord or someone sharing the office)</label>
      <button class="btn primary" onclick="dripStart()">Start texts</button> <button class="btn" onclick="dripSkip()">Not now</button>`}</div>` : '';
    const live = rows.filter(r => r.status === 'active').length;
    v.innerHTML = add + `<div class="card"><h3 style="margin:0 0 4px">Builder Texts</h3>
      <p class="muted" style="margin:0 0 10px">${live} texting now · ${rows.filter(r => r.status === 'replied').length} replied · ${rows.filter(r => r.status === 'buybox').length} filled out the buy box. Replies land in the Buyer Inbox.</p>
      ${rows.length ? `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Builder</th><th>Phone</th><th>County</th><th>Status</th><th>Texts sent</th><th>Next text</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><b>${esc(r.company)}</b>${r.first_name ? '<br><span class="muted">' + esc(r.first_name) + '</span>' : ''}</td><td>${esc(fmt(r.phone))}</td><td>${esc(r.county || '')}</td>
        <td>${esc(LABEL[r.status] || r.status)}${r.stop_reason ? '<br><span class="muted">' + esc(r.stop_reason) + '</span>' : ''}${r.last_error ? '<br><span style="color:#b4433a">' + esc(r.last_error) + '</span>' : ''}</td>
        <td>${r.step} of 4</td><td>${r.status === 'active' ? esc(when(r.next_at)) : '—'}</td>
        <td style="white-space:nowrap">${r.status === 'active' ? `<button class="btn sm" onclick="dripSet(${r.id},'paused')">Pause</button>` : ''}${r.status === 'paused' || r.status === 'error' ? `<button class="btn sm" onclick="dripSet(${r.id},'active')">Resume</button>` : ''}${['active', 'paused', 'error'].includes(r.status) ? ` <button class="btn sm" onclick="dripSet(${r.id},'stopped')">Stop</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No builders yet. In the DLG Builder Hub, open a builder and press <b>Start texts</b>.</p>'}</div>`;
    const prev = () => { const e = $('dpPrev'); if (!e) return; const f = ($('dpFirst').value || '').trim() || 'there', c = ($('dpCounty').value || '').trim(); e.textContent = `Hi ${f}, this is Damien with Dominion Land Group. I specialize in sourcing lots for builders in ${c ? c + ' County' : 'your area'}. Are you currently buying more lots? If so, can you fill out my buy box form so I can get to hunting ASAP? dominionlandgroup.land/buybox Reply STOP to unsubscribe`; };
    ['dpFirst', 'dpCounty'].forEach(id => { const e = $(id); if (e) e.oninput = prev; }); prev();
  };
  window.dripSkip = function () { try { sessionStorage.removeItem('drip_add'); } catch (e) { } vDrip(); };
  window.dripStart = async function () {
    const p = pending(); if (!p) return;
    if (!$('dpOk').checked) return toast('Check the box once you know this number is the builder');
    const phone = d10($('dpPhone').value); if (phone.length !== 10) return toast('Enter a 10-digit phone');
    const { error } = await sb.from('builder_drip').insert({ company: p.company, first_name: ($('dpFirst').value || '').trim() || null, phone, county: ($('dpCounty').value || '').trim() || null, notes: p.source || null });
    if (error) return toast(/duplicate|unique/i.test(error.message) ? 'That number is already in Builder Texts' : error.message);
    try { sessionStorage.removeItem('drip_add'); } catch (e) { }
    toast('Started. First text goes out within 30 minutes (weekdays 9-6).'); vDrip();
  };
  window.dripSet = async function (id, status) {
    const patch = { status }; if (status === 'stopped') patch.stop_reason = 'Stopped by Damien'; if (status === 'active') { patch.last_error = null; patch.next_at = new Date().toISOString(); }
    const { error } = await sb.from('builder_drip').update(patch).eq('id', id); if (error) return toast(error.message); vDrip();
  };
})();
