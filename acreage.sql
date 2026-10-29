-- Acreage Play (DLG HQ). Run once in Supabase SQL editor (project gdejlpdltnstbwtdpggm).
-- Data comes from the "REVIEW - NC Acreage List" spreadsheet via the Import button on the Acreage Play tab.
-- Tracts: individual owners of 15-150 acres near recent builder/developer land buys, tagged by sewer tier.

create table if not exists acreage_tracts (
  id bigint generated always as identity primary key,
  dedupe_key text not null unique,            -- county|parcel
  list_name text,                             -- which list it came from
  sewer_tier text,                            -- '1 - Sewer likely' | '2 - Sewer nearby' | '3 - Well/septic area'
  utilities text,                             -- how the tier was decided
  first_name text, last_name text, owner_name text, owner_name2 text,
  mail_address text, mail_city text, mail_state text, mail_zip text,
  address text, city text, state text, county text, parcel text,
  acres numeric, land_value numeric, total_value numeric,
  owned_since text,
  builder_buys_2mi integer, nearest_buyer text, nearest_buyer_mi numeric,
  road_frontage text, score integer, land_use text,
  lat double precision, lng double precision,
  my_status text not null default 'new',      -- new | mailed | contacting | utility check | offer | contract | dead
  my_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists acreage_tracts_tier_idx on acreage_tracts (sewer_tier, score desc);

create table if not exists acreage_buyers (
  name text primary key,                      -- buyer as recorded on the deed
  tracts integer, acres numeric, counties text, last_purchase date, mail_address text,
  my_notes text,
  updated_at timestamptz not null default now()
);

create table if not exists acreage_comps (
  county text not null, grp text not null,
  sales integer, median_per_acre numeric,
  primary key (county, grp)
);

alter table acreage_tracts enable row level security;
create policy "owner all" on acreage_tracts for all to authenticated using (true) with check (true);
alter table acreage_buyers enable row level security;
create policy "owner all" on acreage_buyers for all to authenticated using (true) with check (true);
alter table acreage_comps enable row level security;
create policy "owner all" on acreage_comps for all to authenticated using (true) with check (true);

-- Added Oct 28: road and flood checks
alter table acreage_tracts add column if not exists road_found boolean, add column if not exists road_names text, add column if not exists flood_pct integer, add column if not exists flood_zones text, add column if not exists floodway boolean;
