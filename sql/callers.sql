-- DLG HQ CALLERS (Nov 25, 2026)
-- A caller (VA) gets her own login on landiq.land/caller.html and sees ONLY the Caller screen:
-- one Duet lead at a time (📞 leads), the lead's notes, and five outcome buttons.
--
-- Why a separate login instead of a normal DLG HQ user: every DLG HQ table and edge function lets ANY signed-in
-- Supabase user see and do everything. A caller never gets a Supabase sign-in. She signs in through the caller_*
-- functions below, which only return Duet leads and only write call outcomes. Nothing else in DLG HQ is reachable.
--
-- Outcomes:
--   appointment     -> deal moves to "Duet - Appointment Set", task for Damien at the appointment time, text to Damien
--   follow_up       -> deal moves to "Duet - Follow Up", comes back to her queue on the date she picks
--   not_interested  -> deal moves to "Duet - Not Interested" (nothing goes to Dead Lead)
--   no_answer / voicemail -> tries again in 2 days; after 3 tries with no one reached it leaves her queue
--   wrong_number    -> number marked BAD in the deal notes, lead stays in her queue for the next number
-- Every call is logged in caller_calls (KPIs), on the contact's activity, and at the bottom of the deal notes.

-- 1. tables ---------------------------------------------------------------------------------------------------------
create table if not exists public.caller_accounts (
  id bigserial primary key, name text not null, email text unique, pw_hash text,
  invite_token text unique, invite_expires timestamptz, active boolean not null default true,
  created_at timestamptz not null default now(), last_login timestamptz);
create table if not exists public.caller_sessions (
  token_hash text primary key, caller_id bigint not null references public.caller_accounts(id) on delete cascade,
  expires_at timestamptz not null, created_at timestamptz not null default now());
create table if not exists public.caller_calls (
  id bigserial primary key, caller_id bigint references public.caller_accounts(id), deal_id bigint, lead_id bigint,
  outcome text not null, phone text, talked_to text, note text, follow_up_at timestamptz, appt_at timestamptz,
  created_at timestamptz not null default now());
create index if not exists caller_calls_deal_idx on public.caller_calls (deal_id, created_at desc);
create index if not exists caller_calls_caller_idx on public.caller_calls (caller_id, created_at desc);
create table if not exists public.owner_alerts (
  id bigserial primary key, body text not null, created_at timestamptz not null default now(), sent_at timestamptz, error text);

-- Damien (signed in) can read/manage these like every other table. Callers (anon) get no table access at all.
do $$ declare t text; begin
  foreach t in array array['caller_accounts','caller_sessions','caller_calls','owner_alerts'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='owner all') then
      execute format('create policy "owner all" on public.%I for all to authenticated using (true) with check (true)', t);
    end if;
  end loop; end $$;

-- 2. stages: three new Duet columns, right after Duet - Low Priority -----------------------------------------------
do $$ begin
  if not exists (select 1 from public.board_stages where board='seller' and name='Duet - Follow Up') then
    update public.board_stages set position = position + 3 where board='seller' and name not like 'Duet - %';
    insert into public.board_stages (board, name, position, closed) values
      ('seller','Duet - Follow Up',10,false), ('seller','Duet - Appointment Set',11,false), ('seller','Duet - Not Interested',12,false);
  end if; end $$;

-- 3. sign-in ---------------------------------------------------------------------------------------------------------
create or replace function public.caller_auth(tok text) returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare cid bigint;
begin
  select s.caller_id into cid from caller_sessions s join caller_accounts a on a.id = s.caller_id
   where s.token_hash = encode(digest(coalesce(tok,''), 'sha256'), 'hex') and s.expires_at > now() and a.active;
  if cid is null then raise exception 'Please sign in again' using errcode = '28000'; end if;
  return cid;
end $$;

create or replace function public.caller_new_session(cid bigint) returns text language plpgsql security definer set search_path = public, extensions as $$
declare tok text := encode(gen_random_bytes(32), 'hex');
begin
  delete from caller_sessions where expires_at < now();
  insert into caller_sessions (token_hash, caller_id, expires_at) values (encode(digest(tok, 'sha256'), 'hex'), cid, now() + interval '14 hours');
  update caller_accounts set last_login = now() where id = cid;
  return tok;
end $$;

