-- Website form -> contact + Seller Inbox thread; offer code links it to the campaign record (response rate / KPIs)
create or replace function submit_web_lead(
  p_name text, p_phone text, p_email text, p_address text, p_county text,
  p_apn text, p_offer_code text, p_message text)
returns bigint language plpgsql security definer set search_path = public as $$
declare lid bigint; tid bigint; rid bigint; code text := upper(trim(coalesce(p_offer_code,''))); d text := phone10(p_phone); body text;
begin
  if coalesce(trim(p_phone),'') = '' and coalesce(trim(p_email),'') = '' then
    raise exception 'phone or email required';
  end if;
  if code <> '' then
    select r.id, r.lead_id into rid, lid from campaign_records r where upper(r.offer_code) = code order by r.id desc limit 1;
    if rid is not null then update campaign_records set responded = true where id = rid; end if;
  end if;
  if lid is null and length(d) = 10 then
    select id into lid from leads where phone10(phone) = d or phone10(phone2) = d or phone10(phone3) = d order by id limit 1;
  end if;
  if lid is null then
    insert into leads (full_name, phone, email, prop_address, county, apn, offer_code, status, lead_source, source, notes, inbox)
    values (left(p_name,200), left(p_phone,40), left(p_email,200), left(p_address,300), left(p_county,80), left(p_apn,80),
            nullif(code,''), 'new', 'website', 'web', left(p_message,2000), 'seller')
    returning id into lid;
  else
    update leads set phone = coalesce(phone, left(p_phone,40)), email = coalesce(email, left(p_email,200)),
      status = case when status = 'record' then 'new' else status end, lead_source = coalesce(lead_source,'website') where id = lid;
  end if;
  select id into tid from threads where lead_id = lid and inbox = 'seller' order by last_at desc nulls last limit 1;
  if tid is null then
    insert into threads (inbox, lead_id, title, phone, email, last_at, source, pinned, archived, muted)
    values ('seller', lid, coalesce(nullif(p_name,''), p_phone, p_email), left(p_phone,40), left(p_email,200), now(), 'web', false, false, false)
    returning id into tid;
  end if;
  body := 'Website form' ||
    case when coalesce(p_name,'')<>'' then E'\nName: '||p_name else '' end ||
    case when coalesce(p_phone,'')<>'' then E'\nPhone: '||p_phone else '' end ||
    case when coalesce(p_email,'')<>'' then E'\nEmail: '||p_email else '' end ||
    case when code<>'' then E'\nOffer code: '||code||case when rid is null then ' (not found)' else '' end else '' end ||
    case when coalesce(p_address,'')<>'' then E'\nProperty: '||p_address else '' end ||
    case when coalesce(p_county,'')<>'' then E'\nCounty: '||p_county else '' end ||
    case when coalesce(p_apn,'')<>'' then E'\nAPN: '||p_apn else '' end ||
    case when coalesce(p_message,'')<>'' then E'\n\n'||left(p_message,2000) else '' end;
  insert into messages (thread_id, lead_id, inbox, channel, direction, body, their_number, is_read)
  values (tid, lid, 'seller', 'web', 'in', body, left(p_phone,40), false);
  update threads set last_at = now(), archived = false where id = tid;
  insert into activity (lead_id, kind, body) values (lid, 'note', 'Submitted website form');
  return lid;
end $$;
revoke all on function submit_web_lead(text,text,text,text,text,text,text,text) from public;
grant execute on function submit_web_lead(text,text,text,text,text,text,text,text) to anon, authenticated;

-- Offer code check for the website ("Got a letter from us?") — only says whether the code exists (codes are sequential, so no names)
create or replace function web_offer_lookup(p_code text) returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from campaign_records where upper(offer_code) = upper(trim(p_code))) $$;
revoke all on function web_offer_lookup(text) from public;
grant execute on function web_offer_lookup(text) to anon, authenticated;

-- Approved testimonials feed the website automatically
create or replace function public_testimonials() returns table(name text, location text, kind text, body text) language sql stable security definer set search_path = public as $$
  select name, location, kind, body from testimonials where ok_to_publish and received_at is not null and coalesce(body,'')<>'' order by received_at desc limit 12 $$;
revoke all on function public_testimonials() from public;
grant execute on function public_testimonials() to anon, authenticated;
select 1;
