-- Faster contact search (Nov 14, 2026).
-- Before: every search read all ~380,000 contacts (2 to 5 seconds), so typing a name lagged and
-- "Homer Daniels" didn't find "Homer & Ruby Daniels".
-- After: indexed search, and every word you type must appear somewhere (in any order).
-- Run once in Supabase > SQL Editor. Building the indexes takes a minute or two.

create extension if not exists pg_trgm;

create index if not exists leads_search_trgm on leads using gin ((
  lower(coalesce(full_name,'')||' '||coalesce(first_name,'')||' '||coalesce(last_name,'')||' '||
        coalesce(prop_address,'')||' '||coalesce(mail_address,'')||' '||coalesce(apn,'')||' '||
        coalesce(offer_code,'')||' '||coalesce(phone,'')||' '||coalesce(email,''))
) gin_trgm_ops);

create index if not exists leads_phone_digits_trgm on leads using gin ((
  regexp_replace(coalesce(phone,'')||' '||coalesce(phone2,'')||' '||coalesce(phone3,''),'\D','','g')
) gin_trgm_ops);

create index if not exists campaign_records_offer_code_upper on campaign_records (upper(offer_code));

create or replace function search_leads(q text, lim int default 50)
returns setof leads language plpgsql stable as $fn$
declare
  qq text := btrim(coalesce(q,''));
  d  text := regexp_replace(qq,'\D','','g');
  txt text := $e$lower(coalesce(full_name,'')||' '||coalesce(first_name,'')||' '||coalesce(last_name,'')||' '||coalesce(prop_address,'')||' '||coalesce(mail_address,'')||' '||coalesce(apn,'')||' '||coalesce(offer_code,'')||' '||coalesce(phone,'')||' '||coalesce(email,''))$e$;
  conds text;
  sql text;
begin
  if qq = '' then
    return query select * from leads order by updated_at desc nulls last limit lim;
    return;
  end if;
  -- every word must match (escape % and _ so they are searched literally)
  select string_agg(format('%s like %L', txt, '%'||replace(replace(replace(w,'\','\\'),'%','\%'),'_','\_')||'%'), ' and ')
    into conds
    from unnest(regexp_split_to_array(lower(qq), '\s+')) w where w <> '' and w <> '&';
  sql := 'select id from leads where ' || coalesce(conds,'false');
  if length(d) >= 4 then
    sql := sql || format(' union select id from leads where regexp_replace(coalesce(phone,'''')||'' ''||coalesce(phone2,'''')||'' ''||coalesce(phone3,''''),''\D'','''',''g'') like %L', '%'||d||'%');
  end if;
  sql := sql || format(' union select lead_id from campaign_records where upper(offer_code) = upper(%L) and lead_id is not null', qq);
  return query execute format('select l.* from leads l where l.id in (%s) order by l.updated_at desc nulls last limit %s', sql, greatest(1, least(coalesce(lim,50), 200)));
end $fn$;

grant execute on function search_leads(text, int) to authenticated;