-- She opens the invite link Damien sends her and picks her own email + password (Claude never sees it).
create or replace function public.caller_accept_invite(p_invite text, p_email text, p_pw text) returns json language plpgsql security definer set search_path = public, extensions as $$
declare a caller_accounts;
begin
  select * into a from caller_accounts where invite_token = p_invite and invite_expires > now() and active;
  if a.id is null then raise exception 'This invite link has expired. Ask Damien for a new one.'; end if;
  if coalesce(p_email,'') !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  if length(coalesce(p_pw,'')) < 8 then raise exception 'Password must be at least 8 characters'; end if;
  if exists (select 1 from caller_accounts where lower(email) = lower(trim(p_email)) and id <> a.id) then raise exception 'That email is already used'; end if;
  update caller_accounts set email = lower(trim(p_email)), pw_hash = crypt(p_pw, gen_salt('bf')), invite_token = null, invite_expires = null where id = a.id;
  return json_build_object('token', caller_new_session(a.id), 'name', a.name);
end $$;

create or replace function public.caller_login(p_email text, p_pw text) returns json language plpgsql security definer set search_path = public, extensions as $$
declare a caller_accounts;
begin
  select * into a from caller_accounts where lower(email) = lower(trim(coalesce(p_email,''))) and active and pw_hash is not null;
  if a.id is null or a.pw_hash <> crypt(coalesce(p_pw,''), a.pw_hash) then perform pg_sleep(1); raise exception 'Wrong email or password'; end if;
  return json_build_object('token', caller_new_session(a.id), 'name', a.name);
end $$;

create or replace function public.caller_logout(tok text) returns void language sql security definer set search_path = public, extensions as $$
  delete from caller_sessions where token_hash = encode(digest(coalesce(tok,''), 'sha256'), 'hex');
$$;

-- 4. what she can see ------------------------------------------------------------------------------------------------
-- a deal is "hers" only while it sits in a Duet column
create or replace function public.caller_deal_ok(did bigint) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from deals d join board_stages s on s.id = d.stage_id where d.id = did and s.name like 'Duet - %');
$$;

create or replace function public.caller_queue(tok text) returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok);
begin
  return coalesce((select json_agg(q order by q.due desc, q.spos, q.dpos, q.deal_id) from (
    select d.id deal_id, d.property_label label, s.name stage, s.position spos, coalesce(d.position, 0) dpos,
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
       -- 3 tries in a row with nobody reached: off her queue (shows on Damien's Callers page)
       and coalesce((select bool_and(c3.outcome in ('no_answer','voicemail','wrong_number')) and count(*) = 3
                       from (select outcome from caller_calls c where c.deal_id = d.id order by created_at desc limit 3) c3), false) = false
  ) q), '[]'::json);
end $$;

create or replace function public.caller_lead(tok text, did bigint) returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); r json;
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

create or replace function public.caller_stats(tok text) returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); t0 timestamptz := date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
begin
  return (select json_build_object('name', (select name from caller_accounts where id = cid),
    'calls', count(*), 'reached', count(*) filter (where outcome in ('appointment','follow_up','not_interested')),
    'appointments', count(*) filter (where outcome = 'appointment'), 'follow_ups', count(*) filter (where outcome = 'follow_up'),
    'not_interested', count(*) filter (where outcome = 'not_interested'), 'no_answer', count(*) filter (where outcome in ('no_answer','voicemail')),
    'bad_numbers', count(*) filter (where outcome = 'wrong_number'))
    from caller_calls where caller_id = cid and created_at >= t0);
end $$;

