-- Website form spam block (Nov 22, 2026)
-- Bots have been filling out the website form about once a day since Oct 28 (12 so far). Every one looks the same:
--   name, property and county are random letters ("VdbZlxMTCFyumNxklMjXWdyJ"), email is a gmail with dots in it
--   ("a.b.c.de.f.1.2@gmail.com"), and a random 16-letter offer code. Each one makes a new contact + Seller Inbox thread.
-- Rate limits did not catch them because each bot uses a new phone and email and only sends one a day.
-- Fix: submit_web_lead quietly drops a submission when at least 2 of name / property / county are a single run of 10+ letters
-- with mixed-up capitals, or 1 of them is AND the email is a gmail with 3+ dots. The bot still sees "success" (so it doesn't
-- retry with a different trick), nothing is created in the CRM, and the drop is logged in form_submissions (form 'web_spam').
-- Tested against every website lead in the CRM: catches all 12 bots and none of the real sellers.
-- Same submit_web_lead as sql/bug_sweep_nov5.sql plus the spam check. Run this whole file in the Supabase SQL editor.

create or replace function web_lead_is_spam(p_name text, p_email text, p_address text, p_county text)
returns boolean language sql immutable set search_path = public as $$
  with f(v) as (values (btrim(coalesce(p_name,''))), (btrim(coalesce(p_address,''))), (btrim(coalesce(p_county,'')))),
  j as (select count(*) filter (where v ~ '^[A-Za-z]{10,}$'
          and (select count(*) from regexp_matches(v, '[a-z][A-Z]', 'g')) >= 3) n from f)
  select n >= 2 or (n >= 1 and coalesce(p_email,'') ~* '^[^@]*(\.[^@.]*){3,}@gmail\.com$') from j $$;
revoke all on function web_lead_is_spam(text,text,text,text) from public, anon, authenticated;

create or replace function submit_web_lead(
  p_name text, p_phone text, p_email text, p_address text, p_county text,
  p_apn text, p_offer_code text, p_message text)
returns bigint language plpgsql security definer set search_path = public as $$
declare lid bigint; tid bigint; rid bigint; rlid bigint; o_name text; o_addr text; o_apn text; matched boolean := false;
  code text; d text; body text;
begin
  p_name := left(btrim(replace(coalesce(p_name,''),chr(13),'')),200); p_phone := left(btrim(replace(coalesce(p_phone,''),chr(13),'')),40);
  p_email := left(btrim(replace(coalesce(p_email,''),chr(13),'')),200); p_address := left(btrim(replace(coalesce(p_address,''),chr(13),'')),300);
  p_county := left(btrim(replace(coalesce(p_county,''),chr(13),'')),80); p_apn := left(btrim(replace(coalesce(p_apn,''),chr(13),'')),80);
  p_message := left(replace(coalesce(p_message,''),chr(13),''),2000);
  code := upper(btrim(left(coalesce(p_offer_code,''),40))); d := phone10(p_phone);
  if p_phone = '' and p_email = '' then raise exception 'phone or email required'; end if;
  -- Spam bots (random-letter names/addresses, dotted gmail): pretend it worked, save nothing in the CRM, log it for review.
  if web_lead_is_spam(p_name, p_email, p_address, p_county) then
    insert into form_submissions (form, key) values ('web_spam', left(lower(coalesce(nullif(p_email,''), p_phone)),200));
    return 0;
  end if;
  perform form_rate_check('web_lead', coalesce(nullif(d,''), lower(p_email)), 5, interval '1 day', 30, interval '1 hour');
  if code <> '' then
    select r.id, r.lead_id, l.full_name, pr.address, pr.apn into rid, rlid, o_name, o_addr, o_apn
      from campaign_records r left join leads l on l.id = r.lead_id left join properties pr on pr.id = r.property_id
      where upper(btrim(r.offer_code)) = code order by r.id desc limit 1;
    if rid is not null and web_lead_matches(p_name, p_address, p_apn, o_name, o_addr, o_apn) then
      matched := true; lid := rlid;
      update campaign_records set responded = true where id = rid;
    end if;
  end if;
  if lid is null and length(d) = 10 then
    select id into lid from leads where phone10(phone) = d or phone10(phone2) = d or phone10(phone3) = d order by id limit 1;
  end if;
  if lid is null then
    insert into leads (full_name, phone, email, prop_address, county, apn, offer_code, status, lead_source, source, notes, inbox)
    values (nullif(p_name,''), nullif(p_phone,''), nullif(p_email,''), nullif(p_address,''), nullif(p_county,''), nullif(p_apn,''),
            case when matched then code end, 'new', 'website', 'web', nullif(p_message,''), 'seller')
    returning id into lid;
  else
    update leads set status = case when status = 'record' then 'new' else status end, lead_source = coalesce(lead_source,'website') where id = lid;
  end if;
  select id into tid from threads where lead_id = lid and inbox = 'seller' order by last_at desc nulls last limit 1;
  if tid is null then
    insert into threads (inbox, lead_id, title, phone, email, last_at, source, pinned, archived, muted)
    values ('seller', lid, coalesce(nullif(p_name,''), nullif(p_phone,''), p_email), nullif(p_phone,''), nullif(p_email,''), now(), 'web', false, false, false)
    returning id into tid;
  end if;
  body := 'Website form' ||
    case when p_name <> '' then E'\nName: ' || p_name else '' end ||
    case when p_phone <> '' then E'\nPhone: ' || p_phone else '' end ||
    case when p_email <> '' then E'\nEmail: ' || p_email else '' end ||
    case when code <> '' then E'\nOffer code: ' || code ||
      case when rid is null then ' (not found)' when not matched then ' (CHECK: name/property did not match the owner on file, so it was not linked)' else '' end else '' end ||
    case when p_address <> '' then E'\nProperty: ' || p_address else '' end ||
    case when p_county <> '' then E'\nCounty: ' || p_county else '' end ||
    case when p_apn <> '' then E'\nAPN: ' || p_apn else '' end ||
    case when p_message <> '' then E'\n\n' || p_message else '' end;
  insert into messages (thread_id, lead_id, inbox, channel, direction, body, their_number, is_read)
  values (tid, lid, 'seller', 'web', 'in', body, nullif(p_phone,''), false);
  update threads set last_at = now(), archived = false where id = tid;
  insert into activity (lead_id, kind, body) values (lid, 'note', 'Submitted website form');
  return lid;
end $$;
revoke all on function submit_web_lead(text,text,text,text,text,text,text,text) from public;
grant execute on function submit_web_lead(text,text,text,text,text,text,text,text) to anon, authenticated;

-- Checks (should return: true, true, false, false)
select web_lead_is_spam('VdbZlxMTCFyumNxklMjXWdyJ','a.b.c.de.f.1.2@gmail.com','jGdBqdpStbIuDEZSxgGjl','SvNDhHDDpzUTocETPaSxV'),
       web_lead_is_spam('xdNtlAolILDpzNIYat','x.y.zz.q1.2@gmail.com','12 Main St','Gaston'),
       web_lead_is_spam('Jane Sample','jsample@example.com','123 Example Rd',''),
       web_lead_is_spam('Mary McDonald','','Parcel 12345','McDowell');
