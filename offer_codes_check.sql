-- Offer code check (DLG HQ). Run in the Supabase SQL editor. Steps 1-5 only read; nothing changes.
-- Why: assign_offer_codes pads the record number with lpad(n::text,3,'0'). Postgres lpad CUTS text longer than 3,
-- so record 1000 becomes "-100", 1001 becomes "-101"... and repeats codes already on that campaign.

-- 1) Show the source of the code functions (copy the result into a new query for step 6)
select pg_get_functiondef('assign_offer_codes'::regproc);
select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('next_code_prefix', 'campaign_remarket', 'campaign_split');

-- 2) Every function that pads with lpad or touches offer codes
select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and (p.prosrc ilike '%lpad%' or p.prosrc ilike '%offer_code%');

-- 3) Every offer code used more than once anywhere in DLG HQ (campaign records, contacts, old Pebble/GHL codes),
--    with the campaigns and owners that share it. Contacts' own copies of their campaign record's code are not counted.
with uses as (
  select upper(trim(r.offer_code)) code, 'campaign record' kind, c.name campaign, l.full_name owner, r.id ref
  from campaign_records r join campaigns c on c.id = r.campaign_id left join leads l on l.id = r.lead_id
  where coalesce(trim(r.offer_code),'') <> ''
  union all
  select upper(trim(l.offer_code)), 'contact', null, l.full_name, l.id from leads l
  where coalesce(trim(l.offer_code),'') <> ''
    and not exists (select 1 from campaign_records r where r.lead_id = l.id and upper(trim(r.offer_code)) = upper(trim(l.offer_code)))
  union all
  select upper(trim(g.code)), 'old code (' || coalesce(g.source,'') || ')', g.list, l.full_name, g.id from legacy_codes g left join leads l on l.id = g.lead_id
  where coalesce(trim(g.code),'') <> '' and coalesce(g.source,'') <> 'family'   -- 'family' rows are copies made by family.sql
)
select code, count(*) times_used, array_agg(distinct kind) kinds,
       array_remove(array_agg(distinct campaign), null) campaigns, array_remove(array_agg(distinct owner), null) owners
from uses group by code having count(*) > 1
order by times_used desc, code;

-- 4) Prefixes (the "317" in 317-109) used by more than one campaign
select split_part(r.offer_code, '-', 1) prefix, count(distinct r.campaign_id) campaigns, array_agg(distinct c.name) names
from campaign_records r join campaigns c on c.id = r.campaign_id
where r.offer_code ~ '^[A-Za-z0-9]+-[0-9]+$'
group by 1 having count(distinct r.campaign_id) > 1 order by 1;

-- 5) Campaigns big enough to have hit the bug (more than 999 records)
select c.id, c.name, c.mail_status, count(*) records
from campaign_records r join campaigns c on c.id = r.campaign_id
group by c.id, c.name, c.mail_status having count(*) > 999 order by c.id;

-- 6) The fix: in the function source from step 1 (and any function from step 2 that pads), change
--      lpad(<n>::text, 3, '0')
--    to
--      lpad(<n>::text, greatest(3, length(<n>::text)), '0')
--    (keep whatever variable name the function uses for <n>), then run the edited "create or replace function".
--    Records 1-999 keep the same 3-digit codes; 1000+ get 4 digits instead of repeating.
--    If step 4 shows a shared prefix, also make next_code_prefix / assign_offer_codes take the prefix from a
--    sequence (create sequence offer_code_prefix_seq start <max prefix + 1>; nextval(...)) instead of count/max.

-- 7) After steps 3-4 come back empty, let the database itself refuse a repeated code from then on:
-- create unique index if not exists campaign_records_offer_code_uq on campaign_records (upper(offer_code)) where offer_code is not null;
