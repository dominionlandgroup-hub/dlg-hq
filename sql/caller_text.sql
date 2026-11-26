-- DLG HQ CALLERS, part 5 (Nov 26, 2026): Send text button. The caller's text goes out through Quo from her line
-- (704) 275-5457 to the number she picked, shows in her Quo inbox, and is written on the lead.
-- Limits: mobile numbers only (checked on her screen), 2 texts per number per lead, 150 a day per caller,
-- must end "Reply STOP to unsubscribe". Run after callers.sql ... caller_claims.sql. Safe to run more than once.

create table if not exists public.caller_texts (
  id bigserial primary key, caller_id bigint references public.caller_accounts(id), deal_id bigint, lead_id bigint,
  phone text not null, body text not null, created_at timestamptz not null default now(), sent_at timestamptz, error text);
create index if not exists caller_texts_deal_idx on public.caller_texts (deal_id, phone);
alter table public.caller_texts enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='caller_texts' and policyname='owner all') then
    create policy "owner all" on public.caller_texts for all to authenticated using (true) with check (true);
  end if; end $$;

create or replace function public.caller_send_text(tok text, did bigint, p_phone text, p_body text) returns bigint
language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok); d10 text := right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 10); nid bigint; lid bigint;
begin
  if not caller_deal_ok(did) then raise exception 'This lead is not in the Duet columns anymore'; end if;
  if length(d10) <> 10 then raise exception 'Pick the mobile number to text'; end if;
  if coalesce(p_body,'') !~* 'Reply STOP to unsubscribe\.?\s*$' or length(p_body) > 320 then raise exception 'The text must end with "Reply STOP to unsubscribe"'; end if;
  if (select count(*) from caller_texts where deal_id = did and right(regexp_replace(phone,'\D','','g'),10) = d10 and error is null) >= 2 then
    raise exception 'You already sent 2 texts to this number. Do not text it again.'; end if;
  if (select count(*) from caller_texts where caller_id = cid and created_at > now() - interval '24 hours') >= 150 then
    raise exception 'Daily text limit reached (150). Tell Damien.'; end if;
  select lead_id into lid from deals where id = did;
  insert into caller_texts (caller_id, deal_id, lead_id, phone, body) values (cid, did, lid, '+1' || d10, trim(p_body)) returning id into nid;
  return nid;
end $$;

create or replace function public.caller_text_status(tok text, tid bigint) returns json language plpgsql security definer set search_path = public as $$
declare cid bigint := caller_auth(tok);
begin
  return (select json_build_object('sent', sent_at is not null, 'error', error) from caller_texts where id = tid and caller_id = cid);
end $$;

-- each new text wakes the caller-alert function, which sends it through Quo
create or replace function public.caller_text_fire() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  perform net.http_post(url := 'https://gdejlpdltnstbwtdpggm.supabase.co/functions/v1/caller-alert',
    headers := jsonb_build_object('content-type','application/json','x-cron-key',(select value from public.app_secrets where name = 'caller_alert')),
    body := jsonb_build_object('text_id', new.id));
  return new;
end $$;
drop trigger if exists caller_text_fire on public.caller_texts;
create trigger caller_text_fire after insert on public.caller_texts for each row execute function public.caller_text_fire();

revoke all on function public.caller_text_fire() from public, anon, authenticated;
grant execute on function public.caller_send_text(text,bigint,text,text), public.caller_text_status(text,bigint) to anon, authenticated;
select 'ok' as done;
