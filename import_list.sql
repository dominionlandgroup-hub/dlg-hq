-- Import List into a campaign (Pebble-style): contacts + properties + campaign records, then auto offer codes
create index if not exists leads_lname_idx on leads (lower(full_name));
create index if not exists props_apn_idx on properties (apn);
drop function if exists import_campaign_list(bigint, jsonb, text, text);
create or replace function import_campaign_list(cid bigint, rows jsonb, src text default 'hq', tag text default null,
  skip_dnm boolean default true, skip_ni boolean default true, skip_days int default 0)
returns json language plpgsql as $$
declare x record; lid bigint; pid bigint; nl int:=0; np int:=0; nr int:=0; s_dnm int:=0; s_ni int:=0; s_recent int:=0; dup int:=0; code text; lrow leads;
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
    if lid is not null and skip_ni and (lrow.status in ('dead','not_selling') or lrow.tags && array['Not interested','Not selling','Opted out','DNC']) then s_ni:=s_ni+1; continue; end if;
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
    if code is not null and exists (select 1 from campaign_records where offer_code=upper(code)) then dup:=dup+1; code:=null; end if;
    insert into campaign_records (campaign_id,lead_id,property_id,offer_price,offer_code) values (cid,lid,pid,x.offer_price,code);
    nr:=nr+1;
  end loop;
  return json_build_object('leads',nl,'properties',np,'records',nr,'skipped_dnm',s_dnm,'skipped_not_interested',s_ni,'skipped_recent',s_recent,'duplicate_codes',dup);
end $$;

-- Finish: assign codes to any record without one, copy codes to contacts, update the campaign's record count
create or replace function finish_campaign_import(cid bigint) returns json language plpgsql as $$
declare n int; p text;
begin
  n := assign_offer_codes(cid);
  update leads l set offer_code=r.offer_code from campaign_records r where r.campaign_id=cid and r.lead_id=l.id and r.offer_code is not null;
  update campaigns set records=(select count(*) from campaign_records where campaign_id=cid) where id=cid;
  select min(offer_code) into p from campaign_records where campaign_id=cid;
  return json_build_object('coded',n,'records',(select records from campaigns where id=cid),'first_code',p);
end $$;
