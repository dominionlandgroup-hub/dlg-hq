-- DLG HQ bug sweep (Nov 5, 2026). Run once in the Supabase SQL editor (safe to run again: every step checks first).
-- Read the NOTICE lines in the output: they say what was changed and anything that needs a look.
--
--  1. Rate-limit table + helper for the public forms
--  2. Offer codes: one case-insensitive "is this code taken anywhere" check (campaign records, contacts, old Pebble/GHL codes),
--     used by import_campaign_list; indexes for it
--  3. Unique offer codes: unique index on campaign_records(upper(btrim(offer_code))) - only if there are no duplicates today
--  4. tasks.done_at (Tasks page "Done recently" order)
--  5. Security: who may call each SECURITY DEFINER function
--  6. Buy box form (submit_buybox): only a personal link (token / code) updates a buyer; rate limit; no carriage returns
--  7. Website form (submit_web_lead / web_offer_lookup): a code only links to the owner on file when the name/property matches,
--     never overwrites a contact's phone/email; rate limits
--  8. Testimonial email template: (704) 387-3482 instead of the mail-only tracking number

begin;

-- ============================================================================================================
-- 1) Rate limits for the public forms. Only SECURITY DEFINER functions read/write this table (RLS on, no policies).
-- ============================================================================================================
create table if not exists form_submissions (
  id bigint generated always as identity primary key,
  form text not null,          -- 'buybox', 'web_lead', 'web_lookup'
  key text,                    -- email / phone (lower case, digits)
  ip text,                     -- first x-forwarded-for address PostgREST passes in request.headers
  created_at timestamptz not null default now());
alter table form_submissions enable row level security;
revoke all on form_submissions from anon, authenticated;
create index if not exists form_submissions_form_at_idx on form_submissions (form, created_at);
create index if not exists form_submissions_key_idx on form_submissions (form, key, created_at);

-- Raises 'Too many submissions...' when this key (per p_key_window), this IP (per hour) or the form overall (per p_all_window)
-- is over its limit; otherwise records the submission. Old rows are cleared now and then.
create or replace function form_rate_check(p_form text, p_key text, p_key_max int, p_key_window interval,
  p_all_max int, p_all_window interval, p_ip_max int default 20)
returns void language plpgsql security definer set search_path = public as $$
declare v_ip text; v_key text := nullif(lower(btrim(coalesce(p_key,''))),'');
begin
  begin v_ip := nullif(left(btrim(split_part(nullif(current_setting('request.headers', true),'')::json->>'x-forwarded-for', ',', 1)), 64), '');
  exception when others then v_ip := null; end;
  if v_key is not null and p_key_max is not null and (select count(*) from form_submissions
       where form = p_form and key = v_key and created_at > now() - p_key_window) >= p_key_max then
    raise exception 'Too many submissions. Please try again later, or call (704) 387-3482.'; end if;
  if v_ip is not null and p_ip_max is not null and (select count(*) from form_submissions
       where form = p_form and ip = v_ip and created_at > now() - interval '1 hour') >= p_ip_max then
    raise exception 'Too many submissions. Please try again later, or call (704) 387-3482.'; end if;
  if p_all_max is not null and (select count(*) from form_submissions
       where form = p_form and created_at > now() - p_all_window) >= p_all_max then
    raise exception 'Too many submissions right now. Please try again in an hour, or call (704) 387-3482.'; end if;
  insert into form_submissions (form, key, ip) values (p_form, v_key, v_ip);
  if random() < 0.02 then delete from form_submissions where created_at < now() - interval '3 days'; end if;
end $$;
revoke all on function form_rate_check(text,text,int,interval,int,interval,int) from public, anon, authenticated;

-- ============================================================================================================
-- 2) Offer codes: taken anywhere? Case-insensitive, spaces trimmed. 'family' legacy rows are copies (family.sql), not uses.
-- ============================================================================================================
create index if not exists leads_offer_code_up_idx on leads (upper(btrim(offer_code))) where offer_code is not null;
create index if not exists legacy_codes_code_up_idx on legacy_codes (upper(btrim(code))) where code is not null;
create index if not exists campaign_records_offer_code_up_idx on campaign_records (upper(btrim(offer_code))) where offer_code is not null;

create or replace function offer_code_taken(c text) returns boolean language sql stable set search_path = public as $$
  select nullif(btrim(coalesce(c,'')),'') is not null and (
       exists (select 1 from campaign_records where upper(btrim(offer_code)) = upper(btrim(c)))
    or exists (select 1 from leads where upper(btrim(offer_code)) = upper(btrim(c)))
    or exists (select 1 from legacy_codes where upper(btrim(code)) = upper(btrim(c)) and coalesce(source,'') <> 'family'))
