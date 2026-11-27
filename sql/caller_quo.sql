-- Caller screen: every Quo dial and text from the caller's own line (Nov 27, 2026)
-- Adds one read-only function. Nothing existing is changed.
-- Returns today's Quo call/text counts (Eastern time) and every number this line dialed in the last 14 days,
-- so the caller screen can count all dials and put a "called" mark next to numbers already tried.
create or replace function public.caller_quo(tok text) returns json
language plpgsql stable security definer set search_path = public as $$
declare cid bigint; line text; d0 timestamptz;
begin
  cid := caller_auth(tok);
  select right(regexp_replace(coalesce(quo_line,'7042755457'),'\D','','g'),10) into line from caller_accounts where id = cid;
  d0 := (date_trunc('day', now() at time zone 'America/New_York')) at time zone 'America/New_York';
  return json_build_object(
    'calls_today', (select count(*) from messages where channel='call' and direction='out' and right(regexp_replace(coalesce(our_number,''),'\D','','g'),10)=line and created_at >= d0),
    'texts_today', (select count(*) from messages where channel='sms'  and direction='out' and right(regexp_replace(coalesce(our_number,''),'\D','','g'),10)=line and created_at >= d0),
    'dialed', coalesce((select json_agg(json_build_object('num',num,'n',n,'last_at',last_at)) from (
        select right(regexp_replace(their_number,'\D','','g'),10) num, count(*) n, max(created_at) last_at
        from messages where channel='call' and direction='out'
          and right(regexp_replace(coalesce(our_number,''),'\D','','g'),10)=line
          and created_at > now() - interval '14 days' and their_number is not null
        group by 1) x), '[]'::json));
end $$;
revoke all on function public.caller_quo(text) from public;
grant execute on function public.caller_quo(text) to anon, authenticated;
