// DLG HQ - Weekly Scorecard. Reads existing data (campaigns, messages, leads, transactions, deals, split_parcels, properties).
// Weeks start Monday (America/New_York). Kept lots and notes are properties tagged 'portfolio-lot' / 'note'
// (note fields live in properties.fields: note_balance, note_payment, note_rate).
(function () {
  const TZ = 'America/New_York';
  const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));
  function weekStart(d) { const x = new Date(ymd(d) + 'T12:00:00'); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return x.toISOString().slice(0, 10); }
  const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n || 0)).toLocaleString();
  async function all(q) { const out = []; for (let f = 0; ; f += 1000) { const { data, error } = await q().range(f, f + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break; } return out; }

  window.vScorecard = async function () {
    $('view').innerHTML = '<div class="card muted">Loading scorecard…</div>';
    const WEEKS = 12; const now = new Date(); const weeks = [];
    for (let i = WEEKS - 1; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - 7 * i); weeks.push(weekStart(d)); }
    const since = weeks[0];
    const [camps, msgs, leads, tx, deals, splits, props] = await Promise.all([
      all(() => sb.from('campaigns').select('channel,records,drop_date,cost').gte('drop_date', since)),
      all(() => sb.from('messages').select('channel,direction,duration_s,inbox,created_at').gte('created_at', since)),
      all(() => sb.from('leads').select('status,created_at').gte('created_at', since)),
      all(() => sb.from('transactions').select('kind,price,costs,tx_date,deal_id')),
      all(() => sb.from('deals').select('id,rs_sent_at,rs_signed_at,board').or(`rs_sent_at.gte.${since},rs_signed_at.gte.${since}`)),
      all(() => sb.from('split_parcels').select('my_status')),
      all(() => sb.from('properties').select('id,address,apn,county,tags,fields').overlaps('tags', ['portfolio-lot', 'note'])),
    ]);
    const Z = () => Object.fromEntries(weeks.map(w => [w, 0]));
    const R = { mail: Z(), mailCost: Z(), calls: Z(), convos: Z(), replies: Z(), leads: Z(), offers: Z(), contracts: Z(), closings: Z(), profit: Z() };
    const add = (k, d, v = 1) => { if (!d) return; const w = weekStart(d); if (w in R[k]) R[k][w] += v; };
    for (const c of camps) if (c.channel === 'mail') { add('mail', c.drop_date + 'T12:00:00', c.records || 0); add('mailCost', c.drop_date + 'T12:00:00', Number(c.cost) || 0); }
    for (const m of msgs) {
      if (m.channel === 'call') { add('calls', m.created_at); if ((m.duration_s || 0) >= 60) add('convos', m.created_at); }
      else if (m.direction === 'in' && m.inbox === 'seller') add('replies', m.created_at);
    }
    for (const l of leads) if (l.status !== 'record') add('leads', l.created_at);
    for (const d of deals) { add('offers', d.rs_sent_at); add('contracts', d.rs_signed_at); }
    const buyBy = {}; for (const t of tx) if (t.kind === 'purchase' && t.deal_id) buyBy[t.deal_id] = (buyBy[t.deal_id] || 0) + Number(t.price || 0) + Number(t.costs || 0);
    for (const t of tx) {
      if (!t.tx_date || t.tx_date < since) continue;
      if (t.kind === 'offer') add('offers', t.tx_date + 'T12:00:00');
      if (t.kind === 'sale') { add('closings', t.tx_date + 'T12:00:00'); add('profit', t.tx_date + 'T12:00:00', Number(t.price || 0) - Number(t.costs || 0) - (buyBy[t.deal_id] || 0)); }
    }
    const tagged = tag => props.filter(p => (Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',')).map(s => String(s).trim()).includes(tag));
    const kept = tagged('portfolio-lot'), notes = tagged('note');
    const nf = p => (p.fields && typeof p.fields === 'object') ? p.fields : {};
    const noteBal = notes.reduce((s, p) => s + Number(nf(p).note_balance || 0), 0), noteInc = notes.reduce((s, p) => s + Number(nf(p).note_payment || 0), 0);
    const sp = {}; for (const r of splits) { const k = r.my_status || 'new'; sp[k] = (sp[k] || 0) + 1; }

    const rows = [
      ['Pieces mailed', 'mail', v => v.toLocaleString()], ['4-week average (goal 2,000)', 'avg4', v => v ? v.toLocaleString() : ''], ['Mail cost', 'mailCost', money],
      ['Calls', 'calls'], ['Real conversations (1 min+)', 'convos'], ['Seller texts / emails in', 'replies'],
      ['New seller leads', 'leads'], ['Offers sent (contract sent)', 'offers'], ['Contracts signed', 'contracts'],
      ['Closings', 'closings'], ['Profit closed', 'profit', money],
    ];
    const lbl = w => { const d = new Date(w + 'T12:00:00'); return (d.getMonth() + 1) + '/' + d.getDate(); };
    const cur = weeks[weeks.length - 1], prev = weeks[weeks.length - 2];
    const sum = k => Object.values(R[k]).reduce((a, b) => a + b, 0);
    const tile = (t, v, s) => `<div class="card" style="flex:1;min-width:150px;margin:0"><div class="small muted">${t}</div><div style="font-size:24px;font-weight:700">${v}</div><div class="small muted">${s || ''}</div></div>`;
    const GOAL = 2000, last4 = weeks.slice(-4).reduce((a, w) => a + R.mail[w], 0), avg4 = Math.round(last4 / 4), gap = last4 - GOAL * 4;
    R.avg4 = Object.fromEntries(weeks.map((w, i) => [w, i < 3 ? 0 : Math.round(weeks.slice(i - 3, i + 1).reduce((a, x) => a + R.mail[x], 0) / 4)]));
    const fmt = (r, v) => r[2] ? r[2](v) : (v || 0).toLocaleString();
    $('view').innerHTML = `
      <div class="card" style="border-left:4px solid #5c2977">
        <b>My plan (set Oct 31, 2026)</b>
        <div class="small" style="margin-top:6px;line-height:1.7">
          <b>Mail:</b> ${GOAL.toLocaleString()} pieces every week, core 6 counties only (Mecklenburg, Gaston, Union, Cabarrus, Iredell, Rowan), paid from the business account, never a card. Step up to 4,000 then 6,000 a week only from closing money.<br>
          <b>Deals:</b> 2 to 3 closings a month. <b>Every closing:</b> 15% tithes · 20% taxes · $5,000 to me · the rest half to debt, half to mail.<br>
          <b>Debt (0% ends May/June 2027):</b> ~$95,700 → about $13,700 a month. Order: South State ($8,554) → Emprise ($15,500) → Chase ($71,667).<br>
          <b>Pay myself the right way:</b> find a CPA → set a reasonable salary → run it through payroll (Gusto/QuickBooks/ADP): monthly direct deposit with income tax + Social Security/Medicare withheld; the rest of the $5,000 as an owner distribution.<br>
          <b>Weekly:</b> Monday scorecard + approve the next 2 weeks of lists · call back every lead same day · contract within 48 hours of a real conversation · Friday follow-up block.
        </div></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        ${tile('Mail: last 4 weeks', avg4.toLocaleString() + '/wk', 'goal ' + GOAL.toLocaleString() + '/wk · ' + (gap >= 0 ? 'on pace' : 'behind ' + (-gap).toLocaleString() + ' pieces') + ' · this week ' + R.mail[cur].toLocaleString())}
        ${tile('Conversations this week', R.convos[cur], 'last week ' + R.convos[prev])}
        ${tile('Contracts (12 wks)', sum('contracts'), sum('closings') + ' closed · ' + money(sum('profit')))}
        ${tile('Lots kept', kept.length, 'land portfolio')}
        ${tile('Notes', notes.length, money(noteInc) + '/mo · ' + money(noteBal) + ' balance')}
      </div>
      <div class="card" style="padding:0;overflow-x:auto"><table class="ctable"><tr><th>Week of</th>${weeks.map(w => `<th class="right">${lbl(w)}</th>`).join('')}<th class="right">12 wks</th></tr>
        ${rows.map(r => `<tr><td>${r[0]}</td>${weeks.map(w => `<td class="right"${w === cur ? ' style="font-weight:700"' : ''}>${fmt(r, R[r[1]][w])}</td>`).join('')}<td class="right"><b>${fmt(r, sum(r[1]))}</b></td></tr>`).join('')}
      </table></div>
      <div class="card"><b>Split pipeline</b> <span class="small muted">(Split Finder statuses)</span><div class="small" style="margin-top:6px">
        ${[['new', 'New'], ['mailed', 'Mailed'], ['contacting', 'Contacting'], ['survey', 'Surveyor check'], ['offer', 'Offer made'], ['contract', 'Under contract'], ['dead', 'Dead']].map(([k, l]) => `${l}: <b>${(sp[k] || 0).toLocaleString()}</b>`).join(' · ')}</div></div>
      <div class="card"><b>Land portfolio and notes</b>
        <div class="small muted" style="margin:4px 0 8px">Add a lot you kept or a note you're carrying. It counts toward the tiles above.</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <select id="sc_kind" style="width:auto"><option value="portfolio-lot">Lot I kept</option><option value="note">Note I'm carrying</option></select>
          <input id="sc_addr" placeholder="Address or parcel" style="width:220px"><input id="sc_county" placeholder="County" style="width:110px">
          <input id="sc_bal" placeholder="Note balance $" style="width:120px"><input id="sc_pay" placeholder="Monthly payment $" style="width:140px"><input id="sc_rate" placeholder="Rate %" style="width:80px">
          <button class="btn sm" onclick="scAdd()">Add</button></div>
        <table class="ctable" style="margin-top:10px"><tr><th>Type</th><th>Property</th><th class="right">Balance</th><th class="right">Monthly</th><th class="right">Rate</th></tr>
          ${kept.concat(notes).map(p => { const f = nf(p), isN = notes.includes(p); return `<tr><td>${isN ? 'Note' : 'Kept lot'}</td><td>${esc(p.address || p.apn || '')} <span class="small muted">${esc(p.county || '')}</span></td><td class="right">${isN ? money(f.note_balance) : ''}</td><td class="right">${isN ? money(f.note_payment) : ''}</td><td class="right">${isN && f.note_rate ? f.note_rate + '%' : ''}</td></tr>`; }).join('') || '<tr><td colspan="5" class="muted">Nothing yet. Your first kept lot or note goes here.</td></tr>'}
        </table></div>
      <div class="small muted">Calls only count what's logged in DLG HQ from Quo. Offers = purchase contracts sent from DLG HQ (plus any offer logged on a property); contracts = signed (RabbitSign); profit = sale price − costs − purchase price on the same deal.</div>`;
  };

  window.scAdd = async function () {
    const kind = $('sc_kind').value, a = $('sc_addr').value.trim(); if (!a) return alert('Add an address or parcel.');
    const fields = kind === 'note' ? { note_balance: Number($('sc_bal').value.replace(/[^\d.]/g, '')) || 0, note_payment: Number($('sc_pay').value.replace(/[^\d.]/g, '')) || 0, note_rate: Number($('sc_rate').value.replace(/[^\d.]/g, '')) || null } : {};
    const isApn = /^[\d\s-]+$/.test(a);
    const { error } = await sb.from('properties').insert({ address: isApn ? null : a, apn: isApn ? a : null, county: $('sc_county').value.trim() || null, tags: [kind], fields, source: 'scorecard' });
    if (error) return alert(error.message);
    vScorecard();
  };
})();