$$;
grant execute on function offer_code_taken(text) to authenticated, service_role;

-- import_campaign_list: the duplicate-code check compared offer_code = upper(code) (case-sensitive on the stored side, and
-- only campaign records). Swap in offer_code_taken(code) in whichever version is live (import_list.sql or
-- sql/fix_import_negtags.sql), so the rest of the live function (its skip rules) is left exactly as it is.
do $$
declare f regprocedure := to_regprocedure('import_campaign_list(bigint,jsonb,text,text,boolean,boolean,integer)'); src text; nsrc text;
begin
  if f is null then raise notice 'import_campaign_list not found - run import_list.sql first, then this file again.'; return; end if;
  src := pg_get_functiondef(f);
  if position('offer_code_taken(code)' in src) > 0 then raise notice 'import_campaign_list already uses offer_code_taken - no change.'; return; end if;
  nsrc := replace(src, 'exists (select 1 from campaign_records where offer_code=upper(code))', 'offer_code_taken(code)');
  if nsrc = src then raise notice 'import_campaign_list: duplicate-code line not found (the live version differs) - NOT changed. Check it by hand.'; return; end if;
  execute nsrc;
  raise notice 'import_campaign_list: duplicate-code check is now case-insensitive and covers contacts and old codes.';
end $$;

