-- DLG HQ CALLER TIME CLOCK, part 2 (Nov 27, 2026)
-- Damien's rule: two 15-minute breaks a day are PAID (up to 30 minutes of break per day counts as paid time),
-- lunch is UNPAID. Adds a separate Lunch start/end to the clock. "today_minutes" is now PAID minutes today.

alter table public.caller_shifts drop constraint if exists caller_shifts_kind_check;
alter table public.caller_shifts add constraint caller_shifts_kind_check
  check (kind in ('in','out','break_start','break_end','lunch_start','lunch_end'));

create or replace function public.caller_clock_core(cid bigint) returns json language plpgsql stable security definer set search_path = public as $$
declare last caller_shifts; t0 timestamptz := date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
  st text; work numeric := 0; brk numeric := 0; lun numeric := 0; r record; w_at timestamptz; b_at timestamptz; l_at timestamptz;
begin
  select * into last from caller_shifts where caller_id = cid order by at desc, id desc limit 1;
  st := case when last.id is null or last.kind = 'out' then 'off' when last.kind = 'break_start' then 'break'
             when last.kind = 'lunch_start' then 'lunch' else 'working' end;
  for r in select kind, at from caller_shifts where caller_id = cid and at >= t0 - interval '1 day' order by at, id loop
    if r.kind in ('in','break_end','lunch_end') then
      if r.kind = 'break_end' and b_at is not null then if r.at > t0 then brk := brk + extract(epoch from (r.at - b_at))/60; end if; b_at := null; end if;
      if r.kind = 'lunch_end' and l_at is not null then if r.at > t0 then lun := lun + extract(epoch from (r.at - l_at))/60; end if; l_at := null; end if;
      w_at := greatest(r.at, t0);
    elsif r.kind in ('out','break_start','lunch_start') then
      if w_at is not null then if r.at > t0 then work := work + extract(epoch from (r.at - w_at))/60; end if; w_at := null; end if;
      if r.kind = 'break_start' then b_at := greatest(r.at, t0); end if;
      if r.kind = 'lunch_start' then l_at := greatest(r.at, t0); end if;
    end if;
  end loop;
  if st = 'working' and w_at is not null then work := work + extract(epoch from (now() - w_at))/60; end if;
  if st = 'break' and b_at is not null then brk := brk + extract(epoch from (now() - b_at))/60; end if;
  if st = 'lunch' and l_at is not null then lun := lun + extract(epoch from (now() - l_at))/60; end if;
  return json_build_object('state', st, 'since', last.at, 'today_minutes', round(work + least(brk, 30)),
    'work_minutes', round(work), 'break_minutes', round(brk), 'lunch_minutes', round(lun));
end $$;

create or replace function public.caller_clock(tok text, p_kind text) returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); st text;
begin
  st := caller_clock_core(cid)->>'state';
  if p_kind not in ('in','out','break_start','break_end','lunch_start','lunch_end') then raise exception 'Unknown clock action'; end if;
  if p_kind = 'in' and st <> 'off' then raise exception 'You are already clocked in'; end if;
  if p_kind in ('break_start','lunch_start') and st <> 'working' then raise exception 'Clock in (and end any break) first'; end if;
  if p_kind = 'break_end' and st <> 'break' then raise exception 'You are not on a break'; end if;
  if p_kind = 'lunch_end' and st <> 'lunch' then raise exception 'You are not at lunch'; end if;
  if p_kind = 'out' and st = 'off' then raise exception 'You are not clocked in'; end if;
  if p_kind = 'out' and st = 'break' then insert into caller_shifts (caller_id, kind) values (cid, 'break_end'); end if;
  if p_kind = 'out' and st = 'lunch' then insert into caller_shifts (caller_id, kind) values (cid, 'lunch_end'); end if;
  insert into caller_shifts (caller_id, kind) values (cid, p_kind);
  return caller_clock_core(cid);
end $$;

revoke all on function public.caller_clock_core(bigint) from public, anon, authenticated;
grant execute on function public.caller_clock(text, text) to anon, authenticated;
select 'ok' as done;
