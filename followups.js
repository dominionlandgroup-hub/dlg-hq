// followups.js - runs DLG HQ auto follow-up plans (Oct 25, 2026).
// Followups.run({dry}) processes every active enrollment whose next step is due:
//   text  -> sent through Quo (seller plans from (704) 387-3482, buyer "B" plans from (980) 217-8806)
//   call  -> creates a call task for Damien that day
//   email -> returned in the report (the scheduled task saves it as a Gmail DRAFT; nothing is emailed automatically)
//            and a task "Review and send email" is created
//   mail  -> creates a task to add the person to the next mail batch with that letter
// Safety: texts only 9am-7pm Eastern, Monday-Saturday; max 40 texts per run; one step per person per run;
// a plan stops when the person replies (any inbound text after enrolling), texts STOP (also tagged Opted out),
// or is tagged Sold / Listed With Agent / Not interested / DNC / Opted out / Do not contact, or marked not selling.
// Followups.autoEnroll(dealId, stageId) enrolls the deal's contact in the plan for that stage when a deal changes stage.
(function () {
  const SELLER_FROM = '7043873482', BUYER_FROM = '9802178806';
  const STAGE_PLAN = { // stage name (lowercase, starts with) -> plan name prefix
    'new lead': '1. ', 'interested': '2. ', 'hunting': '3. ', 'no answer': '4. ', 'prepare otp': '5. ', 'contract sent': '6. ',
    'follow-up': '7. ', 'follow up': '7. ', 'dead lead': '8. ', 'new inventory': '10. ',
    'assigned to buyer - no emd': 'B2. ', 'assigned to buyer - emd in': 'B3. '
  };
  const BLOCK_TAGS = /^(sold|listed with agent|not interested|not selling|dnc|opted out|do not contact|do not text|wrong number)$/i;
  const ESTATE_TAGS = /estate|inherit|heir|probate|deceased/i;
  const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|remove me|take me off)\b/i;
  const d10 = p => String(p || '').replace(/\D/g, '').slice(-10);

  function etNow() { // wall-clock Eastern time parts
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
    const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
    return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, dow: p.weekday, hour: +(p.hour === '24' ? 0 : p.hour) };
  }
  function etDate(iso) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso)); }
  function addDays(ymd, n) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  const firstName = (l, fallbackName) => {
    const f = (l?.first_name || '').trim() || String(l?.full_name || fallbackName || '').trim().split(/\s+/)[0] || '';
    return /llc|inc|trust|estate|church|heirs/i.test(f) || !f ? 'there' : f[0].toUpperCase() + f.slice(1).toLowerCase();
  };
  const fill = (t, v) => String(t || '').replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '');

  async function planFor(dealId, stageId) {
    const st = (typeof STAGES !== 'undefined' ? STAGES : []).find(s => s.id === stageId); if (!st) return null;
    const key = Object.keys(STAGE_PLAN).find(k => st.name.toLowerCase().startsWith(k)); if (!key) return null;
    let prefix = STAGE_PLAN[key];
    const { data: d } = await sb.from('deals').select('id,lead_id,buyer_id,leads(tags,status,do_not_mail)').eq('id', dealId).single();
    if (!d) return null;
    const tags = (d.leads?.tags || []).join(' ');
    if (['1. ', '3. '].includes(prefix) && ESTATE_TAGS.test(tags)) prefix = '9. ';
    const { data: plans } = await sb.from('followup_plans').select('id,name').like('name', prefix + '%').limit(1);
    return plans?.[0] ? { plan: plans[0], deal: d, stage: st } : null;
  }

  async function autoEnroll(dealId, stageId) {
    try {
      const r = await planFor(dealId, stageId); if (!r || !r.deal.lead_id) return null;
      const { plan, deal } = r;
      if ((deal.leads?.tags || []).some(t => BLOCK_TAGS.test(t))) return null;
      if (plan.name.startsWith('B') && !deal.buyer_id) return null;
      // never enroll someone twice in the same plan (replied/finished people stay out)
      const { data: ex } = await sb.from('followup_enrollments').select('id').eq('lead_id', deal.lead_id).eq('plan_id', plan.id).limit(1);
      if (ex?.length) return null;
      // one plan at a time per contact
      await sb.from('followup_enrollments').update({ status: 'stopped', stopped_why: 'moved to ' + r.stage.name }).eq('lead_id', deal.lead_id).eq('status', 'active');
      const { error } = await sb.from('followup_enrollments').insert({ plan_id: plan.id, lead_id: deal.lead_id, deal_id: dealId });
      if (error) { console.warn('autoEnroll', error); return null; }
      await sb.from('activity').insert({ lead_id: deal.lead_id, kind: 'status', body: 'Auto follow-up started: ' + plan.name });
      if (window.toast) toast('Auto follow-up started: ' + plan.name);
      return plan.name;
    } catch (e) { console.warn('autoEnroll', e); return null; }
  }

  async function stopEnr(e, why, tagOptOut) {
    await sb.from('followup_enrollments').update({ status: 'stopped', stopped_why: why }).eq('id', e.id);
    if (tagOptOut && e.lead_id) {
      const { data: l } = await sb.from('leads').select('tags').eq('id', e.lead_id).single();
      await sb.from('leads').update({ tags: [...new Set([...(l?.tags || []), 'Opted out'])] }).eq('id', e.lead_id);
    }
    if (e.lead_id) await sb.from('activity').insert({ lead_id: e.lead_id, kind: 'status', body: 'Auto follow-up stopped (' + why + ')' });
  }

  async function run(opts = {}) {
    const dry = !!opts.dry, now = etNow();
    const textWindow = now.dow !== 'Sun' && now.hour >= 9 && now.hour < 19;
    const rep = { when: now.ymd + ' ' + now.hm + ' ET', dry, texts: [], calls: [], emails: [], mail: [], stopped: [], waiting: [], errors: [], textWindow };
    const { data: enr, error } = await sb.from('followup_enrollments').select('*, followup_plans(id,name,stop_on_reply)').eq('status', 'active').order('started_at');
    if (error) throw error;
    if (!enr?.length) return rep;
    const planIds = [...new Set(enr.map(e => e.plan_id))];
    const { data: steps } = await sb.from('followup_steps').select('*').in('plan_id', planIds).order('day').order('send_time');
    const leadIds = [...new Set(enr.map(e => e.lead_id).filter(Boolean))];
    const { data: leads } = await sb.from('leads').select('id,full_name,first_name,last_name,phone,email,prop_address,prop_city,county,status,tags,do_not_mail').in('id', leadIds);
    const L = Object.fromEntries((leads || []).map(l => [l.id, l]));
    const dealIds = [...new Set(enr.map(e => e.deal_id).filter(Boolean))];
    const { data: deals } = dealIds.length ? await sb.from('deals').select('id,buyer_id,property_label,properties(address,city)').in('id', dealIds) : { data: [] };
    const D = Object.fromEntries((deals || []).map(d => [d.id, d]));
    const buyerIds = [...new Set((deals || []).map(d => d.buyer_id).filter(Boolean))];
    const { data: buyers } = buyerIds.length ? await sb.from('buyers').select('id,name,company,phone,email').in('id', buyerIds) : { data: [] };
    const B = Object.fromEntries((buyers || []).map(b => [b.id, b]));
    let sent = 0;
    for (const e of enr) {
      const plan = e.followup_plans || {}; const isBuyer = /^B/.test(plan.name || '');
      const l = L[e.lead_id] || {}; const d = D[e.deal_id] || {}; const who = isBuyer ? B[d.buyer_id] : null;
      const name = isBuyer ? (who?.name || who?.company || 'buyer') : (l.full_name || [l.first_name, l.last_name].filter(Boolean).join(' ') || 'contact');
      const st = (steps || []).filter(s => s.plan_id === e.plan_id);
      const step = st[e.next_step];
      if (!step) { if (!dry) await sb.from('followup_enrollments').update({ status: 'stopped', stopped_why: 'finished' }).eq('id', e.id); rep.stopped.push(name + ': plan finished'); continue; }
      // stop rules (seller contact)
      if (!isBuyer) {
        const blocked = (l.tags || []).find(t => BLOCK_TAGS.test(t));
        const deadOk = /^8\. /.test(plan.name || '') && l.status === 'dead';
        if (blocked || (['not_selling'].includes(l.status)) || (l.status === 'dead' && !deadOk)) { if (!dry) await stopEnr(e, blocked ? 'tagged ' + blocked : 'status ' + l.status); rep.stopped.push(name + ': ' + (blocked || l.status)); continue; }
      }
      const ph = d10(isBuyer ? who?.phone : l.phone);
      let iq = sb.from('messages').select('body,created_at').eq('direction', 'in').gt('created_at', e.started_at);
      iq = ph ? iq.eq('their_number', ph) : iq.eq('lead_id', e.lead_id);
      const { data: inbound } = await iq.order('created_at', { ascending: false }).limit(5);
      if (inbound?.length) {
        const opt = inbound.find(m => STOP_WORDS.test(m.body || ''));
        if (opt) { if (!dry) await stopEnr(e, 'texted STOP', true); rep.stopped.push(name + ': texted STOP (tagged Opted out)'); continue; }
        if (plan.stop_on_reply) { if (!dry) await stopEnr(e, 'replied'); rep.stopped.push(name + ': replied - your turn'); continue; }
      }
      const due = addDays(etDate(e.started_at), step.day), at = (step.send_time || '09:00').slice(0, 5);
      if (now.ymd < due || (now.ymd === due && now.hm < at)) { rep.waiting.push(`${name}: ${step.kind} on ${due} ${at}`); continue; }
      const vars = { first_name: isBuyer ? firstName(null, who?.name) : firstName(l), contact_name: name,
        property_address: d.properties?.address || l.prop_address || d.property_label || 'your property', county_name: l.county || '' };
      const label = `${name} - ${plan.name} (step ${e.next_step + 1}/${st.length})`;
      try {
        if (step.kind === 'text') {
          const phone = d10(isBuyer ? who?.phone : l.phone);
          if (!phone) throw new Error('no phone number');
          if (!textWindow) { rep.waiting.push(`${name}: text waits for 9am-7pm Mon-Sat`); continue; }
          if (sent >= 40) { rep.waiting.push(`${name}: text waits (40 per run limit)`); continue; }
          const text = fill(step.body, vars);
          rep.texts.push({ to: name, phone, text });
          if (!dry) {
            const th = await sb.rpc('quo_thread', { their: phone, ours: isBuyer ? BUYER_FROM : SELLER_FROM });
            if (th.error) throw th.error;
            const r = await sb.functions.invoke('quo/send', { body: { thread_id: th.data.thread_id, text } });
            const err = r.error ? ((await r.error.context?.json?.().catch(() => null))?.error || r.error.message) : r.data?.error;
            if (err) throw new Error('Quo: ' + err);
            sent++;
          }
        } else if (step.kind === 'call') {
          rep.calls.push({ to: name, note: step.body || '' });
          if (!dry) await sb.from('tasks').insert({ lead_id: e.lead_id, deal_id: e.deal_id, title: `Call ${name}${(isBuyer ? who?.phone : l.phone) ? ' ' + (isBuyer ? who.phone : l.phone) : ''} - ${step.body || plan.name}`, due_at: now.ymd });
        } else if (step.kind === 'email') {
          const to = isBuyer ? who?.email : l.email;
          if (!to) throw new Error('no email address');
          const em = { to, name, from: isBuyer ? 'buyers' : 'seller', subject: fill(step.subject, vars), body: fill(step.body, vars), lead_id: e.lead_id };
          rep.emails.push(em);
          if (!dry) await sb.from('tasks').insert({ lead_id: e.lead_id, deal_id: e.deal_id, title: `Review and send follow-up email to ${name} (draft in Gmail: "${em.subject}")`, due_at: now.ymd });
        } else if (step.kind === 'mail') {
          if (!isBuyer && l.do_not_mail) { rep.waiting.push(`${name}: letter skipped (do not mail)`); }
          else { rep.mail.push({ to: name, letter: step.body }); if (!dry) await sb.from('tasks').insert({ lead_id: e.lead_id, deal_id: e.deal_id, title: `Add ${name} to next mail batch - letter: ${step.body}`, due_at: now.ymd }); }
        }
        if (!dry) {
          const last = e.next_step + 1 >= st.length;
          await sb.from('followup_enrollments').update({ next_step: e.next_step + 1, last_sent_at: new Date().toISOString(), last_attempt_at: new Date().toISOString(), last_error: null, ...(last ? { status: 'stopped', stopped_why: 'finished' } : {}) }).eq('id', e.id);
          if (e.lead_id) await sb.from('activity').insert({ lead_id: e.lead_id, kind: 'note', body: `Auto follow-up (${plan.name}): ${step.kind}${step.kind === 'text' ? ' sent - "' + fill(step.body, vars) + '"' : step.kind === 'email' ? ' drafted - ' + fill(step.subject, vars) : step.kind === 'call' ? ' task created' : ' - added to mail tasks'}` });
        }
      } catch (err) {
        rep.errors.push(`${label}: ${err.message || err}`);
        if (!dry) await sb.from('followup_enrollments').update({ last_error: String(err.message || err).slice(0, 300), last_attempt_at: new Date().toISOString() }).eq('id', e.id);
      }
    }
    return rep;
  }
  window.Followups = { run, autoEnroll, planFor, STAGE_PLAN };
})();
