-- DLG HQ MAIL GUARD (Nov 2026)
-- Why: the same owner is often in DLG HQ two or three times (Pebble copy, GHL copy, a misspelled copy like
-- "Guillermo Bermal" / "Guillermo Bernal"), sometimes with the parcel number written two ways (070-05-13-030 vs
-- 0700513030) and sometimes with no zip on the GHL copy. The Due Diligence / Do Not Mail tag sat on one copy and the
-- 90-day check matched by exact ids, so the other copy kept getting letters.
--
-- This file does three things. Run it once in Supabase (paste, then Cmd+Enter):
--   1. Matching keys that ignore those differences: same parcel (county + parcel number with dashes, dots, spaces and
--      leading zeros removed) and same household (mailing address + 5-digit zip, or + city when the zip is missing).
--   2. mail_guard(campaign ids, mail date): Start Mailing calls it and holds every letter that
--        - goes to a person, household or parcel that is in another campaign mailing within 90 days (already sent,
--          at the mail house, or scheduled earlier), or
--        - matches anyone marked Do Not Mail, Due Diligence, not interested / not selling, dead or with a seller deal.
--   3. Tags carry to every copy: tagging Due Diligence (any spelling of the tag) or Do Not Mail now marks every copy
--      of that person (same household or same parcel) and pulls them off lists that haven't gone to the mail house.
--      Plus a one-time catch-up for everyone already tagged.

-- 1. keys -----------------------------------------------------------------------------------------------------------
create or replace function public.mg_apn(county text, apn text) returns text language sql immutable as $$
  select case when coalesce(trim(apn),'') = '' then null else
    lower(trim(coalesce(county,''))) || '|' ||
    nullif(ltrim(regexp_replace(upper(apn), '[^A-Z0-9]', '', 'g'), '0'), '') end
$$;
create or replace function public.mg_hh(addr text, zip text, city text) returns text language sql immutable as $$
  select case when coalesce(regexp_replace(upper(addr), '[^A-Z0-9]', '', 'g'), '') = '' then null
    when coalesce(zip,'') ~ '^\s*\d{5}' then regexp_replace(upper(addr), '[^A-Z0-9]', '', 'g') || '|' || substring(trim(zip) from 1 for 5)
    when coalesce(trim(city),'') <> '' then regexp_replace(upper(addr), '[^A-Z0-9]', '', 'g') || '|' || upper(regexp_replace(city, '[^A-Za-z]', '', 'g'))
    else null end
$$;
create index if not exists properties_mg_apn_idx on properties (mg_apn(county, apn));
create index if not exists leads_mg_hh_idx on leads (mg_hh(mail_address, mail_zip, mail_city));

create or replace function public.mg_bad_lead(l leads) returns boolean language sql stable as $$
  select coalesce(l.do_not_mail,false)
      or coalesce(l.status,'record') in ('dead','not_selling','contacted','interested','offer','under_contract','assigned','closed')
      or exists (select 1 from unnest(coalesce(l.tags,'{}')) t
                 where t ~* '(due diligence|^dd$|do not mail|^dnm$|not interested|not selling|upset|sold or house)')
$$;

