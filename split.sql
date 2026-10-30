-- Split Finder (DLG HQ). Run once in the Supabase SQL editor (project gdejlpdltnstbwtdpggm).
-- Vacant parcels that can be split into 3+ legal lots on the existing road (minor/exempt splits):
-- sell the extra lots to a builder to pay for the purchase, keep 1-2 lots free and clear.
create table if not exists split_parcels (
  id bigint generated always as identity primary key,
  dedupe_key text not null unique,             -- county|parcel
  list_name text,
  county text, jurisdiction text, parcel text, address text, zoning text,
  est_lots integer, lots_by_area integer, acres numeric, lot_sqft numeric, frontage_ft numeric,
  min_lot_sqft numeric, min_width_ft numeric, corner boolean,
  sewer_guess text, flood_pct integer, floodway boolean, slope_pct numeric, tree_pct integer,
  tax_land_value numeric, pad_price numeric, pad_price_source text,
  owner_type text, owner_name text, owner_name2 text,
  mail_address text, mail_city text, mail_state text, mail_zip text,
  absentee boolean, out_of_state boolean, year_bought integer, years_held numeric, last_sale_price numeric,
  street text, lat double precision, lng double precision, score integer,
  my_status text not null default 'new',       -- new | mailed | contacting | survey | offer | contract | dead
  my_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists split_parcels_county_idx on split_parcels (county, score desc);
alter table split_parcels enable row level security;
drop policy if exists "owner all" on split_parcels;
create policy "owner all" on split_parcels for all to authenticated using (true) with check (true);
