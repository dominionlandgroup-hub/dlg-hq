-- Fix for import_campaign_list (import_list.sql): "said no" skip now matches negative and Due Diligence tags in any case
-- ("Not Selling", "not selling", "DD", "Overpriced Offer", "Opted Out"...) on the contact OR the parcel, and status dead /
-- not_selling in any case. Before, it matched only four exact tags ('Not interested','Not selling','Opted out','DNC'),
-- so the app's own "Not Selling" tag and every DD tag were mailed.
-- Same function signature as before, so nothing in the app changes. Run once in the Supabase SQL editor when approved.
create or replace function import_campaign_list(cid bigint, rows jsonb, src text default 'hq', tag text default null,
  skip_dnm boolean default true, skip_ni boolean default true, skip_days int default 0)
returns json language plpgsql as $$
declare neg constant text := 'due diligence|\ydd\y|run claude dd|dd done|not sell|overpriced|paid too much|listed|bad lot|\ysold\y|\ydnc\y|do not (mail|call|contact)|opted|opt out|not interested|not_interested|stop|wrong (owner|person)|deceased|hostile';
  x record; lid bigint; pid bigint; nl int:=0; np int:=0; nr int:=0; s_dnm int:=0; s_ni int:=0; s_recent int:=0; dup int:=0; code text; lrow leads;
begin
  for x in select * from jsonb_to_recordset(rows) as t(full_name text, first_name text, last_name text, phone text, email text,
      mail_address text, mail_city text, mail_state text, mail_zip text, apn text, address text, city text, state text, zip text,
      county text, acres numeric, lat double precision, lng double precision, offer_price numeric, offer_code text)
  loop
    lid := null; pid := null; lrow := null;
    if coalesce(x.apn,x.address) is not null then
      select id into pid from properties where x.apn is not null and apn=x.apn and coalesce(lower(county),'')=coalesce(lower(x.county),coalesce(lower(county),'')) limit 1;
    end if;
    if coalesce(x.full_name,x.phone,x.mail_address) is not null then
      select * into lrow from leads where lower(full_name)=lower(x.full_name) and coalesce(lower(mail_address),'')=coalesce(lower(x.mail_address),'') limit 1;
      lid := lrow.id;
    end if;
    -- skip rules (existing contacts/parcels only)
    if lid is not null and skip_dnm and coalesce(lrow.do_not_mail,false) then s_dnm:=s_dnm+1; continue; end if;
    -- negative / Due Diligence tags, any case, on the contact or the parcel (same list as NEGTAG in listbuilder.js)
    if skip_ni and ((lid is not null and (lower(coalesce(lrow.status,'')) in ('dead','not_selling')
           or exists (select 1 from unnest(coalesce(lrow.tags,'{}')) t where t ~* neg)))
        or (pid is not null and exists (select 1 from properties p, unnest(coalesce(p.tags,'{}')) t where p.id=pid and t ~* neg))) then s_ni:=s_ni+1; continue; end if;
    if skip_days > 0 and exists (select 1 from campaign_records r join campaigns c on c.id=r.campaign_id
         where r.campaign_id<>cid and coalesce(c.drop_date,c.created_at::date) >= current_date - skip_days
           and ((pid is not null and r.property_id=pid) or (lid is not null and r.lead_id=lid))) then s_recent:=s_recent+1; continue; end if;
    if lid is null and coalesce(x.full_name,x.phone,x.mail_address) is not null then
      insert into leads (source,status,full_name,first_name,last_name,phone,email,mail_address,mail_city,mail_state,mail_zip,tags)
      values (src,'record',coalesce(x.full_name,trim(concat_ws(' ',x.first_name,x.last_name))),x.first_name,x.last_name,x.phone,x.email,
              x.mail_address,x.mail_city,x.mail_state,x.mail_zip,case when tag is null then '{}' else array[tag] end)
      returning id into lid; nl:=nl+1;
    end if;
    if pid is null and coalesce(x.apn,x.address) is not null then
      insert into properties (apn,address,city,state,zip,county,county_state,acres,lat,lng,source)
      values (x.apn,x.address,x.city,coalesce(x.state,x.mail_state),x.zip,x.county,
              case when x.county is not null then x.county||', '||coalesce(x.state,'') end,x.acres,x.lat,x.lng,src)
      returning id into pid; np:=np+1;
    end if;
    if lid is not null and pid is not null then insert into property_owners values (pid,lid) on conflict do nothing; end if;
    code := nullif(trim(x.offer_code),'');
    -- taken anywhere in DLG HQ, any case (offer_code_taken is defined in sql/bug_sweep_nov5.sql)
    if code is not null and offer_code_taken(code) then dup:=dup+1; code:=null; end if;
    insert into campaign_records (campaign_id,lead_id,property_id,offer_price,offer_code) values (cid,lid,pid,x.offer_price,code);
    nr:=nr+1;
  end loop;
  return json_build_object('leads',nl,'properties',np,'records',nr,'skipped_dnm',s_dnm,'skipped_not_interested',s_ni,'skipped_recent',s_recent,'duplicate_codes',dup);
end $$;
