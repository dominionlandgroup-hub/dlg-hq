-- DLG HQ CALLER: hot seller hold & transfer + heir check (Nov 27, 2026)
-- Hot seller: the caller puts a seller who wants to talk today on hold and taps "Hot seller - hold & transfer".
-- Damien gets a text with everything about the lead and a link (hot.html?h=token). He taps "I'm ready" there,
-- the caller's screen shows "Damien is ready - transfer now". After 90 seconds with no tap she books an appointment.
-- Heir check: the appointment text to Damien now carries the HEIR CHECK line the caller fills in.

create table if not exists public.hot_holds (
  id bigserial primary key,
  token text not null unique default md5(random()::text || clock_timestamp()::text) || md5(random()::text),
  deal_id bigint references public.deals(id) on delete set null,
  caller_id bigint,
  seller text, phone text, price text, heirs text,
  created_at timestamptz not null default now(),
  ready_at timestamptz
);
alter table public.hot_holds enable row level security;

create or replace function public.caller_hot_start(tok text, did bigint, p_who text, p_phone text, p_price text, p_heirs text)
returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); cname text; h hot_holds; lbl text; tax text; cnty text;
begin
  if did is null or not caller_deal_ok(did) then raise exception 'Open the lead first'; end if;
  if length(trim(coalesce(p_who,''))) < 2 then raise exception 'Type who you are talking to'; end if;
  if (select count(*) from hot_holds where caller_id = cid and created_at > now() - interval '24 hours') >= 15 then
    raise exception 'Too many hot holds today. Book an appointment instead.'; end if;
  select coalesce(call_name, name) into cname from caller_accounts where id = cid;
  select regexp_replace(property_label, '^\S+\s+', ''), substring(notes from 'BACK TAXES[^\n]*') into lbl, tax from deals where id = did;
  tax := regexp_replace(coalesce(tax,''), '^BACK TAXES \([^)]*\):\s*', '');
  insert into hot_holds (deal_id, caller_id, seller, phone, price, heirs)
  values (did, cid, left(trim(p_who),120), left(trim(coalesce(p_phone,'')),40), left(trim(coalesce(p_price,'')),80), left(trim(coalesce(p_heirs,'')),200))
  returning * into h;
  insert into owner_alerts (body) values (
    'DLG HOT - ON HOLD NOW (' || cname || E')\n' || h.seller || coalesce(' at ' || nullif(h.phone,''), '') ||
    E'\nLead: ' || coalesce(lbl,'') ||
    coalesce(E'\nTaxes: ' || nullif(left(tax, 160),''), '') ||
    E'\nPrice in mind: ' || coalesce(nullif(h.price,''), 'not given') ||
    E'\nHeirs: ' || coalesce(nullif(h.heirs,''), 'not asked yet') ||
    E'\nTap when ready: https://landiq.land/hot.html?h=' || h.token);
  return json_build_object('id', h.id);
end $$;

create or replace function public.caller_hot_status(tok text, hid bigint) returns json
language plpgsql stable security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); h hot_holds;
begin
  select * into h from hot_holds where id = hid and caller_id = cid;
  if h.id is null then raise exception 'Hold not found'; end if;
  return json_build_object('ready', h.ready_at is not null, 'seconds', extract(epoch from now() - h.created_at)::int);
end $$;

-- Damien's link: shows the lead and lets him tap "I'm ready". The token is the key (sent only to his phone).
create or replace function public.hot_hold_open(p_token text) returns json
language plpgsql stable security definer set search_path = public as $$
declare h hot_holds; d deals; cname text;
begin
  select * into h from hot_holds where token = p_token and created_at > now() - interval '24 hours';
  if h.id is null then raise exception 'This link has expired'; end if;
  select * into d from deals where id = h.deal_id;
  select coalesce(call_name, name) into cname from caller_accounts where id = h.caller_id;
  return json_build_object('caller', cname, 'seller', h.seller, 'phone', h.phone, 'price', h.price, 'heirs', h.heirs,
    'seconds', extract(epoch from now() - h.created_at)::int, 'ready', h.ready_at is not null,
    'deal_id', h.deal_id, 'label', regexp_replace(coalesce(d.property_label,''), '^\S+\s+', ''), 'notes', left(coalesce(d.notes,''), 6000));
end $$;

create or replace function public.hot_hold_ready(p_token text) returns json
language plpgsql security definer set search_path = public as $$
declare h hot_holds;
begin
  select * into h from hot_holds where token = p_token;
  if h.id is null then raise exception 'This link has expired'; end if;
  if h.created_at < now() - interval '15 minutes' then raise exception 'This hold is over. Call the seller back from the lead.'; end if;
  update hot_holds set ready_at = coalesce(ready_at, now()) where id = h.id;
  return json_build_object('ok', true);
end $$;

revoke all on table public.hot_holds from anon, authenticated;
grant execute on function public.caller_hot_start(text,bigint,text,text,text,text), public.caller_hot_status(text,bigint),
  public.hot_hold_open(text), public.hot_hold_ready(text) to anon, authenticated;

-- caller_log: same as sql/caller_claims.sql, plus the HEIR CHECK line in Damien's appointment text and a text for live transfers.
create or replace function public.caller_log(tok text, did bigint, p_outcome text, p_phone text, p_talked_to text, p_note text, p_when timestamptz)
returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); cname text; d deals; l leads; nxt timestamptz; sid bigint; lbl text; et text; owner text; line text; heir text;
begin
  if p_outcome not in ('appointment','follow_up','not_interested','no_answer','voicemail','wrong_number','skip_trace','skip_done','skip_none','transferred') then raise exception 'Pick an outcome'; end if;
  if not caller_deal_ok(did) then raise exception 'This lead is not in the Duet columns anymore'; end if;
  if length(trim(coalesce(p_note,''))) < 5 then raise exception 'Write a short note before saving'; end if;
  if p_outcome = 'skip_done' and trim(coalesce(p_note,'')) !~ '\d{3}\D{0,3}\d{3}\D?\d{4}' then raise exception 'Type the new phone numbers you found'; end if;
  if coalesce(p_phone,'') = '' and p_outcome not like 'skip%' then raise exception 'Pick the number you called'; end if;
  if p_outcome = 'transferred' then p_when := now(); end if;
  if p_outcome in ('appointment','follow_up') and (p_when is null or p_when < now() - interval '5 minutes') then
    raise exception 'Pick the % date and time (in the future)', case when p_outcome = 'appointment' then 'appointment' else 'callback' end; end if;
  heir := substring(p_note from 'HEIR CHECK:[^\n]*');
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
      coalesce(E'\n' || left(heir, 300), '') ||
      E'\nReview: https://landiq.land/#deal-' || did);
  end if;
  if p_outcome = 'transferred' then
    insert into tasks (deal_id, lead_id, title, due_at, status)
    values (did, d.lead_id, 'Live transfer from ' || cname || ': ' || owner || ' (' || coalesce(nullif(trim(p_talked_to),''), 'owner') || ') at ' || p_phone || ' - add notes from your call', now(), 'todo');
  end if;
  delete from caller_claims where deal_id = did;
  return caller_stats(tok);
end $$;
grant execute on function public.caller_log(text,bigint,text,text,text,text,timestamptz) to anon, authenticated;
select 'ok' as done;
