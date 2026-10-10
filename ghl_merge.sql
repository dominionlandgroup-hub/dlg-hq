-- ===== GHL MERGE: part 1 (indexes + matching) =====
create index if not exists leads_src_idx on leads (source, source_id);
create index if not exists props_src_idx on properties (source, source_id);
create index if not exists stg_ghl_cid on stg_ghl (cid);
update stg_ghl set lead_id = null, prop_id = null;
update stg_ghl s set lead_id = l.id from leads l where l.source = 'ghl' and l.source_id = s.cid;
update stg_ghl s set lead_id = (select l.id from leads l where phone10(l.phone) = phone10(s.phone) order by (l.source = 'pebble') desc, l.id limit 1)
  where s.lead_id is null and length(phone10(s.phone)) = 10;
update stg_ghl s set lead_id = (select l.id from leads l where lower(l.full_name) = lower(trim(concat_ws(' ', s.first, s.last)))
    and lower(coalesce(l.mail_address, '')) = lower(s.maddr) limit 1)
  where s.lead_id is null and coalesce(s.first, s.last) is not null and s.maddr is not null;
select count(*) total, count(lead_id) matched from stg_ghl;

-- ===== part 2 (new contacts + update matched) =====
create or replace function ghl_tags(t text, dnd text) returns text[] language sql immutable as $$
  select array(select distinct x from (
    select trim(u) x from unnest(string_to_array(coalesce(t,''), ',')) u where trim(u) <> ''
    union all select 'GHL'
    union all select 'Not selling' where lower(coalesce(t,'')) ~ '(not selling|not interested)'
    union all select 'Opted out' where lower(coalesce(t,'')) ~ 'opted out'
    union all select 'Overpriced' where lower(coalesce(t,'')) ~ 'overpriced'
    union all select 'DNC' where lower(coalesce(dnd,'')) in ('true','yes','1','all')
  ) y) $$;
insert into leads (first_name, last_name, full_name, phone, email, mail_address, mail_city, mail_state, mail_zip,
  prop_address, prop_city, prop_state, prop_zip, county, apn, acres, offer_code, status, lead_source, tags, source, source_id, created_at, inbox)
select s.first, s.last, coalesce(nullif(trim(concat_ws(' ', s.first, s.last)), ''), s.owner_full), s.phone, s.email, s.maddr, s.mcity, s.mstate, s.mzip,
  coalesce(s.pstreet, s.street), coalesce(s.pcity, s.city), coalesce(s.pstate, s.state), coalesce(s.pzip, s.zip), s.county,
  coalesce(s.apn, s.parcel, s.sellers_apn),
  case when s.acres ~ '^\s*[0-9]*\.?[0-9]+\s*$' then s.acres::numeric end,
  s.code, 'record', 'mail', ghl_tags(s.tags, s.dnd), 'ghl', s.cid,
  case when s.created ~ '^\d{4}-\d{2}-\d{2}' then s.created::timestamptz else now() end, 'seller'
from stg_ghl s where s.lead_id is null;
update stg_ghl s set lead_id = l.id from leads l where s.lead_id is null and l.source = 'ghl' and l.source_id = s.cid;
update leads l set tags = (select array(select distinct x from unnest(coalesce(l.tags, '{}') || ghl_tags(s.tags, s.dnd)) x)),
  phone = coalesce(l.phone, s.phone), email = coalesce(l.email, s.email), offer_code = coalesce(l.offer_code, s.code)
from stg_ghl s where l.id = s.lead_id and l.source <> 'ghl';
select count(*) from leads where source = 'ghl';

-- ===== part 3 (properties, owners, old offer codes) =====
update stg_ghl s set prop_id = (select p.id from properties p where p.apn = coalesce(s.apn, s.parcel, s.sellers_apn)
    and (s.county is null or p.county is null or lower(p.county) = lower(s.county)) limit 1)
  where coalesce(s.apn, s.parcel, s.sellers_apn) is not null;
insert into properties (apn, address, city, state, zip, county, county_state, acres, lat, lng, source, source_id)
select coalesce(s.apn, s.parcel, s.sellers_apn), coalesce(s.pstreet, s.street), coalesce(s.pcity, s.city), coalesce(s.pstate, s.state), coalesce(s.pzip, s.zip),
  s.county, case when s.county is not null then s.county || ', ' || coalesce(s.pstate, s.state, '') end,
  case when s.acres ~ '^\s*[0-9]*\.?[0-9]+\s*$' then s.acres::numeric end,
  case when s.lat ~ '^-?[0-9.]+$' then s.lat::double precision end, case when s.lng ~ '^-?[0-9.]+$' then s.lng::double precision end, 'ghl', s.cid
from stg_ghl s where s.prop_id is null and coalesce(s.apn, s.parcel, s.sellers_apn, s.pstreet, s.street) is not null;
update stg_ghl s set prop_id = p.id from properties p where s.prop_id is null and p.source = 'ghl' and p.source_id = s.cid;
insert into property_owners (property_id, lead_id) select distinct prop_id, lead_id from stg_ghl where prop_id is not null and lead_id is not null on conflict do nothing;
create table if not exists legacy_codes (id bigint generated always as identity primary key, code text, lead_id bigint, property_id bigint, source text, list text, created_at timestamptz);
alter table legacy_codes enable row level security;
drop policy if exists "owner all" on legacy_codes;
create policy "owner all" on legacy_codes for all to authenticated using (true) with check (true);
delete from legacy_codes where source = 'ghl';
insert into legacy_codes (code, lead_id, property_id, source, list, created_at)
select upper(s.code), s.lead_id, s.prop_id, 'ghl', s.tags, case when s.created ~ '^\d{4}-\d{2}-\d{2}' then s.created::timestamptz end from stg_ghl s where s.code is not null;
create index if not exists legacy_codes_code_trgm on legacy_codes using gin (code gin_trgm_ops);
select (select count(*) from legacy_codes) codes, (select count(*) from properties where source = 'ghl') new_props;
