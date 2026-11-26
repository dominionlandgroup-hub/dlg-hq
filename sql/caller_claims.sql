-- DLG HQ CALLERS, part 4 (Nov 25, 2026): two people can call at once without dialing the same lead,
-- Damien's "I'm available" switch, and a Live transfer outcome.
-- Run after callers.sql, caller_guide.sql and caller_test.sql. Safe to run more than once.

-- 1. lead claims: opening a lead holds it for 15 minutes (or until the call is logged) ------------------------------
create table if not exists public.caller_claims (
  deal_id bigint primary key, caller_id bigint not null references public.caller_accounts(id) on delete cascade,
  claimed_at timestamptz not null default now());
alter table public.caller_claims enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='caller_claims' and policyname='owner all') then
    create policy "owner all" on public.caller_claims for all to authenticated using (true) with check (true);
  end if; end $$;

-- 2. Damien's availability (shown on the caller screen); turns itself off after 4 hours -----------------------------
create table if not exists public.owner_status (
  id int primary key default 1 check (id = 1), available boolean not null default false, updated_at timestamptz not null default now());
insert into public.owner_status (id) values (1) on conflict do nothing;
alter table public.owner_status enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='owner_status' and policyname='owner all') then
    create policy "owner all" on public.owner_status for all to authenticated using (true) with check (true);
  end if; end $$;

-- 3. queue skips leads another caller is on right now ---------------------------------------------------------------
drop function if exists public.caller_queue_core(boolean);
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
     where s.name like 'Duet - %' and s.name not in ('Duet - Appointment Set','Duet - Not Interested')
       and case when p_test then d.property_label like '🧪%' else d.property_label like '📞%' end
       and (lc.follow_up_at is null or lc.follow_up_at <= now())
       and not (s.name = 'Duet - Follow Up' and lc.id is null)
       and not (s.name = 'Duet - Needs Skip Trace' and lc.outcome is distinct from 'skip_trace')
       and not exists (select 1 from caller_claims k where k.deal_id = d.id and k.caller_id is distinct from p_cid and k.claimed_at > now() - interval '15 minutes')
       and coalesce((select bool_and(c3.outcome in ('no_answer','voicemail')) and count(*) = 3
                       from (select outcome from caller_calls c where c.deal_id = d.id order by created_at desc limit 3) c3), false) = false
  ) q), '[]'::json);
end $$;

create or replace function public.caller_queue(tok text) returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok);
begin return caller_queue_core(coalesce((select is_test from caller_accounts where id = cid), false), cid); end $$;

create or replace function public.owner_preview_queue(cid bigint default null) returns json language sql stable security definer set search_path = public as $$
  select caller_queue_core(coalesce((select is_test from caller_accounts where id = cid), false), null); $$;

-- opening a lead claims it; someone else on it in the last 15 minutes -> she is told and moves on
create or replace function public.caller_lead(tok text, did bigint) returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); other text;
begin
  select coalesce(a.call_name, a.name) into other from caller_claims k join caller_accounts a on a.id = k.caller_id
   where k.deal_id = did and k.caller_id <> cid and k.claimed_at > now() - interval '15 minutes';
  if other is not null then raise exception '% is on this lead right now. Pick another one.', other; end if;
  delete from caller_claims where caller_id = cid;
  insert into caller_claims (deal_id, caller_id, claimed_at) values (did, cid, now())
    on conflict (deal_id) do update set caller_id = excluded.caller_id, claimed_at = now();
  return caller_lead_core(did);
end $$;

