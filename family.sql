-- Same person, several records (Pebble + GHL + lists): link them by mailing address + a shared name word.
create or replace function addr_key(t text) returns text language sql immutable as $$ select nullif(regexp_replace(lower(coalesce(t,'')),'[^a-z0-9]','','g'),'') $$;
create or replace function name_words(t text) returns text[] language sql immutable as $$
  select coalesce(array_agg(w),'{}') from regexp_split_to_table(lower(coalesce(t,'')),'[^a-z]+') w
  where length(w)>=3 and w not in ('and','the','llc','inc','est','estate','heirs','trust','etal','jr','sr','mrs','co','of') $$;
create index if not exists leads_mailkey on leads (addr_key(mail_address) text_pattern_ops);
create index if not exists props_apnkey on properties (addr_key(apn) text_pattern_ops);
create index if not exists props_addrkey on properties (addr_key(address) text_pattern_ops);

create or replace function lead_family(lid bigint) returns table(id bigint, full_name text, phone text, phone2 text, phone3 text, email text, offer_code text, source text, codes text[])
language sql stable as $$
  with me as (select addr_key(mail_address) k, lower(coalesce(mail_city,'')) c, name_words(full_name) w from leads where id=lid)
  select l.id, l.full_name, l.phone, l.phone2, l.phone3, l.email, l.offer_code, l.source,
    array(select distinct x from (select r.offer_code x from campaign_records r where r.lead_id=l.id
           union select lc.code from legacy_codes lc where lc.lead_id=l.id union select l.offer_code) z where x is not null)
  from leads l, me
  where me.k is not null and addr_key(l.mail_address)=me.k and (me.c='' or lower(coalesce(l.mail_city,''))=me.c)
    and l.id<>lid and name_words(l.full_name) && me.w
  limit 25 $$;
grant execute on function lead_family(bigint) to authenticated;

-- search: also mailing address and APN / property address typed with or without spaces/dashes
create or replace function global_search(q text, lim int default 5) returns json language plpgsql stable as $fn$
declare r json; dg text := nullif(regexp_replace(q,'\D','','g'),''); c text := '%'||q||'%'; p text := q||'%'; up text := upper(trim(q))||'%'; k text := addr_key(q);
begin
  execute format($f$
  select json_build_object(
   'records',(select coalesce(json_agg(x),'[]') from (select r.id, r.offer_code, c.name campaign, l.full_name owner from campaign_records r join campaigns c on c.id=r.campaign_id left join leads l on l.id=r.lead_id
       where r.offer_code ilike %3$L order by r.offer_code limit %2$s) x),
   'contacts',(select coalesce(json_agg(x),'[]') from (select l.id, l.full_name name, l.phone, l.mail_address, l.mail_city, l.mail_state, l.offer_code from leads l where l.id in (
        (select id from leads where length(%1$L)>=2 and full_name ilike %4$L limit %2$s)
        union (select id from leads where length(%1$L)>=3 and offer_code ilike %3$L limit %2$s)
        union (select lead_id from legacy_codes where length(%1$L)>=3 and code ilike %5$L limit %2$s)
        union (select id from leads where position('@' in %1$L)>0 and lower(email) = lower(trim(%1$L)) limit %2$s)
        union (select id from leads where length(coalesce(%6$L,''))=10 and phone10(phone)=%6$L limit %2$s)
        union (select id from leads where length(coalesce(%6$L,''))=10 and phone10(phone2)=%6$L limit %2$s)
        union (select id from leads where length(coalesce(%6$L,''))=10 and phone10(phone3)=%6$L limit %2$s)
        union (select id from leads where length(coalesce(%7$L,''))>=5 and %7$L ~ '^[0-9]+[a-z]' and addr_key(mail_address) like %7$L||'%%' limit %2$s)
       ) order by (l.phone is null), l.id limit %2$s) x),
   'properties',(select coalesce(json_agg(x),'[]') from (select p.id, p.apn, p.address, p.city, p.county, p.county_state, p.acres from properties p where p.id in (
        (select id from properties where apn ilike %4$L or address ilike %4$L limit %2$s)
        union (select id from properties where length(coalesce(%7$L,''))>=5 and addr_key(apn) like %7$L||'%%' limit %2$s)
        union (select id from properties where length(coalesce(%7$L,''))>=5 and addr_key(address) like %7$L||'%%' limit %2$s)) limit %2$s) x),
   'deals',(select coalesce(json_agg(x),'[]') from (select dl.id, coalesce(l.full_name,dl.property_label) title, dl.board, s.name stage from deals dl left join leads l on l.id=dl.lead_id left join board_stages s on s.id=dl.stage_id
       where dl.property_label ilike %4$L or l.full_name ilike %4$L or dl.notes ilike %4$L limit %2$s) x))
  $f$, q, lim, p, c, up, dg, k) into r;
  return r;
end $fn$;

-- every deal's contact gets the offer codes its other records carry (so the deal shows them and search lands on it)
insert into legacy_codes (code, lead_id, source, list, created_at)
select distinct f.code, d.lead_id, 'family', 'same mailing address', now()
from deals d cross join lateral (select unnest(codes) code from lead_family(d.lead_id)) f
where d.lead_id is not null and f.code is not null
  and not exists (select 1 from legacy_codes x where x.lead_id=d.lead_id and x.code=f.code)
  and not exists (select 1 from leads l where l.id=d.lead_id and l.offer_code=f.code);

-- every deal's contact missing a phone/email takes it from its other records
update leads l set phone = coalesce(l.phone, f.phone), email = coalesce(l.email, f.email)
from deals d cross join lateral (select max(phone) phone, max(email) email from lead_family(d.lead_id)) f
where d.lead_id = l.id and (l.phone is null or l.email is null) and (f.phone is not null or f.email is not null);

select (select count(*) from legacy_codes where source='family') codes_linked,
  (select count(*) from deals d join leads l on l.id=d.lead_id where d.status='won' and l.phone is null) closed_no_phone,
  (select count(*) from deals d join leads l on l.id=d.lead_id where d.status='won' and l.email is null) closed_no_email;
