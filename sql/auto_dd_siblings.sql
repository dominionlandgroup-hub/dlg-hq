-- DLG HQ (Nov 2026): when a seller responds, every copy of that person gets marked Due Diligence and comes off
-- any list that hasn't mailed yet. Helen Crawford was 6 separate contacts and got 8 letters in 15 months.
--
-- Fires when:  a seller deal is saved for a contact, or a contact is tagged Due Diligence.
-- "Same person" = another contact with the same mailing address + 5-digit zip, or another owner of the same property.
-- Does:         adds the Due Diligence tag to all of them, and deletes their records from campaigns whose
--               mail_status is still 'not_sent' (pools, HOLD, Leizel, weeks not yet at the mail house).
--               Campaigns already at the mail house or sent are never touched.

create or replace function public.dd_norm(a text, z text) returns text language sql immutable as $$
  select case when coalesce(a,'') = '' or coalesce(z,'') !~ '^\s*\d{5}' then null
              else regexp_replace(upper(a), '[^A-Z0-9]', '', 'g') || '|' || substring(trim(z) from 1 for 5) end
$$;

create index if not exists leads_dd_norm_idx on leads (dd_norm(mail_address, mail_zip));

create or replace function public.dd_mark_person(lid bigint) returns int
language plpgsql security definer set search_path to 'public' as $$
declare k text; ids bigint[]; n int := 0;
begin
  select dd_norm(mail_address, mail_zip) into k from leads where id = lid;
  select array_agg(distinct x) into ids from (
    select lid as x
    union select id from leads where k is not null and dd_norm(mail_address, mail_zip) = k
    union select po2.lead_id from property_owners po join property_owners po2 on po2.property_id = po.property_id where po.lead_id = lid
    union select cr2.lead_id from campaign_records cr join campaign_records cr2 on cr2.property_id = cr.property_id
          where cr.lead_id = lid and cr2.lead_id is not null
  ) s where x is not null;
  update leads set tags = array(select distinct unnest(coalesce(tags,'{}') || array['Due Diligence']))
   where id = any(ids) and not ('Due Diligence' = any(coalesce(tags,'{}')));
  delete from campaign_records r using campaigns c
   where c.id = r.campaign_id and r.lead_id = any(ids) and coalesce(c.mail_status,'not_sent') = 'not_sent';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.dd_on_deal() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.lead_id is not null and coalesce(new.board,'seller') = 'seller' then perform dd_mark_person(new.lead_id); end if;
  return new;
end $$;

create or replace function public.dd_on_tag() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if 'Due Diligence' = any(coalesce(new.tags,'{}')) and not ('Due Diligence' = any(coalesce(old.tags,'{}'))) then
    perform dd_mark_person(new.id);
  end if;
  return new;
end $$;

drop trigger if exists dd_on_deal on deals;
create trigger dd_on_deal after insert on deals for each row execute function dd_on_deal();
drop trigger if exists dd_on_tag on leads;
create trigger dd_on_tag after update of tags on leads for each row execute function dd_on_tag();

revoke execute on function public.dd_mark_person(bigint) from public, anon;
grant execute on function public.dd_mark_person(bigint) to authenticated;

-- check: Helen Crawford's 6 contacts should all show Due Diligence
select id, full_name, 'Due Diligence' = any(tags) as dd from leads where id in (436515,246258,365826,387110,14934,130776);
