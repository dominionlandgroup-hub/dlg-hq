-- DLG HQ CALLERS, part 2 (Nov 25, 2026): Guide, Text Damien button, weekly notes, Preview as caller.
-- Run after sql/callers.sql. Safe to run more than once.

-- 1. weekly notes from Damien to a caller (she sees them on her Guide) -------------------------------------------
create table if not exists public.caller_reviews (
  id bigserial primary key, caller_id bigint not null references public.caller_accounts(id) on delete cascade,
  week_of date not null, did_well text, fix text, focus text, created_at timestamptz not null default now(),
  unique (caller_id, week_of));
alter table public.caller_reviews enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='caller_reviews' and policyname='owner all') then
    create policy "owner all" on public.caller_reviews for all to authenticated using (true) with check (true);
  end if; end $$;

-- 1b. skip trace: a Duet column for leads where every number is bad, and the outcomes that use it ------------------
--   skip_trace -> every number is wrong (or none): lead moves to "Duet - Needs Skip Trace" and shows in her Skip trace list
--   skip_done  -> she found new numbers: they go in the notes and the lead goes back to the column it came from
--   skip_none  -> she couldn't find any: lead stays in Needs Skip Trace for Damien and leaves her list
alter table public.caller_calls add column if not exists prev_stage_id bigint;
do $$ begin
  if not exists (select 1 from public.board_stages where board='seller' and name='Duet - Needs Skip Trace') then
    update public.board_stages set position = position + 1 where board='seller' and name not like 'Duet - %';
    insert into public.board_stages (board, name, position, closed) values ('seller','Duet - Needs Skip Trace',13,false);
  end if; end $$;

-- 2. the queue / lead / stats bodies, shared by the caller's own login and Damien's preview -----------------------
create or replace function public.caller_queue_core() returns json language plpgsql stable security definer set search_path = public as $$
begin
  -- order: follow-ups due, then Call First, then each county column left to right, then Low Priority; skip trace list last
  return coalesce((select json_agg(q order by q.skip, q.due desc, q.spos, q.dpos, q.deal_id) from (
    select d.id deal_id, d.property_label label, s.name stage, s.position spos, coalesce(d.position, 0) dpos,
           (s.name = 'Duet - Needs Skip Trace') skip,
           coalesce(nullif(trim(l.full_name),''), trim(coalesce(l.first_name,'')||' '||coalesce(l.last_name,''))) owner,
           lc.outcome last_outcome, lc.created_at last_at, lc.follow_up_at next_at,
           (s.name = 'Duet - Follow Up') due,
           (select count(*) from caller_calls c where c.deal_id = d.id) tries
      from deals d join board_stages s on s.id = d.stage_id left join leads l on l.id = d.lead_id
      left join lateral (select * from caller_calls c where c.deal_id = d.id order by c.created_at desc limit 1) lc on true
     where s.name like 'Duet - %' and s.name not in ('Duet - Appointment Set','Duet - Not Interested')
       and d.property_label like '📞%'
       and (lc.follow_up_at is null or lc.follow_up_at <= now())
       and not (s.name = 'Duet - Follow Up' and lc.id is null)
       and not (s.name = 'Duet - Needs Skip Trace' and lc.outcome is distinct from 'skip_trace')
       -- 3 tries in a row with nobody answering: off her queue. Wrong numbers don't count here: when every number is bad
       -- she picks "Needs skip trace" instead.
       and coalesce((select bool_and(c3.outcome in ('no_answer','voicemail')) and count(*) = 3
                       from (select outcome from caller_calls c where c.deal_id = d.id order by created_at desc limit 3) c3), false) = false
  ) q), '[]'::json);
end $$;

