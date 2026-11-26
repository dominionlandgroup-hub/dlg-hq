-- DLG HQ CALLERS, part 3 (Nov 25, 2026): a TEST caller with TEST leads, so Damien can click every button
-- before Olivia starts. A test caller sees ONLY the 🧪 TEST leads; real callers never see them.
-- Everything a test caller does is real (notes, columns, tasks, and the text to Damien), just on fake leads.
-- To clean up later: delete the 🧪 TEST cards from the Duet columns and turn the test caller off.

alter table public.caller_accounts add column if not exists is_test boolean not null default false;

-- leads with no contact record (the test cards) read owner/address from as_meta
create or replace function public.caller_lead_core(did bigint) returns json language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
  if not caller_deal_ok(did) then raise exception 'This lead is not in the Duet columns anymore'; end if;
  select json_build_object(
    'deal_id', d.id, 'label', d.property_label, 'stage', s.name, 'notes', d.notes,
    'owner', coalesce(nullif(trim(l.full_name),''), nullif(trim(coalesce(l.first_name,'')||' '||coalesce(l.last_name,'')),''), d.as_meta->>'owner'),
    'first_name', coalesce(l.first_name, d.as_meta->>'first_name'), 'last_name', coalesce(l.last_name, d.as_meta->>'last_name'),
    'street', coalesce(p.address, l.prop_address, d.as_meta->>'street'), 'city', coalesce(p.city, l.prop_city, d.as_meta->>'city'),
    'phones', array_remove(array[l.phone, l.phone2, l.phone3], null),
    'mail', concat_ws(', ', l.mail_address, l.mail_city, l.mail_state, l.mail_zip),
    'property', coalesce(nullif(concat_ws(', ', coalesce(p.address, l.prop_address), coalesce(p.city, l.prop_city), coalesce(p.state, l.prop_state)),''),
                         concat_ws(', ', d.as_meta->>'street', d.as_meta->>'city', 'NC')),
    'county', coalesce(p.county, l.county, d.as_meta->>'county'), 'apn', coalesce(p.apn, l.apn), 'acres', coalesce(p.acres::text, l.acres::text),
    'calls', (select coalesce(json_agg(json_build_object('at', c.created_at, 'outcome', c.outcome, 'phone', c.phone, 'talked_to', c.talked_to, 'note', c.note,
                'by', a.name, 'next', c.follow_up_at, 'appt', c.appt_at) order by c.created_at desc), '[]'::json)
              from caller_calls c left join caller_accounts a on a.id = c.caller_id where c.deal_id = d.id))
    into r
    from deals d join board_stages s on s.id = d.stage_id left join leads l on l.id = d.lead_id left join properties p on p.id = d.property_id
   where d.id = did;
  return r;
end $$;

-- queue: real callers get 📞 leads (never 🧪 TEST), a test caller gets only 🧪 TEST leads
drop function if exists public.caller_queue_core();
create or replace function public.caller_queue_core(p_test boolean default false) returns json language plpgsql stable security definer set search_path = public as $$
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
       and coalesce((select bool_and(c3.outcome in ('no_answer','voicemail')) and count(*) = 3
                       from (select outcome from caller_calls c where c.deal_id = d.id order by created_at desc limit 3) c3), false) = false
  ) q), '[]'::json);
end $$;

create or replace function public.caller_queue(tok text) returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok);
begin return caller_queue_core(coalesce((select is_test from caller_accounts where id = cid), false)); end $$;

create or replace function public.owner_preview_queue(cid bigint default null) returns json language sql stable security definer set search_path = public as $$
  select caller_queue_core(coalesce((select is_test from caller_accounts where id = cid), false)); $$;

revoke all on function public.caller_queue_core(boolean) from public, anon, authenticated;
revoke all on function public.owner_preview_queue(bigint) from public, anon;
grant execute on function public.owner_preview_queue(bigint) to authenticated;
grant execute on function public.caller_queue(text) to anon, authenticated;
drop function if exists public.owner_preview_queue();

