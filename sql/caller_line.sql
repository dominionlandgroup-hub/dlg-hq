-- DLG HQ CALLERS, part 6 (Nov 26, 2026)
-- 1) Each caller texts from their OWN Quo line (caller_accounts.quo_line). Olivia keeps (704) 275-5457.
--    Damien's own caller login uses his seller line (704) 387-3482.
-- 2) The call list hides the Dead Lead, No Motivation, New Leads (Review) and Merged columns by COLUMN,
--    not only by the emoji at the front of the card name.

alter table public.caller_accounts add column if not exists quo_line text;
update public.caller_accounts set quo_line = '+17042755457' where quo_line is null and not is_test and active;

create or replace function public.caller_stats_core(cid bigint) returns json language plpgsql stable security definer set search_path = public as $$
declare t0 timestamptz := date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
begin
  return (select json_build_object('name', (select name from caller_accounts where id = cid), 'call_name', (select call_name from caller_accounts where id = cid),
    'line', (select coalesce(quo_line, '+17042755457') from caller_accounts where id = cid),
    'calls', count(*), 'reached', count(*) filter (where outcome in ('appointment','follow_up','not_interested','transferred')),
    'appointments', count(*) filter (where outcome in ('appointment','transferred')), 'follow_ups', count(*) filter (where outcome = 'follow_up'),
    'not_interested', count(*) filter (where outcome = 'not_interested'), 'no_answer', count(*) filter (where outcome in ('no_answer','voicemail')),
    'bad_numbers', count(*) filter (where outcome = 'wrong_number'),
    'damien_available', (select available and updated_at > now() - interval '4 hours' from owner_status where id = 1),
    'reviews', (select coalesce(json_agg(json_build_object('week_of', r.week_of, 'did_well', r.did_well, 'fix', r.fix, 'focus', r.focus) order by r.week_of desc), '[]'::json)
                  from (select * from caller_reviews where caller_id = cid order by week_of desc limit 4) r))
    from caller_calls where caller_id = cid and created_at >= t0);
end $$;

create or replace function public.caller_queue_core(p_test boolean default false, p_cid bigint default null) returns json language plpgsql stable security definer set search_path = public as $$
begin
  return coalesce((select json_agg(q order by q.skip, q.due desc, q.spos, q.dpos, q.deal_id) from (
    select d.id deal_id, d.property_label label, s.name stage, s.position spos, coalesce(d.position, 0) dpos,
           (s.name = 'Duet - Needs Skip Trace') skip,
           coalesce(nullif(trim(l.full_name),''), nullif(trim(coalesce(l.first_name,'')||' '||coalesce(l.last_name,'')),''), d.as_meta->>'owner') owner,
           lc.outcome last_outcome, lc.created_at last_at, lc.follow_up_at next_at,
           (s.name = 'Duet - Follow Up') due,
           (select count(*) from caller_calls c where c.deal_id = d.id) tries
      from deals d join board_stages s on s.id = d.stage_id left join leads l on l.id = d.lead_id
      left join lateral (select * from caller_calls c where c.deal_id = d.id order by c.created_at desc limit 1) lc on true
     where s.name like 'Duet - %'
       and s.name not in ('Duet - Appointment Set','Duet - Not Interested','Duet - Needs Skip Trace',
                          'Duet - Dead Lead','Duet - No Motivation','Duet - 🔎 New Leads (Review)')
       and case when p_test then d.property_label like '🧪%' else d.property_label like '📞%' end
       and (lc.follow_up_at is null or lc.follow_up_at <= now())
       and not (s.name = 'Duet - Follow Up' and lc.id is null)
       and not exists (select 1 from caller_claims k where k.deal_id = d.id and k.caller_id is distinct from p_cid and k.claimed_at > now() - interval '15 minutes')
       and coalesce((select bool_and(c3.outcome in ('no_answer','voicemail')) and count(*) = 3
                       from (select outcome from caller_calls c where c.deal_id = d.id order by created_at desc limit 3) c3), false) = false
  ) q), '[]'::json);
end $$;
revoke all on function public.caller_queue_core(boolean, bigint) from public, anon, authenticated;
select 'ok' as done;
