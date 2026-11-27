-- DLG HQ CALLERS (Nov 27, 2026, Damien): keep hammering hard-to-reach heirs.
-- Before: a lead disappeared from the call list after 3 no-answer/voicemail calls in a row.
-- Now: after 3 misses in a row it rests 7 days and comes back; it leaves only after 10 unanswered tries in total.
create or replace function public.caller_queue_core(p_test boolean default false, p_cid bigint default null) returns json language plpgsql stable security definer set search_path = public as $$
begin
  return coalesce((select json_agg(q order by q.skip, q.due desc, q.cscore desc nulls last, q.spos, q.dpos, q.deal_id) from (
    select d.id deal_id, d.property_label label, s.name stage, s.position spos, coalesce(d.position, 0) dpos, d.call_score cscore,
           (s.name = 'Duet - Needs Skip Trace') skip,
           coalesce(nullif(trim(l.full_name),''), nullif(trim(coalesce(l.first_name,'')||' '||coalesce(l.last_name,'')),''), d.as_meta->>'owner') owner,
           lc.outcome last_outcome, lc.created_at last_at, lc.follow_up_at next_at,
           (s.name = 'Duet - Follow Up') due,
           (select count(*) from caller_calls c where c.deal_id = d.id) tries
      from deals d join board_stages s on s.id = d.stage_id left join leads l on l.id = d.lead_id
      left join lateral (select * from caller_calls c where c.deal_id = d.id order by c.created_at desc limit 1) lc on true
     where s.name like 'Duet - %'
       and s.name not in ('Duet - Appointment Set','Duet - Not Interested','Duet - Needs Skip Trace',
                          'Duet - Dead Lead','Duet - No Motivation','Duet - 🔎 New Leads (Review)','Duet - Damien Deep Dive')
       and case when p_test then d.property_label like '🧪%' else d.property_label like '📞%' end
       and (lc.follow_up_at is null or lc.follow_up_at <= now())
       and not (s.name = 'Duet - Follow Up' and lc.id is null)
       and not exists (select 1 from caller_claims k where k.deal_id = d.id and k.caller_id is distinct from p_cid and k.claimed_at > now() - interval '15 minutes')
       -- keep hammering: after 3 misses in a row the lead rests 7 days, then comes back (next heir / next number);
       -- it leaves the list only after 10 unanswered tries in total
       and not (coalesce((select bool_and(c3.outcome in ('no_answer','voicemail')) and count(*) = 3
                       from (select outcome from caller_calls c where c.deal_id = d.id order by created_at desc limit 3) c3), false)
                and lc.created_at > now() - interval '7 days')
       and (select count(*) from caller_calls c where c.deal_id = d.id and c.outcome in ('no_answer','voicemail')) < 10
  ) q), '[]'::json);
end $$;
revoke all on function public.caller_queue_core(boolean, bigint) from public, anon, authenticated;
select 'ok' as done;