-- the test caller + 5 test leads (only once)
do $$ declare sid_first bigint; sid_union bigint; sid_gaston bigint; sid_low bigint; sid_skip bigint; begin
  if exists (select 1 from caller_accounts where is_test) then return; end if;
  insert into caller_accounts (name, call_name, is_test, invite_token, invite_expires)
  values ('Damien (TEST)', 'Olivia', true, encode(extensions.gen_random_bytes(18), 'hex'), now() + interval '14 days');
  select id into sid_first from board_stages where board='seller' and name like 'Duet - %Call First' limit 1;
  select id into sid_union from board_stages where board='seller' and name like 'Duet - Union%' limit 1;
  select id into sid_gaston from board_stages where board='seller' and name like 'Duet - Gaston%' limit 1;
  select id into sid_low from board_stages where board='seller' and name = 'Duet - Low Priority' limit 1;
  select id into sid_skip from board_stages where board='seller' and name = 'Duet - Needs Skip Trace' limit 1;
  insert into deals (board, stage_id, stage, status, position, property_label, as_meta, notes) values
  ('seller', sid_first, (select name from board_stages where id = sid_first), 'open', 0, '🧪 TEST - Johnson - 2364 Main St, Monroe',
   '{"owner":"Walter Johnson (TEST)","first_name":"Walter","last_name":"Johnson","street":"2364 Main St","city":"Monroe","county":"Union"}',
   E'SUMMARY - TEST LEAD (fake, for practice)\nOwner Walter Johnson is DECEASED (2021). Do not use his numbers.\nCall: Gloria Johnson (daughter), Charlotte NC\n\nWalter Johnson - DECEASED - DO NOT USE\n(704) 555-0100 mobile\n\nGloria Johnson - daughter (MAIN)\n(704) 555-0101 mobile\n(704) 555-0102 landline\n\nMarcus Johnson - son, Atlanta GA\n(404) 555-0103 mobile'),
  ('seller', sid_union, (select name from board_stages where id = sid_union), 'open', 0, '🧪 TEST - Smith - 410 Oak St, Monroe',
   '{"owner":"Linda Smith (TEST)","first_name":"Linda","last_name":"Smith","street":"410 Oak St","city":"Monroe","county":"Union"}',
   E'SUMMARY - TEST LEAD (fake, for practice)\nOwner is alive, lives out of state.\nCall: Linda Smith (owner), Columbia SC\n\nLinda Smith - owner (MAIN)\n(803) 555-0110 mobile\n(803) 555-0111 landline'),
  ('seller', sid_gaston, (select name from board_stages where id = sid_gaston), 'open', 0, '🧪 TEST - Brown - 88 Pine Ave, Gastonia',
   '{"owner":"Estate of Harold Brown (TEST)","first_name":"Harold","last_name":"Brown","street":"88 Pine Ave","city":"Gastonia","county":"Gaston"}',
   E'SUMMARY - TEST LEAD (fake, for practice)\nOwner Harold Brown is DECEASED.\nCall: Denise Brown (niece), Gastonia NC\n\nDenise Brown - niece (MAIN)\n(980) 555-0120 mobile'),
  ('seller', sid_low, (select name from board_stages where id = sid_low), 'open', 0, '🧪 TEST - Davis - 15 Elm St, Lincolnton',
   '{"owner":"Robert Davis (TEST)","first_name":"Robert","last_name":"Davis","street":"15 Elm St","city":"Lincolnton","county":"Lincoln"}',
   E'SUMMARY - TEST LEAD (fake, for practice)\nAll numbers on this lead are bad - practice the Needs skip trace box.\nCall: Robert Davis (owner)\n\nRobert Davis - owner\n❌ (704) 555-0130 - wrong number\n❌ (704) 555-0131 - disconnected'),
  ('seller', sid_skip, (select name from board_stages where id = sid_skip), 'open', 0, '🧪 TEST - Wilson - 9 Cedar Ln, Rock Hill',
   '{"owner":"Mary Wilson (TEST)","first_name":"Mary","last_name":"Wilson","street":"9 Cedar Ln","city":"Rock Hill","county":"York"}',
   E'SUMMARY - TEST LEAD (fake, for practice)\nNo good numbers. Practice the skip trace form: type any 555 number and save.\nCall: Mary Wilson (owner)');
  -- the Wilson card needs a skip_trace call on it to show in the Skip trace list
  insert into caller_calls (caller_id, deal_id, outcome, note, prev_stage_id)
  select (select id from caller_accounts where is_test), d.id, 'skip_trace', 'TEST: all numbers bad', sid_first
    from deals d where d.property_label like '🧪 TEST - Wilson%';
end $$;

select id, name, 'https://landiq.land/caller.html?invite=' || invite_token as invite_link from caller_accounts where is_test;
