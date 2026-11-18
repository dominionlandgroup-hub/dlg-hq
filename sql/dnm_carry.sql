-- DLG HQ (Nov 18, 2026): Do Not Mail and "said no" tags now carry to every copy of the person.
-- Why: the Boyds and Vanessa Lee kept getting letters after asking to be removed. Tagging Due Diligence already
-- carried to every copy (auto_dd_siblings.sql), but checking Do Not Mail or tagging Not Selling / not interested /
-- DNC / opted out only marked the one contact. The GHL or Pebble copy of the same owner stayed clean and got mailed.
--
-- Same person = another contact at the same mailing address + 5-digit zip who shares a name word (so a church,
-- HOA or attorney's office that several owners use as a mailing address does NOT get marked), or another
-- owner of the same parcel.
-- Does: Do Not Mail + Due Diligence tag on every copy, and takes them off every list not yet at the mail house.
-- Run once in Supabase > SQL Editor.

create or replace function public.dnm_name_words(n text) returns text[] language sql immutable as $$
  select coalesce(array_agg(w), '{}') from unnest(regexp_split_to_array(upper(regexp_replace(coalesce(n,''), '[^A-Za-z ]', ' ', 'g')), '\s+')) w
  where length(w) > 2 and w not in ('AND','THE','LLC','INC','HEIRS','ESTATE','EST','TRUST','ETAL','ETUX','ETVIR','JR','SR','OF','LIVING','REVOCABLE','FAMILY')
$$;

create or replace function public.dnm_mark_person(lid bigint) returns int
language plpgsql security definer set search_path to 'public' as $$
declare k text; nm text[]; ids bigint[]; n int := 0;
begin
  select dd_norm(mail_address, mail_zip), dnm_name_words(full_name) into k, nm from leads where id = lid;
  select array_agg(distinct x) into ids from (
    select lid as x
    union select id from leads where k is not null and dd_norm(mail_address, mail_zip) = k and dnm_name_words(full_name) && nm
    union select po2.lead_id from property_owners po join property_owners po2 on po2.property_id = po.property_id where po.lead_id = lid
  ) s where x is not null;
  update leads set do_not_mail = true,
         tags = array(select distinct unnest(coalesce(tags,'{}') || array['Due Diligence']))
   where id = any(ids) and (not coalesce(do_not_mail,false) or not ('Due Diligence' = any(coalesce(tags,'{}'))));
  delete from campaign_records r using campaigns c
   where c.id = r.campaign_id and r.lead_id = any(ids) and coalesce(c.mail_status,'not_sent') = 'not_sent';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.dnm_on_change() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare neg constant text := '(not interested|not_interested|not sell|\ydnc\y|do not (mail|call|contact)|^dnm$|opted|opt out|remove|stop mail|upset|hostile)';
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if (coalesce(new.do_not_mail,false) and not coalesce(old.do_not_mail,false))
     or (lower(coalesce(new.status,'')) in ('dead','not_selling') and lower(coalesce(old.status,'')) not in ('dead','not_selling'))
     or exists (select 1 from unnest(coalesce(new.tags,'{}')) t where t ~* neg
                and not exists (select 1 from unnest(coalesce(old.tags,'{}')) o where o = t)) then
    perform dnm_mark_person(new.id);
  end if;
  return new;
end $$;

drop trigger if exists dnm_on_change on leads;
create trigger dnm_on_change after update of do_not_mail, tags, status on leads for each row execute function dnm_on_change();

revoke execute on function public.dnm_mark_person(bigint) from public, anon;
grant execute on function public.dnm_mark_person(bigint) to authenticated;

-- check: both Boyd copies should be Do Not Mail
select id, full_name, do_not_mail, tags from leads where mail_address ilike '2020 monterosa%';