-- stats now also say whether Damien is available
create or replace function public.caller_stats_core(cid bigint) returns json language plpgsql stable security definer set search_path = public as $$
declare t0 timestamptz := date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
begin
  return (select json_build_object('name', (select name from caller_accounts where id = cid), 'call_name', (select call_name from caller_accounts where id = cid),
    'calls', count(*), 'reached', count(*) filter (where outcome in ('appointment','follow_up','not_interested','transferred')),
    'appointments', count(*) filter (where outcome in ('appointment','transferred')), 'follow_ups', count(*) filter (where outcome = 'follow_up'),
    'not_interested', count(*) filter (where outcome = 'not_interested'), 'no_answer', count(*) filter (where outcome in ('no_answer','voicemail')),
    'bad_numbers', count(*) filter (where outcome = 'wrong_number'),
    'damien_available', (select available and updated_at > now() - interval '4 hours' from owner_status where id = 1),
    'reviews', (select coalesce(json_agg(json_build_object('week_of', r.week_of, 'did_well', r.did_well, 'fix', r.fix, 'focus', r.focus) order by r.week_of desc), '[]'::json)
                  from (select * from caller_reviews where caller_id = cid order by week_of desc limit 4) r))
    from caller_calls where caller_id = cid and created_at >= t0);
end $$;