create or replace function public.caller_lead_core(did bigint) returns json language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
  if not caller_deal_ok(did) then raise exception 'This lead is not in the Duet columns anymore'; end if;
  select json_build_object(
    'deal_id', d.id, 'label', d.property_label, 'stage', s.name, 'notes', d.notes,
    'owner', coalesce(nullif(trim(l.full_name),''), trim(coalesce(l.first_name,'')||' '||coalesce(l.last_name,''))),
    'first_name', l.first_name, 'last_name', l.last_name, 'street', coalesce(p.address, l.prop_address), 'city', coalesce(p.city, l.prop_city), 'phones', array_remove(array[l.phone, l.phone2, l.phone3], null),
    'mail', concat_ws(', ', l.mail_address, l.mail_city, l.mail_state, l.mail_zip),
    'property', concat_ws(', ', coalesce(p.address, l.prop_address), coalesce(p.city, l.prop_city), coalesce(p.state, l.prop_state)),
    'county', coalesce(p.county, l.county), 'apn', coalesce(p.apn, l.apn), 'acres', coalesce(p.acres::text, l.acres::text),
    'calls', (select coalesce(json_agg(json_build_object('at', c.created_at, 'outcome', c.outcome, 'phone', c.phone, 'talked_to', c.talked_to, 'note', c.note,
                'by', a.name, 'next', c.follow_up_at, 'appt', c.appt_at) order by c.created_at desc), '[]'::json)
              from caller_calls c left join caller_accounts a on a.id = c.caller_id where c.deal_id = d.id))
    into r
    from deals d join board_stages s on s.id = d.stage_id left join leads l on l.id = d.lead_id left join properties p on p.id = d.property_id
   where d.id = did;
  return r;
end $$;

create or replace function public.caller_stats_core(cid bigint) returns json language plpgsql stable security definer set search_path = public as $$
declare t0 timestamptz := date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
begin
  return (select json_build_object('name', (select name from caller_accounts where id = cid), 'call_name', (select call_name from caller_accounts where id = cid),
    'calls', count(*), 'reached', count(*) filter (where outcome in ('appointment','follow_up','not_interested')),
    'appointments', count(*) filter (where outcome = 'appointment'), 'follow_ups', count(*) filter (where outcome = 'follow_up'),
    'not_interested', count(*) filter (where outcome = 'not_interested'), 'no_answer', count(*) filter (where outcome in ('no_answer','voicemail')),
    'bad_numbers', count(*) filter (where outcome = 'wrong_number'),
    'reviews', (select coalesce(json_agg(json_build_object('week_of', r.week_of, 'did_well', r.did_well, 'fix', r.fix, 'focus', r.focus) order by r.week_of desc), '[]'::json)
                  from (select * from caller_reviews where caller_id = cid order by week_of desc limit 4) r))
    from caller_calls where caller_id = cid and created_at >= t0);
end $$;

-- the caller's own versions now just check her session and call the shared bodies
create or replace function public.caller_queue(tok text) returns json language plpgsql security definer set search_path = public as $$
begin perform caller_auth(tok); return caller_queue_core(); end $$;
create or replace function public.caller_lead(tok text, did bigint) returns json language plpgsql security definer set search_path = public as $$
begin perform caller_auth(tok); return caller_lead_core(did); end $$;
create or replace function public.caller_stats(tok text) returns json language plpgsql security definer set search_path = public as $$
begin return caller_stats_core(caller_auth(tok)); end $$;

