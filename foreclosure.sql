-- Foreclosure scout (DLG HQ). Run once in Supabase SQL editor (project gdejlpdltnstbwtdpggm).
-- Cases are filled by the foreclosure-scout edge function (nightly via pg_cron) and by "Run scout now".
-- Every estimate is labeled "est_" and never presented as a verified figure.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists foreclosure_cases (
  id bigint generated always as identity primary key,
  dedupe_key text not null unique,            -- source|county|case_no|normalized address
  source text not null,                       -- 'ruff' | 'kania' | 'brock'
  state text,                                 -- NC / SC
  county text,
  address text,
  zip text,
  parcel text,                                -- Mecklenburg: 8 digits, zero-padded
  case_no text,                               -- court file # or SP #
  owner_name text,
  is_heirs boolean not null default false,    -- "Heirs of" / estate
  property_type text,
  sale_date date,
  sale_time text,
  upset_last_day date,                        -- last day for upset bids (tax sales)
  opening_bid numeric,
  current_bid numeric,
  source_status text,                         -- status exactly as the source shows it
  is_paid_or_dismissed boolean not null default false,
  is_commercial boolean not null default false,
  book_page text,                             -- Brock & Scott deed of trust book/page
  -- county data (Mecklenburg only for now)
  county_data_status text not null default 'county data not connected yet',
  county_checked_at timestamptz,
  county_owner text,
  county_mail_address text,
  county_value numeric,                       -- total county value (assessed), not market value
  county_land_value numeric,
  county_acres numeric,
  county_use text,
  county_last_sale_date date,
  county_last_sale_price numeric,
  county_deed_book text,
  -- first-pass underwriting (estimates)
  est_debt numeric,
  est_debt_method text,
  est_spread numeric,
  est_spread_note text,
  verdict text not null default 'Review',     -- Pursue | Review | Skip
  verdict_reason text,
  -- Damien's own tracking
  my_status text not null default 'new',
  my_notes text,
  -- bookkeeping
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  gone_since timestamptz,                     -- set when a case disappears from its source
  updated_at timestamptz not null default now()
);
create index if not exists foreclosure_cases_verdict_idx on foreclosure_cases (verdict, sale_date);
create index if not exists foreclosure_cases_source_idx on foreclosure_cases (source);

create table if not exists foreclosure_scout_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  source text not null,                       -- 'ruff' | 'kania' | 'brock_nc' | 'brock_sc' | 'county' | 'all'
  trigger text not null default 'cron',       -- 'cron' | 'manual'
  ok boolean,
  rows_found integer,
  added integer,
  updated integer,
  disappeared integer,
  error text,
  detail jsonb
);
create index if not exists foreclosure_scout_runs_idx on foreclosure_scout_runs (source, finished_at desc);

create table if not exists foreclosure_settings (
  key text primary key,
  value jsonb not null
);
insert into foreclosure_settings (key, value) values
  ('min_fee', '25000'::jsonb),
  ('counties', '["Mecklenburg","Gaston","Union","Cabarrus","Iredell","Lincoln","Rowan","Cleveland","York"]'::jsonb)
on conflict (key) do nothing;

alter table foreclosure_cases enable row level security;
create policy "owner all" on foreclosure_cases for all to authenticated using (true) with check (true);
alter table foreclosure_scout_runs enable row level security;
create policy "owner read" on foreclosure_scout_runs for select to authenticated using (true);
alter table foreclosure_settings enable row level security;
create policy "owner all" on foreclosure_settings for all to authenticated using (true) with check (true);
