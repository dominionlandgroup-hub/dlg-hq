-- Quo (OpenPhone) phone system link
create table if not exists phone_numbers (
  number text primary key,          -- 10 digits, e.g. 7042755457
  inbox text not null default 'seller' check (inbox in ('seller','buyer')),
  label text,
  quo_id text,                      -- PN... id in Quo
  active boolean default true,
  created_at timestamptz default now()
);
alter table phone_numbers enable row level security;
drop policy if exists "owner all" on phone_numbers;
create policy "owner all" on phone_numbers for all to authenticated using (true) with check (true);
insert into phone_numbers (number, inbox, label) values
  ('7042755457','seller','Direct mail master (porting from GHL)'),
  ('7043873482','seller','GHL number (porting)'),
  ('9802178806','buyer','Builder outreach')
on conflict (number) do nothing;

create table if not exists quo_events (id text primary key, type text, received_at timestamptz default now(), payload jsonb, error text);
alter table quo_events enable row level security;
drop policy if exists "owner read" on quo_events;
create policy "owner read" on quo_events for select to authenticated using (true);

create or replace function phone10(p text) returns text language sql immutable as $$ select right(regexp_replace(coalesce(p,''),'\D','','g'),10) $$;
create index if not exists leads_phone10_idx on leads (phone10(phone));
create index if not exists leads_phone10b_idx on leads (phone10(phone2));
create index if not exists leads_phone10c_idx on leads (phone10(phone3));
create unique index if not exists messages_external_uidx on messages (external_id);

-- Find or create the contact + thread for an external number on one of our numbers
create or replace function quo_thread(their text, ours text) returns json language plpgsql security definer set search_path=public as $$
declare d text := phone10(their); o text := phone10(ours); bx text; lid bigint; tid bigint; nm text;
begin
  select inbox into bx from phone_numbers where number=o; bx := coalesce(bx,'seller');
  select id, full_name into lid, nm from leads where phone10(phone)=d or phone10(phone2)=d or phone10(phone3)=d
    order by (source='pebble') desc, id limit 1;
  if lid is null then
    insert into leads (phone, status, source, lead_source, inbox)
    values ('('||substr(d,1,3)||') '||substr(d,4,3)||'-'||substr(d,7,4), 'new', 'quo', 'inbound', bx) returning id into lid;
  end if;
  select id into tid from threads where inbox=bx and (lead_id=lid or phone10(phone)=d) order by last_at desc nulls last limit 1;
  if tid is null then
    insert into threads (inbox, lead_id, title, phone, our_number, last_at, source, pinned, archived, muted)
    values (bx, lid, coalesce(nm,'('||substr(d,1,3)||') '||substr(d,4,3)||'-'||substr(d,7,4)), '('||substr(d,1,3)||') '||substr(d,4,3)||'-'||substr(d,7,4), o, now(), 'quo', false, false, false)
    returning id into tid;
  end if;
  return json_build_object('thread_id',tid,'lead_id',lid,'inbox',bx);
end $$;
revoke all on function quo_thread(text,text) from anon, authenticated;
select count(*) from phone_numbers;
