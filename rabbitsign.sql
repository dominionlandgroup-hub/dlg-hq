alter table public.deals add column if not exists rs_folder_id text;
alter table public.deals add column if not exists rs_status text;
alter table public.deals add column if not exists rs_sent_at timestamptz;
alter table public.deals add column if not exists rs_signed_at timestamptz;
alter table public.deals add column if not exists rs_signers jsonb;
create index if not exists deals_rs_folder_idx on public.deals(rs_folder_id);