-- 4. logging: adds the Live transfer outcome and releases the claim --------------------------------------------------
create or replace function public.caller_log(tok text, did bigint, p_outcome text, p_phone text, p_talked_to text, p_note text, p_when timestamptz)
returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); cname text; d deals; l leads; nxt timestamptz; sid bigint; lbl text; et text; owner text; line text;
begin
  if p_outcome not in ('appointment','follow_up','not_interested','no_answer','voicemail','wrong_number','skip_trace','skip_done','skip_none','transferred') then raise exception 'Pick an outcome'; end if;
  if not caller_deal_ok(did) then raise exception 'This lead is not in the Duet columns anymore'; end if;
  if length(trim(coalesce(p_note,''))) < 5 then raise exception 'Write a short note before saving'; end if;
  if p_outcome = 'skip_done' and trim(coalesce(p_note,'')) !~ '\d{3}\D{0,3}\d{3}\D?\d{4}' then raise exception 'Type the new phone numbers you found'; end if;
  if coalesce(p_phone,'') = '' and p_outcome not like 'skip%' then raise exception 'Pick the number you called'; end if;
  if p_outcome = 'transferred' then p_when := now(); end if;
  if p_outcome in ('appointment','follow_up') and (p_when is null or p_when < now() - interval '5 minutes') then
    raise exception 'Pick the % date and time (in the future)', case when p_outcome = 'appointment' then 'appointment' else 'callback' end; end if;
  select name into cname from caller_accounts where id = cid;
  select * into d from deals where id = did;
  select * into l from leads where id = d.lead_id;
  owner := coalesce(nullif(trim(l.full_name),''), trim(coalesce(l.first_name,'')||' '||coalesce(l.last_name,'')), d.property_label);
  nxt := case p_outcome when 'follow_up' then p_when when 'no_answer' then now() + interval '2 days' when 'voicemail' then now() + interval '2 days' else null end;
  insert into caller_calls (caller_id, deal_id, lead_id, outcome, phone, talked_to, note, follow_up_at, appt_at, prev_stage_id)
  values (cid, did, d.lead_id, p_outcome, nullif(p_phone,''), nullif(trim(p_talked_to),''), trim(p_note), nxt, case when p_outcome in ('appointment','transferred') then p_when end, d.stage_id);

  lbl := case p_outcome when 'appointment' then 'APPOINTMENT SET' when 'transferred' then 'LIVE TRANSFER TO DAMIEN' when 'follow_up' then 'FOLLOW UP' when 'not_interested' then 'NOT INTERESTED'
           when 'no_answer' then 'NO ANSWER' when 'voicemail' then 'LEFT VOICEMAIL' when 'wrong_number' then 'WRONG NUMBER'
           when 'skip_trace' then 'NEEDS SKIP TRACE (all numbers bad)' when 'skip_done' then 'SKIP TRACE - NEW NUMBERS FOUND'
           else 'SKIP TRACE - NO NEW NUMBERS FOUND (for Damien)' end;
  et := to_char(now() at time zone 'America/New_York', 'Mon DD, YYYY HH12:MIam') || ' ET';
  line := '[' || et || '] ' || cname || ' (caller) - ' || lbl || coalesce(E'\nCalled: ' || nullif(p_phone,''), '')
          || coalesce(E'\nSpoke with: ' || nullif(trim(p_talked_to),''), '') || E'\n' || trim(p_note)
          || case when p_outcome = 'appointment' then E'\nAPPOINTMENT: ' || to_char(p_when at time zone 'America/New_York', 'Dy Mon DD HH12:MIam') || ' ET'
                  when p_outcome = 'follow_up' then E'\nCall back: ' || to_char(p_when at time zone 'America/New_York', 'Dy Mon DD HH12:MIam') || ' ET' else '' end
          || case when p_outcome = 'wrong_number' then E'\n❌ BAD NUMBER - do not call: ' || p_phone else '' end;
  update deals set notes = coalesce(notes,'') || case when coalesce(notes,'') like '%CALLER NOTES%' then E'\n\n' else E'\n\n---------- CALLER NOTES ----------\n' end || line,
         updated_at = now() where id = did;
  if d.lead_id is not null then insert into activity (lead_id, kind, body) values (d.lead_id, 'call', line); end if;

  sid := case p_outcome
    when 'appointment' then (select id from board_stages where board = 'seller' and name = 'Duet - Appointment Set')
    when 'transferred' then (select id from board_stages where board = 'seller' and name = 'Duet - Appointment Set')
    when 'follow_up' then (select id from board_stages where board = 'seller' and name = 'Duet - Follow Up')
    when 'not_interested' then (select id from board_stages where board = 'seller' and name = 'Duet - Not Interested')
    when 'skip_trace' then (select id from board_stages where board = 'seller' and name = 'Duet - Needs Skip Trace')
    -- new numbers: back to the column it was in before it went to skip trace (Call First if unknown)
    when 'skip_done' then coalesce(
      (select c.prev_stage_id from caller_calls c join board_stages s on s.id = c.prev_stage_id
        where c.deal_id = did and c.outcome = 'skip_trace' and s.name like 'Duet - %' and s.name <> 'Duet - Needs Skip Trace' order by c.created_at desc limit 1),
      (select id from board_stages where board = 'seller' and name like 'Duet - %Call First' limit 1)) end;
  if sid is not null and sid is distinct from d.stage_id then
    update deals set stage_id = sid, stage = (select name from board_stages where id = sid), position = 0 where id = did;
    if d.lead_id is not null then insert into activity (lead_id, kind, body) values (d.lead_id, 'status', 'Deal moved to ' || (select name from board_stages where id = sid) || ' by ' || cname); end if;
  end if;

  if p_outcome = 'appointment' then
    insert into tasks (deal_id, lead_id, title, due_at, status)
    values (did, d.lead_id, 'Appointment set by ' || cname || ': call ' || owner || ' (' || coalesce(nullif(trim(p_talked_to),''), 'owner') || ') at ' || p_phone, p_when, 'todo');
    insert into owner_alerts (body) values (
      'DLG: New appointment set by ' || cname || E'.\n' || owner || ' - ' || coalesce(regexp_replace(d.property_label, '^\S+\s+', ''), '') ||
      E'\nWhen: ' || to_char(p_when at time zone 'America/New_York', 'Dy Mon DD HH12:MIam') || ' ET' ||
      E'\nCall: ' || p_phone || coalesce(' (' || nullif(trim(p_talked_to),'') || ')', '') ||
      E'\nReview: https://landiq.land/#deal-' || did);
  end if;
  if p_outcome = 'transferred' then
    insert into tasks (deal_id, lead_id, title, due_at, status)
    values (did, d.lead_id, 'Live transfer from ' || cname || ': ' || owner || ' (' || coalesce(nullif(trim(p_talked_to),''), 'owner') || ') at ' || p_phone || ' - add notes from your call', now(), 'todo');
  end if;
  delete from caller_claims where deal_id = did;
  return caller_stats(tok);
end $$;


revoke all on function public.caller_queue_core(boolean,bigint) from public, anon, authenticated;
revoke all on function public.owner_preview_queue(bigint) from public, anon;
grant execute on function public.owner_preview_queue(bigint) to authenticated;
grant execute on function public.caller_queue(text), public.caller_lead(text,bigint), public.caller_log(text,bigint,text,text,text,text,timestamptz) to anon, authenticated;
select 'ok' as done;