-- ============================================================================================================
-- 3) Unique offer codes on campaign records (case-insensitive). Created only when there are no duplicates today;
--    otherwise the duplicates are listed (fix them with offer_codes_check.sql, then run this file again).
-- ============================================================================================================
do $$
declare d text; n int;
begin
  if to_regclass('public.campaign_records_offer_code_uidx') is not null then raise notice 'Unique offer code index already exists.'; return; end if;
  select count(*), string_agg(c || ' (x' || k || ')', ', ') into n, d from (
    select upper(btrim(offer_code)) c, count(*) k from campaign_records where offer_code is not null and btrim(offer_code) <> ''
    group by 1 having count(*) > 1 order by 1 limit 300) x;
  if coalesce(n,0) > 0 then
    raise notice 'Unique offer code index NOT created: % codes are used more than once: %', n, d;
  else
    execute 'create unique index campaign_records_offer_code_uidx on campaign_records (upper(btrim(offer_code))) where offer_code is not null and btrim(offer_code) <> ''''';
    raise notice 'Unique offer code index created: no two campaign records can share a code (any case).';
  end if;
end $$;

-- ============================================================================================================
-- 4) Tasks: when a task was finished (the app writes it when you tick a task)
-- ============================================================================================================
alter table tasks add column if not exists done_at timestamptz;
create index if not exists tasks_done_at_idx on tasks (done_at desc) where status = 'done';

-- ============================================================================================================
-- 5) Security. Postgres lets PUBLIC (which includes anon) execute every new function unless it is revoked FROM PUBLIC;
--    "revoke ... from anon, authenticated" alone left them open through PUBLIC.
-- ============================================================================================================
-- quo_thread: the quo edge function (service role) and the app's follow-ups (signed in) call it; the public never should
do $$ begin
  if to_regprocedure('quo_thread(text,text)') is not null then
    revoke all on function quo_thread(text,text) from public, anon;
    grant execute on function quo_thread(text,text) to authenticated, service_role;
    raise notice 'quo_thread: signed-in users and the service role only.';
  end if;
end $$;
-- bb_email (buy box drip text): used by buybox_run / buybox_preview; signed-in and service role only
do $$ declare f record; begin
  for f in select p.oid::regprocedure fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'bb_email' loop
    execute format('revoke all on function %s from public, anon', f.fn);
    execute format('grant execute on function %s to authenticated, service_role', f.fn);
  end loop;
end $$;
-- trigger functions: never called directly
do $$ declare f record; begin
  for f in select p.oid::regprocedure fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('deal_closed_testimonial','buybox_alert_trg') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.fn);
  end loop;
end $$;
-- already locked down by their own files; repeated here so a re-run of an old file can't reopen them
do $$ begin
  if to_regprocedure('ai_readonly_query(text)') is not null then
    revoke all on function ai_readonly_query(text) from public, anon, authenticated; grant execute on function ai_readonly_query(text) to service_role; end if;
  if to_regprocedure('buybox_run()') is not null then revoke all on function buybox_run() from public, anon, authenticated; end if;
end $$;

-- ============================================================================================================
-- 6) Buy box form
-- ============================================================================================================
alter table buyers add column if not exists needs_review text;   -- why a submission needs a look (shown nowhere yet; filter on it)

-- same as sql/buybox_form_fix.sql (keeps the order typed, keeps the buyer's own words for cities)
create or replace function public.bb_list(s text) returns text[] language sql immutable as $$
  select coalesce(array(
    select x from (
      select trim(x) x, min(n) n
      from regexp_split_to_table(left(coalesce(s,''),2000), '[,;\n]+') with ordinality t(x,n)
      where trim(x) <> ''
      group by trim(x)
    ) q order by n limit 80), '{}')
$$;
create or replace function public.bb_text(s text) returns text language sql immutable as $$
  select nullif(trim(regexp_replace(left(coalesce(s,''),1500), '\s+', ' ', 'g')), '')
$$;

-- Only the buyer's personal link (bb_token / bb_code) updates an existing buyer. A form sent WITHOUT the link whose email
-- matches a buyer does not touch that buyer: it is saved as a new buyer row with needs_review set, and the task says so.
-- Limits: 5 per email per day, 20 per IP per hour, 30 per hour overall.
create or replace function public.submit_buybox(p jsonb) returns text
language plpgsql security definer set search_path to 'public' as $function$
declare bid bigint; prev bigint; em text; nm text; tok uuid; zz text[]; t text;
begin
  -- no carriage returns in anything typed
  select coalesce(jsonb_object_agg(k, case when jsonb_typeof(v) = 'string' then to_jsonb(replace(v #>> '{}', chr(13), '')) else v end), '{}'::jsonb)
    into p from jsonb_each(coalesce(p,'{}'::jsonb)) e(k, v);
  em := lower(trim(left(coalesce(p->>'email',''),200))); nm := trim(left(coalesce(p->>'name',''),120)); t := coalesce(p->>'t','');
  if nm = '' or em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Please enter your name and a valid email.'; end if;
  if coalesce(p->>'website','') <> '' then return 'ok'; end if;   -- honeypot
  perform form_rate_check('buybox', em, 5, interval '1 day', 30, interval '1 hour');
  begin tok := nullif(t,'')::uuid; exception when others then tok := null; end;
  if tok is not null then select id into bid from buyers where bb_token = tok; end if;
  if bid is null and t ~ '^[A-Za-z0-9]{6}$' then select id into bid from buyers where bb_code = lower(t); end if;
  if bid is null then
    select id into prev from buyers where lower(email) = em order by id limit 1;
    insert into buyers (name, email, kind, bb_status, needs_review)
    values (nm, em, 'buyer', 'not sent', case when prev is not null then
      'Buy box sent without their personal link; same email as buyer #' || prev || ' (that buyer was not changed). Merge or delete.' end)
    returning id into bid;
  end if;
  -- zips in the order typed, no repeats
  select coalesce(array_agg(z order by n),'{}') into zz from (
    select z, min(n) n from regexp_matches(coalesce(p->>'zips',''), '\m\d{5}\M', 'g') with ordinality m(a,n), lateral (select a[1] z) s group by z) q;
  update buyers set
   name = nm, first_name = split_part(nm,' ',1), email = em,
   company = nullif(trim(left(coalesce(p->>'company',''),160)),''),
   phone = coalesce(nullif(trim(left(coalesce(p->>'phone',''),40)),''), phone),
   role = nullif(left(coalesce(p->>'role',''),80),''),
   kind = case when coalesce(p->>'role','') ilike 'agent%' then 'agent' else coalesce(kind,'buyer') end,
   represents = nullif(trim(left(coalesce(p->>'represents',''),1000)),''),
   send_by = bb_arr(p,'send_by'), cities = bb_list(p->>'cities'), zips = zz,
   price_ranges = bb_arr(p,'price'), lot_sizes = bb_arr(p,'lot_size'), lot_type = nullif(left(coalesce(p->>'lot_type',''),40),''),
   utilities = bb_arr(p,'utilities'), recent_lot = nullif(trim(left(coalesce(p->>'recent_lot',''),300)),''),
   deal_breakers = nullif(trim(left(coalesce(p->>'deal_breakers',''),1000)),''), lots_per_year = nullif(left(coalesce(p->>'per_year',''),20),''),
   counties = case when coalesce(array_length(counties,1),0) = 0 then bb_list(p->>'counties') else counties end,
   buy_box = left(concat_ws(' · ', bb_text(p->>'cities'), nullif(array_to_string(bb_arr(p,'price'),', '),''), nullif(array_to_string(bb_arr(p,'lot_size'),', '),''), nullif(p->>'lot_type','')), 1500),
   bb_status = 'got buy box', bb_submitted_at = now()
  where id = bid;
  insert into tasks (title, due_at, status) values ('New buy box: ' || nm || coalesce(' (' || nullif(trim(p->>'company'),'') || ')', '')
    || case when prev is not null then ' (check: same email as buyer #' || prev || ', saved as a new buyer)' else '' end, now(), 'todo');
  return 'ok';
end $function$;
revoke all on function public.submit_buybox(jsonb) from public;
grant execute on function public.submit_buybox(jsonb) to anon, authenticated;

-- buybox_prefill isn't in the repo: keep it callable by the public form (no other change)
do $$ declare f record; begin
  for f in select p.oid::regprocedure fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'buybox_prefill' loop
    execute format('grant execute on function %s to anon, authenticated', f.fn);
  end loop;
end $$;

-- ============================================================================================================
-- 7) Website form
-- ============================================================================================================
-- Does what someone typed match the owner on file? A shared name word (3+ letters, not LLC/Inc/Trust...), the same house number
-- and street word, or the same parcel number.
create or replace function web_lead_matches(s_name text, s_addr text, s_apn text, o_name text, o_addr text, o_apn text)
returns boolean language sql immutable set search_path = public as $$
  select
    exists (select 1 from regexp_split_to_table(lower(coalesce(s_name,'')), '[^a-z]+') w
            where length(w) >= 3 and w not in ('llc','inc','the','and','trust','trustee','estate','heirs','family','properties','property','company','corp','land','homes','group','holdings','church')
              and w = any(regexp_split_to_array(lower(coalesce(o_name,'')), '[^a-z]+')))
    or (coalesce(o_addr,'') <> '' and substring(lower(coalesce(s_addr,'')) from '^\s*(\d+)') is not null
        and substring(lower(s_addr) from '^\s*(\d+)') = substring(lower(o_addr) from '^\s*(\d+)')
        and exists (select 1 from regexp_split_to_table(lower(s_addr), '[^a-z]+') w where length(w) >= 4 and position(w in lower(o_addr)) > 0))
    or (length(regexp_replace(coalesce(s_apn,''), '\D', '', 'g')) >= 6
        and regexp_replace(s_apn, '\D', '', 'g') = regexp_replace(coalesce(o_apn,''), '\D', '', 'g'))
$$;

-- Website form -> contact + Seller Inbox thread. The offer code marks the campaign record "responded" and links the message to
-- that owner ONLY when the name, property address or APN matches the owner on file; otherwise the code is just written in the
-- message for you to check. An existing contact's phone / email are never changed by the form (they are in the message).
-- Limits: 5 per phone or email per day, 20 per IP per hour, 30 per hour overall.
create or replace function submit_web_lead(
  p_name text, p_phone text, p_email text, p_address text, p_county text,
  p_apn text, p_offer_code text, p_message text)
returns bigint language plpgsql security definer set search_path = public as $$
declare lid bigint; tid bigint; rid bigint; rlid bigint; o_name text; o_addr text; o_apn text; matched boolean := false;
  code text; d text; body text;
begin
  p_name := left(btrim(replace(coalesce(p_name,''),chr(13),'')),200); p_phone := left(btrim(replace(coalesce(p_phone,''),chr(13),'')),40);
  p_email := left(btrim(replace(coalesce(p_email,''),chr(13),'')),200); p_address := left(btrim(replace(coalesce(p_address,''),chr(13),'')),300);
  p_county := left(btrim(replace(coalesce(p_county,''),chr(13),'')),80); p_apn := left(btrim(replace(coalesce(p_apn,''),chr(13),'')),80);
  p_message := left(replace(coalesce(p_message,''),chr(13),''),2000);
  code := upper(btrim(left(coalesce(p_offer_code,''),40))); d := phone10(p_phone);
  if p_phone = '' and p_email = '' then raise exception 'phone or email required'; end if;
  perform form_rate_check('web_lead', coalesce(nullif(d,''), lower(p_email)), 5, interval '1 day', 30, interval '1 hour');
  if code <> '' then
    select r.id, r.lead_id, l.full_name, pr.address, pr.apn into rid, rlid, o_name, o_addr, o_apn
      from campaign_records r left join leads l on l.id = r.lead_id left join properties pr on pr.id = r.property_id
      where upper(btrim(r.offer_code)) = code order by r.id desc limit 1;
    if rid is not null and web_lead_matches(p_name, p_address, p_apn, o_name, o_addr, o_apn) then
      matched := true; lid := rlid;
      update campaign_records set responded = true where id = rid;
    end if;
  end if;
  if lid is null and length(d) = 10 then
    select id into lid from leads where phone10(phone) = d or phone10(phone2) = d or phone10(phone3) = d order by id limit 1;
  end if;
  if lid is null then
    insert into leads (full_name, phone, email, prop_address, county, apn, offer_code, status, lead_source, source, notes, inbox)
    values (nullif(p_name,''), nullif(p_phone,''), nullif(p_email,''), nullif(p_address,''), nullif(p_county,''), nullif(p_apn,''),
            case when matched then code end, 'new', 'website', 'web', nullif(p_message,''), 'seller')
    returning id into lid;
  else
    update leads set status = case when status = 'record' then 'new' else status end, lead_source = coalesce(lead_source,'website') where id = lid;
  end if;
  select id into tid from threads where lead_id = lid and inbox = 'seller' order by last_at desc nulls last limit 1;
  if tid is null then
    insert into threads (inbox, lead_id, title, phone, email, last_at, source, pinned, archived, muted)
    values ('seller', lid, coalesce(nullif(p_name,''), nullif(p_phone,''), p_email), nullif(p_phone,''), nullif(p_email,''), now(), 'web', false, false, false)
    returning id into tid;
  end if;
  body := 'Website form' ||
    case when p_name <> '' then E'\nName: ' || p_name else '' end ||
    case when p_phone <> '' then E'\nPhone: ' || p_phone else '' end ||
    case when p_email <> '' then E'\nEmail: ' || p_email else '' end ||
    case when code <> '' then E'\nOffer code: ' || code ||
      case when rid is null then ' (not found)' when not matched then ' (CHECK: name/property did not match the owner on file, so it was not linked)' else '' end else '' end ||
    case when p_address <> '' then E'\nProperty: ' || p_address else '' end ||
    case when p_county <> '' then E'\nCounty: ' || p_county else '' end ||
    case when p_apn <> '' then E'\nAPN: ' || p_apn else '' end ||
    case when p_message <> '' then E'\n\n' || p_message else '' end;
  insert into messages (thread_id, lead_id, inbox, channel, direction, body, their_number, is_read)
  values (tid, lid, 'seller', 'web', 'in', body, nullif(p_phone,''), false);
  update threads set last_at = now(), archived = false where id = tid;
  insert into activity (lead_id, kind, body) values (lid, 'note', 'Submitted website form');
  return lid;
end $$;
revoke all on function submit_web_lead(text,text,text,text,text,text,text,text) from public;
grant execute on function submit_web_lead(text,text,text,text,text,text,text,text) to anon, authenticated;

-- "Got a letter from us?" lookup: only says whether a code exists, never changes anything. Rate limited (codes are sequential):
-- 30 per IP per hour, 300 per hour overall.
create or replace function web_offer_lookup(p_code text) returns boolean language plpgsql security definer set search_path = public as $$
begin
  if btrim(coalesce(p_code,'')) = '' then return false; end if;
  perform form_rate_check('web_lookup', null, null, null, 300, interval '1 hour', 30);
  return exists (select 1 from campaign_records where upper(btrim(offer_code)) = upper(btrim(p_code)));
end $$;
revoke all on function web_offer_lookup(text) from public;
grant execute on function web_offer_lookup(text) to anon, authenticated;

-- ============================================================================================================
-- 8) Testimonial request email: (980) 990-2356 is the direct-mail tracking line; emails use (704) 387-3482
-- ============================================================================================================
update templates set body = replace(body, '(980) 990-2356', '(704) 387-3482'), updated_at = now()
where name = 'Testimonial request' and body like '%990-2356%';

commit;

-- ============================================================================================================
-- Report (read only)
-- ============================================================================================================
do $$ declare r record; begin
  -- SECURITY DEFINER functions the public (anon) can still run. The public forms are expected here; anything else, look at it.
  for r in select p.oid::regprocedure fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')
             and p.proname not in ('submit_buybox','buybox_prefill','submit_web_lead','web_offer_lookup','public_testimonials','mailhouse_campaign','mailhouse_update')
           order by 1 loop
    raise notice 'CHECK: anon can run security definer function %', r.fn;
  end loop;
  for r in select kind, name from templates where body like '%990-2356%' or coalesce(subject,'') like '%990-2356%' loop
    raise notice 'CHECK: template "%" (%) still shows the mail-only number (980) 990-2356', r.name, r.kind;
  end loop;
end $$;