-- 5. logging a call --------------------------------------------------------------------------------------------------
create or replace function public.caller_log(tok text, did bigint, p_outcome text, p_phone text, p_talked_to text, p_note text, p_when timestamptz)
returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); cname text; d deals; l leads; nxt timestamptz; sid bigint; lbl text; et text; owner text; line text;
begin
  if p_outcome not in ('appointment','follow_up','not_interested','no_answer','voicemail','wrong_number') then raise exception 'Pick an outcome'; end if;
  if not caller_deal_ok(did) then raise exception 'This lead is not in the Duet columns anymore'; end if;
  if length(trim(coalesce(p_note,''))) < 5 then raise exception 'Write a short note before saving'; end if;
  if coalesce(p_phone,'') = '' then raise exception 'Pick the number you called'; end if;
  if p_outcome in ('appointment','follow_up') and (p_when is null or p_when < now() - interval '5 minutes') then
    raise exception 'Pick the % date and time (in the future)', case when p_outcome = 'appointment' then 'appointment' else 'callback' end; end if;
  select name into cname from caller_accounts where id = cid;
  select * into d from deals where id = did;
  select * into l from leads where id = d.lead_id;
  owner := coalesce(nullif(trim(l.full_name),''), trim(coalesce(l.first_name,'')||' '||coalesce(l.last_name,'')), d.property_label);
  nxt := case p_outcome when 'follow_up' then p_when when 'no_answer' then now() + interval '2 days' when 'voicemail' then now() + interval '2 days' else null end;
  insert into caller_calls (caller_id, deal_id, lead_id, outcome, phone, talked_to, note, follow_up_at, appt_at)
  values (cid, did, d.lead_id, p_outcome, p_phone, nullif(trim(p_talked_to),''), trim(p_note), nxt, case when p_outcome = 'appointment' then p_when end);

  lbl := case p_outcome when 'appointment' then 'APPOINTMENT SET' when 'follow_up' then 'FOLLOW UP' when 'not_interested' then 'NOT INTERESTED'
           when 'no_answer' then 'NO ANSWER' when 'voicemail' then 'LEFT VOICEMAIL' else 'WRONG NUMBER' end;
  et := to_char(now() at time zone 'America/New_York', 'Mon DD, YYYY HH12:MIam') || ' ET';
  line := '[' || et || '] ' || cname || ' (caller) - ' || lbl || E'\nCalled: ' || p_phone
          || coalesce(E'\nSpoke with: ' || nullif(trim(p_talked_to),''), '') || E'\n' || trim(p_note)
          || case when p_outcome = 'appointment' then E'\nAPPOINTMENT: ' || to_char(p_when at time zone 'America/New_York', 'Dy Mon DD HH12:MIam') || ' ET'
                  when p_outcome = 'follow_up' then E'\nCall back: ' || to_char(p_when at time zone 'America/New_York', 'Dy Mon DD HH12:MIam') || ' ET' else '' end
          || case when p_outcome = 'wrong_number' then E'\n❌ BAD NUMBER - do not call: ' || p_phone else '' end;
  update deals set notes = coalesce(notes,'') || case when coalesce(notes,'') like '%CALLER NOTES%' then E'\n\n' else E'\n\n---------- CALLER NOTES ----------\n' end || line,
         updated_at = now() where id = did;
  if d.lead_id is not null then insert into activity (lead_id, kind, body) values (d.lead_id, 'call', line); end if;

  sid := (select id from board_stages where board = 'seller' and name = case p_outcome when 'appointment' then 'Duet - Appointment Set'
            when 'follow_up' then 'Duet - Follow Up' when 'not_interested' then 'Duet - Not Interested' end);
  if sid is not null then
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

-- 6. text to Damien when an appointment is set (edge function caller-alert sends it through Quo) -------------------
insert into public.app_secrets (name, value) select 'caller_alert', encode(extensions.gen_random_bytes(24), 'hex')
 where not exists (select 1 from public.app_secrets where name = 'caller_alert');
create or replace function public.owner_alert_fire() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  perform net.http_post(url := 'https://gdejlpdltnstbwtdpggm.supabase.co/functions/v1/caller-alert',
    headers := jsonb_build_object('content-type','application/json','x-cron-key',(select value from public.app_secrets where name = 'caller_alert')),
    body := jsonb_build_object('id', new.id));
  return new;
end $$;
drop trigger if exists owner_alert_fire on public.owner_alerts;
create trigger owner_alert_fire after insert on public.owner_alerts for each row execute function public.owner_alert_fire();

-- 7. who can call what ---------------------------------------------------------------------------------------------
revoke all on function public.caller_auth(text), public.caller_new_session(bigint), public.caller_deal_ok(bigint), public.owner_alert_fire() from public, anon, authenticated;
grant execute on function public.caller_accept_invite(text,text,text), public.caller_login(text,text), public.caller_logout(text),
  public.caller_queue(text), public.caller_lead(text,bigint), public.caller_stats(text),
  public.caller_log(text,bigint,text,text,text,text,timestamptz) to anon, authenticated;
