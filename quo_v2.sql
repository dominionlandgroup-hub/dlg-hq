-- Quo texting v2: a reply always lands in the thread for THAT phone number.
-- Before: a text from a lead's 2nd number could join the thread for their 1st number, so your reply went to the wrong phone.
-- Lead pick: the lead already on that number's thread, else a live lead (not dead/wrong number) with that number.
create or replace function quo_thread(their text, ours text) returns json language plpgsql security definer set search_path=public as $$
declare d text := phone10(their); o text := phone10(ours); bx text; lid bigint; tid bigint; nm text; fmt text;
begin
  fmt := '('||substr(d,1,3)||') '||substr(d,4,3)||'-'||substr(d,7,4);
  select inbox into bx from phone_numbers where number=o; bx := coalesce(bx,'seller');
  select id, lead_id into tid, lid from threads where inbox=bx and phone10(phone)=d order by last_at desc nulls last limit 1;
  if lid is null then
    select id into lid from leads where phone10(phone)=d or phone10(phone2)=d or phone10(phone3)=d
      order by (coalesce(status,'') in ('dead','wrong_number','not_selling')) asc, (source='pebble') desc, id limit 1;
  end if;
  if lid is null then
    insert into leads (phone, status, source, lead_source, inbox) values (fmt, 'new', 'quo', 'inbound', bx) returning id into lid;
  end if;
  select full_name into nm from leads where id=lid;
  if tid is null then
    insert into threads (inbox, lead_id, title, phone, our_number, last_at, source, pinned, archived, muted)
    values (bx, lid, coalesce(nm,fmt), fmt, o, now(), 'quo', false, false, false) returning id into tid;
  else
    update threads set lead_id=lid where id=tid and lead_id is null;
  end if;
  return json_build_object('thread_id',tid,'lead_id',lid,'inbox',bx);
end $$;
revoke all on function quo_thread(text,text) from anon, authenticated;
