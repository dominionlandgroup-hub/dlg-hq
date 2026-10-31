// DLG HQ - My Checklist. Damien's personal plan checklist, stored as tasks titled "CL|<n Section>|<order>|<text>".
// Kept out of the Tasks page. Claude reads these every Monday.
(function () {
  const parse = t => { const [, sec, ord, ...rest] = t.title.split('|'); return { ...t, sec, ord, text: rest.join('|') }; };
  window.vChecklist = async function () {
    $('view').innerHTML = '<div class="card muted">Loading…</div>';
    const { data, error } = await sb.from('tasks').select('id,title,status,updated_at:created_at').like('title', 'CL|%').order('title');
    if (error) { $('view').innerHTML = '<div class="card">Could not load: ' + esc(error.message) + '</div>'; return; }
    const items = (data || []).map(parse), secs = [...new Set(items.map(i => i.sec))].sort();
    const done = items.filter(i => i.status === 'done').length;
    $('view').innerHTML = `
      <div class="card" style="border-left:4px solid #5c2977"><b>${done} of ${items.length} done</b>
        <div style="height:8px;background:var(--line,#eee);border-radius:4px;margin-top:8px;overflow:hidden"><div style="height:100%;width:${items.length ? Math.round(100 * done / items.length) : 0}%;background:#5c2977"></div></div>
        <div class="small muted" style="margin-top:6px">One at a time. Tick each one as you do it. Claude reads this every Monday. Plan and numbers: <a href="#scorecard" onclick="go('scorecard');return false">Weekly Scorecard</a>.</div></div>
      ${secs.map(s => { const list = items.filter(i => i.sec === s); const d = list.filter(i => i.status === 'done').length;
        return `<div class="card" style="padding:0"><div style="padding:10px 14px"><b>${esc(s.replace(/^\d+\s*/, ''))}</b> <span class="small muted">${d}/${list.length}</span></div>
          ${list.map(i => `<label style="display:flex;gap:10px;align-items:flex-start;padding:10px 14px;border-top:1px solid var(--line,#eee);cursor:pointer">
            <input type="checkbox" style="width:auto;margin-top:3px;transform:scale(1.2)" ${i.status === 'done' ? 'checked' : ''} onchange="toggleTask(${i.id},this.checked).then(vChecklist)">
            <span style="${i.status === 'done' ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(i.text)}</span></label>`).join('')}</div>`; }).join('')}`;
  };
})();