create or replace function public.caller_log(tok text, did bigint, p_outcome text, p_phone text, p_talked_to text, p_note text, p_when timestamptz)
returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); cname text; d deals; l leads; nxt timestamptz; sid bigint; lbl text; et text; owner text; line text;
begin
  if p_outcome not in ('appointment','follow_up','not_interested','no_answer','voicemail','wrong_number','skip_trace','skip_done','skip_none') then raise exception 'Pick an outcome'; end if;
  if not caller_deal_ok(did) then raise exception 'This lead is not in the Duet columns anymore'; end if;
  if length(trim(coalesce(p_note,''))) < 5 then raise exception 'Write a short note before saving'; end if;
  if p_outcome = 'skip_done' and trim(coalesce(p_note,'')) !~ '\d{3}\D{0,3}\d{3}\D?\d{4}' then raise exception 'Type the new phone numbers you found'; end if;
  if coalesce(p_phone,'') = '' and p_outcome not like 'skip%' then raise exception 'Pick the number you called'; end if;
  if p_outcome in ('appointment','follow_up') and (p_when is null or p_when < now() - interval '5 minutes') then
    raise exception 'Pick the % date and time (in the future)', case when p_outcome = 'appointment' then 'appointment' else 'callback' end; end if;
  select name into cname from caller_accounts where id = cid;
  select * into d from deals where id = did;
  select * into l from leads where id = d.lead_id;
  owner := coalesce(nullif(trim(l.full_name),''), trim(coalesce(l.first_name,'')||' '||coalesce(l.last_name,'')), d.property_label);
  nxt := case p_outcome when 'follow_up' then p_when when 'no_answer' then now() + interval '2 days' when 'voicemail' then now() + interval '2 days' else null end;
  insert into caller_calls (caller_id, deal_id, lead_id, outcome, phone, talked_to, note, follow_up_at, appt_at, prev_stage_id)
  values (cid, did, d.lead_id, p_outcome, nullif(p_phone,''), nullif(trim(p_talked_to),''), trim(p_note), nxt, case when p_outcome = 'appointment' then p_when end, d.stage_id);

  lbl := case p_outcome when 'appointment' then 'APPOINTMENT SET' when 'follow_up' then 'FOLLOW UP' when 'not_interested' then 'NOT INTERESTED'
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
  return caller_stats(tok);
end $$;

-- 3. Preview as caller: Damien, signed in to DLG HQ, sees exactly her screen. Read only. ---------------------------
create or replace function public.owner_preview_queue() returns json language sql stable security definer set search_path = public as $$
  select caller_queue_core(); $$;
create or replace function public.owner_preview_lead(did bigint) returns json language sql stable security definer set search_path = public as $$
  select caller_lead_core(did); $$;
create or replace function public.owner_preview_stats(cid bigint) returns json language sql stable security definer set search_path = public as $$
  select caller_stats_core(cid); $$;

-- 4. "Text Damien" button: hot leads and emergencies only. Max 5 a day per caller. -------------------------------
create or replace function public.caller_text_owner(tok text, did bigint, p_kind text, p_msg text) returns void
language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); cname text; lbl text; t0 timestamptz := now() - interval '24 hours';
begin
  if p_kind not in ('hot','emergency') then raise exception 'Pick Hot lead or Emergency'; end if;
  if length(trim(coalesce(p_msg,''))) < 5 then raise exception 'Write a short message'; end if;
  select coalesce(call_name, name) into cname from caller_accounts where id = cid;
  if (select count(*) from owner_alerts where body like 'DLG ' || '%' || ' from ' || cname || ':%' and created_at > t0) >= 5 then
    raise exception 'You have sent 5 texts to Damien today. For anything else, put it in your end-of-day report.'; end if;
  if did is not null and caller_deal_ok(did) then select regexp_replace(property_label, '^\S+\s+', '') into lbl from deals where id = did; end if;
  insert into owner_alerts (body) values (
    'DLG ' || case p_kind when 'hot' then 'HOT LEAD' else 'EMERGENCY' end || ' from ' || cname || ': ' || left(trim(p_msg), 400) ||
    coalesce(E'\nLead: ' || lbl || E'\nhttps://landiq.land/#deal-' || did, ''));
end $$;

-- 5. who can call what ---------------------------------------------------------------------------------------------
revoke all on function public.caller_queue_core(), public.caller_lead_core(bigint), public.caller_stats_core(bigint) from public, anon, authenticated;
revoke all on function public.owner_preview_queue(), public.owner_preview_lead(bigint), public.owner_preview_stats(bigint) from public, anon;
grant execute on function public.owner_preview_queue(), public.owner_preview_lead(bigint), public.owner_preview_stats(bigint) to authenticated;
grant execute on function public.caller_queue(text), public.caller_lead(text,bigint), public.caller_stats(text),
  public.caller_text_owner(text,bigint,text,text) to anon, authenticated;
