alter table public.deals add column if not exists rs_folder_id text;
alter table public.deals add column if not exists rs_status text;
alter table public.deals add column if not exists rs_sent_at timestamptz;
alter table public.deals add column if not exists rs_signed_at timestamptz;
alter table public.deals add column if not exists rs_signers jsonb;
create index if not exists deals_rs_folder_idx on public.deals(rs_folder_id);
alter table public.deals add column if not exists extra_property_ids bigint[];
alter table public.deal_files add column if not exists deleted_at timestamptz;
-- Assignments sent through RabbitSign (kept separate from the purchase agreement)
alter table public.deals add column if not exists as_folder_id text;
alter table public.deals add column if not exists as_status text;
alter table public.deals add column if not exists as_sent_at timestamptz;
alter table public.deals add column if not exists as_signed_at timestamptz;
alter table public.deals add column if not exists as_signers jsonb;
alter table public.deals add column if not exists as_meta jsonb;
create index if not exists deals_as_folder_idx on public.deals(as_folder_id);
