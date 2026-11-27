-- DLG HQ CALLER TIME CLOCK (Nov 27, 2026)
-- The caller clocks in, takes breaks and clocks out from the caller screen. Damien sees a weekly timesheet
-- (hours, pay at her hourly rate, appointments, and how busy she was while clocked in) under Callers.
-- She is told the screen logs activity: idle time is flagged from her own call log, there is no hidden tracking.

alter table public.caller_accounts add column if not exists hourly_rate numeric(8,2) not null default 0;

create table if not exists public.caller_shifts (
  id bigserial primary key,
  caller_id bigint not null references public.caller_accounts(id) on delete cascade,
  kind text not null check (kind in ('in','out','break_start','break_end')),
  at timestamptz not null default now());
create index if not exists caller_shifts_caller_idx on public.caller_shifts (caller_id, at desc);
alter table public.caller_shifts enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='caller_shifts' and policyname='owner all') then
    create policy "owner all" on public.caller_shifts for all to authenticated using (true) with check (true);
  end if; end $$;

-- where she is right now: off / working / break, since when, and minutes worked today (ET)
create or replace function public.caller_clock_core(cid bigint) returns json language plpgsql stable security definer set search_path = public as $$
declare last caller_shifts; t0 timestamptz := date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
  st text; mins numeric := 0; r record; open_at timestamptz; on_break boolean := false;
begin
  select * into last from caller_shifts where caller_id = cid order by at desc, id desc limit 1;
  st := case when last.id is null or last.kind = 'out' then 'off' when last.kind = 'break_start' then 'break' else 'working' end;
  for r in select kind, at from caller_shifts where caller_id = cid and at >= t0 - interval '1 day' order by at, id loop
    if r.kind = 'in' or r.kind = 'break_end' then open_at := greatest(r.at, t0);
    elsif (r.kind = 'out' or r.kind = 'break_start') and open_at is not null then
      if r.at > t0 then mins := mins + extract(epoch from (r.at - open_at)) / 60; end if; open_at := null;
    end if;
  end loop;
  if st = 'working' and open_at is not null then mins := mins + extract(epoch from (now() - open_at)) / 60; end if;
  return json_build_object('state', st, 'since', last.at, 'today_minutes', round(mins));
end $$;

create or replace function public.caller_clock_status(tok text) returns json language plpgsql security definer set search_path = public as $$
begin return caller_clock_core(caller_auth(tok)); end $$;

create or replace function public.caller_clock(tok text, p_kind text) returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); st text;
begin
  st := caller_clock_core(cid)->>'state';
  if p_kind = 'in' and st <> 'off' then raise exception 'You are already clocked in'; end if;
  if p_kind = 'break_start' and st <> 'working' then raise exception 'Clock in before starting a break'; end if;
  if p_kind = 'break_end' and st <> 'break' then raise exception 'You are not on a break'; end if;
  if p_kind = 'out' and st = 'off' then raise exception 'You are not clocked in'; end if;
  if p_kind not in ('in','out','break_start','break_end') then raise exception 'Unknown clock action'; end if;
  if p_kind = 'out' and st = 'break' then insert into caller_shifts (caller_id, kind) values (cid, 'break_end'); end if;
  insert into caller_shifts (caller_id, kind) values (cid, p_kind);
  return caller_clock_core(cid);
end $$;

create or replace function public.owner_preview_clock(cid bigint) returns json language sql stable security definer set search_path = public as $$
  select caller_clock_core(cid); $$;

revoke all on function public.caller_clock_core(bigint) from public, anon, authenticated;
revoke all on function public.owner_preview_clock(bigint) from public, anon;
grant execute on function public.owner_preview_clock(bigint) to authenticated;
grant execute on function public.caller_clock_status(text) to anon, authenticated;
grant execute on function public.caller_clock(text, text) to anon, authenticated;