-- 2. the guard --------------------------------------------------------------------------------------------------------
create or replace function public.mail_guard(cids bigint[], md date)
returns table(record_id bigint, reason text, other text, other_date date)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  return query
  with mine as (
    select r.id, r.lead_id, r.property_id,
           mg_hh(l.mail_address, l.mail_zip, l.mail_city) as hh, mg_apn(p.county, p.apn) as ak
    from campaign_records r left join leads l on l.id = r.lead_id left join properties p on p.id = r.property_id
    where r.campaign_id = any(cids)),
  win as (
    select c.id, c.name, c.drop_date from campaigns c
    where c.channel = 'mail' and not (c.id = any(cids)) and c.drop_date < '2099-01-01'
      and c.drop_date > md - 90 and c.drop_date < md + 90
      and (c.drop_date <= md or coalesce(c.mail_status,'not_sent') <> 'not_sent')),
  other as (
    select r.id, r.lead_id, r.property_id, w.name, w.drop_date,
           mg_hh(l.mail_address, l.mail_zip, l.mail_city) as hh, mg_apn(p.county, p.apn) as ak
    from campaign_records r join win w on w.id = r.campaign_id
    left join leads l on l.id = r.lead_id left join properties p on p.id = r.property_id),
  hits as (
    select m.id, o.name, o.drop_date from mine m join other o on o.lead_id = m.lead_id
    union all select m.id, o.name, o.drop_date from mine m join other o on o.property_id = m.property_id
    union all select m.id, o.name, o.drop_date from mine m join other o on o.hh = m.hh where m.hh is not null
    union all select m.id, o.name, o.drop_date from mine m join other o on o.ak = m.ak where m.ak is not null),
  recent as (
    select distinct on (h.id) h.id, 'mailed within 90 days'::text as reason, h.name, h.drop_date
    from hits h order by h.id, h.drop_date desc),
  badp as (   -- every parcel and household that belongs to a do-not-mail / Due Diligence / worked person
    select mg_hh(l.mail_address, l.mail_zip, l.mail_city) as hh, null::text as ak, l.full_name from leads l where mg_bad_lead(l)
    union all
    select null, mg_apn(p.county, p.apn), l.full_name from leads l join campaign_records r on r.lead_id = l.id
      join properties p on p.id = r.property_id where mg_bad_lead(l)
    union all
    select null, mg_apn(p.county, p.apn), l.full_name from leads l join property_owners po on po.lead_id = l.id
      join properties p on p.id = po.property_id where mg_bad_lead(l)),
  bad as (
    select m.id, 'do not mail / Due Diligence (another copy of this person)'::text as reason, b.full_name as name, null::date as drop_date
      from mine m join badp b on b.hh = m.hh where m.hh is not null
    union all
    select m.id, 'do not mail / Due Diligence (another copy of this person)', b.full_name, null::date
      from mine m join badp b on b.ak = m.ak where m.ak is not null
    union all
    select m.id, 'do not mail / Due Diligence', l.full_name, null::date
      from mine m join leads l on l.id = m.lead_id where mg_bad_lead(l)
    union all
    select m.id, 'has a seller deal', l.full_name, null::date
      from mine m join deals d on d.lead_id = m.lead_id and coalesce(d.board,'seller') = 'seller' join leads l on l.id = m.lead_id)
  select distinct on (x.id) x.id::bigint, x.reason::text, x.name::text, x.drop_date::date from (select * from bad union all select * from recent) x
  order by x.id, (x.reason = 'mailed within 90 days');
end $$;
revoke execute on function public.mail_guard(bigint[], date) from public, anon;
grant execute on function public.mail_guard(bigint[], date) to authenticated;

-- 3. tags carry to every copy ---------------------------------------------------------------------------------------
create or replace function public.dd_mark_person(lid bigint) returns int
language plpgsql security definer set search_path to 'public' as $$
declare k text; ids bigint[]; n int := 0; dnm boolean;
begin
  select mg_hh(mail_address, mail_zip, mail_city), coalesce(do_not_mail,false) into k, dnm from leads where id = lid;
  select array_agg(distinct x) into ids from (
    select lid as x
    union select id from leads where k is not null and mg_hh(mail_address, mail_zip, mail_city) = k
    union select po2.lead_id from property_owners po join property_owners po2 on po2.property_id = po.property_id where po.lead_id = lid
    union select l2.id from campaign_records cr join properties p on p.id = cr.property_id
          join properties p2 on mg_apn(p2.county, p2.apn) = mg_apn(p.county, p.apn)
          join campaign_records cr2 on cr2.property_id = p2.id join leads l2 on l2.id = cr2.lead_id
          where cr.lead_id = lid and mg_apn(p.county, p.apn) is not null
  ) s where x is not null;
  update leads set tags = array(select distinct unnest(coalesce(tags,'{}') || array['Due Diligence'])), do_not_mail = true
   where id = any(ids) and (not ('Due Diligence' = any(coalesce(tags,'{}'))) or not coalesce(do_not_mail,false));
  delete from campaign_records r using campaigns c
   where c.id = r.campaign_id and r.lead_id = any(ids) and coalesce(c.mail_status,'not_sent') = 'not_sent';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.dd_on_tag() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare was boolean; now_ boolean;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  now_ := exists (select 1 from unnest(coalesce(new.tags,'{}')) t where t ~* '^(due diligence|dd)$');
  was  := exists (select 1 from unnest(coalesce(old.tags,'{}')) t where t ~* '^(due diligence|dd)$');
  if now_ and not was then perform dd_mark_person(new.id); end if;
  return new;
end $$;
drop trigger if exists dd_on_tag on leads;
create trigger dd_on_tag after update of tags on leads for each row execute function dd_on_tag();

-- one-time catch-up: everyone already tagged Due Diligence (any spelling) gets every copy marked
do $$ declare r record; begin
  for r in select id from leads where exists (select 1 from unnest(coalesce(tags,'{}')) t where t ~* '^(due diligence|dd)$') loop
    perform dd_mark_person(r.id);
  end loop;
end $$;

-- check: should list Guillermo's 3 copies, all do_not_mail = true
select id, full_name, do_not_mail, tags from leads where mail_address ilike '%annafrel%' or full_name ilike '%guillermo%berna%';
