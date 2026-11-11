-- Buy box form fix (Nov 2026)
-- Problem: bb_list() used SELECT DISTINCT, which scrambled the order of the pieces, and the buy_box
-- summary was rebuilt from those comma-split pieces, so a paragraph typed into "Cities" came out shredded.
-- Fix: bb_list keeps the order typed (drops repeats, keeps the first one), and buy_box keeps the
-- buyer's own words for cities (whitespace tidied), not the split pieces.

create or replace function public.bb_list(s text) returns text[] language sql immutable as $$
  select coalesce(array(
    select x from (
      select trim(x) x, min(n) n
      from regexp_split_to_table(left(coalesce(s,''),2000), '[,;\n]+') with ordinality t(x,n)
      where trim(x) <> ''
      group by trim(x)
    ) q order by n limit 80), '{}')
$$;

create or replace function public.bb_text(s text) returns text language sql immutable as $$
  select nullif(trim(regexp_replace(left(coalesce(s,''),1500), '\s+', ' ', 'g')), '')
$$;

create or replace function public.submit_buybox(p jsonb) returns text
language plpgsql security definer set search_path to 'public' as $function$
declare bid bigint; em text := lower(trim(left(coalesce(p->>'email',''),200))); nm text := trim(left(coalesce(p->>'name',''),120));
tok uuid; zz text[];
begin
if nm = '' or em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Please enter your name and a valid email.'; end if;
if coalesce(p->>'website','') <> '' then return 'ok'; end if;
begin tok := nullif(p->>'t','')::uuid; exception when others then tok := null; end;
if tok is not null then select id into bid from buyers where bb_token = tok; end if;
if bid is null and coalesce(p->>'t','') ~ '^[A-Za-z0-9]{6}$' then select id into bid from buyers where bb_code = lower(p->>'t'); end if;
if bid is null then select id into bid from buyers where lower(email) = em order by id limit 1; end if;
if bid is null then insert into buyers (name, email, kind, bb_status) values (nm, em, 'buyer', 'not sent') returning id into bid; end if;
-- zips in the order typed, no repeats
select coalesce(array_agg(z order by n),'{}') into zz from (
  select z, min(n) n from regexp_matches(coalesce(p->>'zips',''), '\m\d{5}\M', 'g') with ordinality m(a,n), lateral (select a[1] z) s group by z) q;
update buyers set
 name = nm, first_name = split_part(nm,' ',1), email = em,
 company = nullif(trim(left(coalesce(p->>'company',''),160)),''),
 phone = coalesce(nullif(trim(left(coalesce(p->>'phone',''),40)),''), phone),
 role = nullif(left(coalesce(p->>'role',''),80),''),
 kind = case when coalesce(p->>'role','') ilike 'agent%' then 'agent' else coalesce(kind,'buyer') end,
 represents = nullif(trim(left(coalesce(p->>'represents',''),1000)),''),
 send_by = bb_arr(p,'send_by'), cities = bb_list(p->>'cities'), zips = zz,
 price_ranges = bb_arr(p,'price'), lot_sizes = bb_arr(p,'lot_size'), lot_type = nullif(left(coalesce(p->>'lot_type',''),40),''),
 utilities = bb_arr(p,'utilities'), recent_lot = nullif(trim(left(coalesce(p->>'recent_lot',''),300)),''),
 deal_breakers = nullif(trim(left(coalesce(p->>'deal_breakers',''),1000)),''), lots_per_year = nullif(left(coalesce(p->>'per_year',''),20),''),
 counties = case when coalesce(array_length(counties,1),0) = 0 then bb_list(p->>'counties') else counties end,
 buy_box = left(concat_ws(' · ', bb_text(p->>'cities'), nullif(array_to_string(bb_arr(p,'price'),', '),''), nullif(array_to_string(bb_arr(p,'lot_size'),', '),''), nullif(p->>'lot_type','')), 1500),
 bb_status = 'got buy box', bb_submitted_at = now()
where id = bid;
insert into tasks (title, due_at, status) values ('New buy box: ' || nm || coalesce(' (' || nullif(p->>'company','') || ')', ''), now(), 'todo');
return 'ok';
end $function$;
