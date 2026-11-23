-- Builder text drip (Nov 2026)
-- Texts builders the buy box link from the builders line (980) 217-8806, up to 4 texts:
--   day 0, day 3, day 7, day 14. Weekdays 9am-6pm Eastern only.
-- Stops on its own when the builder replies (any text back), texts STOP, fills out the buy box form,
-- or the number is on the suppression list. Only numbers Damien knows are the builder go in.
-- The builder-drip edge function does the sending; pg_cron runs it every 30 minutes.

create table if not exists builder_drip (
  id bigserial primary key,
  company text not null,
  first_name text,                 -- blank = "Hi there"
  phone text not null,             -- 10 digits
  county text,                     -- "Harnett" -> "...builders in Harnett County"
  step int not null default 0,     -- texts sent so far (0-4)
  next_at timestamptz default now(),
  status text not null default 'active' check (status in ('active','paused','replied','stopped','buybox','done','error')),
  stop_reason text,
  last_sent_at timestamptz,
  last_error text,
  enrolled_at timestamptz default now(),
  notes text
);
create unique index if not exists builder_drip_phone_uidx on builder_drip (right(regexp_replace(phone,'\D','','g'),10));
alter table builder_drip enable row level security;
drop policy if exists "owner all" on builder_drip;
create policy "owner all" on builder_drip for all to authenticated using (true) with check (true);

create table if not exists builder_drip_log (
  id bigserial primary key,
  drip_id bigint references builder_drip(id) on delete cascade,
  step int, body text, ok boolean, error text, sent_at timestamptz default now()
);
alter table builder_drip_log enable row level security;
drop policy if exists "owner read" on builder_drip_log;
create policy "owner read" on builder_drip_log for select to authenticated using (true);

-- run every 30 minutes (the function itself skips nights and weekends)
create extension if not exists pg_cron;
select cron.unschedule('builder-drip') where exists (select 1 from cron.job where jobname = 'builder-drip');
select cron.schedule('builder-drip', '*/30 * * * *', $$
  select net.http_post(url := 'https://gdejlpdltnstbwtdpggm.supabase.co/functions/v1/builder-drip',
    body := '{}'::jsonb, headers := '{"Content-Type":"application/json"}'::jsonb);
$$);

-- Release held markets (Nov 2026): when a buy box comes in, check every HOLD campaign for lots in that builder's
-- counties (or cities) and add a task: "Buy box in Moore: 500 lots on hold - release them to a mailing".
-- Nothing is moved automatically; Damien decides when to mail.
create or replace function hold_release_task() returns trigger language plpgsql security definer set search_path=public as $$
declare r record; cts text[]; cis text[];
begin
  if new.bb_submitted_at is null or new.bb_submitted_at is not distinct from old.bb_submitted_at then return new; end if;
  cts := array(select lower(trim(regexp_replace(x,'\s+county\.?$','','i'))) from unnest(coalesce(new.counties,'{}')) x where trim(x) <> '');
  cis := array(select lower(trim(x)) from unnest(coalesce(new.cities,'{}')) x where trim(x) <> '');
  for r in
    select p.county, count(*) n, string_agg(distinct c.name, ', ') camps
    from campaign_records cr join campaigns c on c.id = cr.campaign_id join properties p on p.id = cr.property_id
    where c.name ilike 'HOLD%'
      and (lower(p.county) = any(cts) or lower(coalesce(p.city,'')) = any(cis))
    group by p.county
  loop
    insert into tasks (title, due_at, status)
    values ('Buy box in ' || r.county || ' (' || coalesce(nullif(new.company,''), new.name) || '): ' || r.n || ' lots on hold in ' || r.camps || ' - release them to a mailing', now(), 'todo');
  end loop;
  return new;
end $$;
drop trigger if exists hold_release on buyers;
create trigger hold_release after update of bb_submitted_at on buyers for each row execute function hold_release_task();
