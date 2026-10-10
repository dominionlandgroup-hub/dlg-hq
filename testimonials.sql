-- Testimonials: ask sellers after closing, store what comes back for the website
create table if not exists testimonials (
  id bigint generated always as identity primary key,
  deal_id bigint references deals(id) on delete set null,
  lead_id bigint references leads(id) on delete set null,
  name text, location text,
  kind text default 'text' check (kind in ('text','video')),
  body text, video_url text,
  ok_to_publish boolean default false,
  requested_at timestamptz, received_at timestamptz,
  created_at timestamptz default now()
);
alter table testimonials enable row level security;
drop policy if exists "owner all" on testimonials;
create policy "owner all" on testimonials for all to authenticated using (true) with check (true);

insert into templates (kind, name, body, updated_at)
select 'text','Testimonial request',
'Hi {first_name}, this is Damien with Dominion Land Group. Thank you again for trusting us with your property. Would you be willing to share a few words about your experience? A short text reply is perfect, or a quick 30-second video from your phone if you are comfortable. It helps other landowners know they can trust us. God bless!', now()
where not exists (select 1 from templates where kind='text' and name='Testimonial request');

insert into templates (kind, name, subject, body, updated_at)
select 'email','Testimonial request','Thank you from Dominion Land Group',
'Hi {first_name},

Thank you again for trusting Dominion Land Group with your property. It was a blessing working with you.

Would you be willing to share a few words about your experience? You can simply reply to this email, or record a quick 30-second video on your phone and send it back, whichever you are comfortable with.

Your words help other landowners know they can trust us.

God bless,
Damien Dupee
Dominion Land Group
(980) 990-2356', now()
where not exists (select 1 from templates where kind='email' and name='Testimonial request');

-- When a deal closes, put "ask for a testimonial" on the task list (nothing is sent automatically)
create or replace function deal_closed_testimonial() returns trigger language plpgsql security definer set search_path=public as $$
declare nm text;
begin
  if new.status='won' and coalesce(old.status,'')<>'won' then
    select coalesce(full_name, 'seller') into nm from leads where id=new.lead_id;
    if not exists (select 1 from tasks where deal_id=new.id and title like 'Ask % for a testimonial%') then
      insert into tasks (deal_id, lead_id, title, due_at) values (new.id, new.lead_id, 'Ask '||coalesce(nm,'the seller')||' for a testimonial (text or video)', now() + interval '2 days');
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_deal_closed_testimonial on deals;
create trigger trg_deal_closed_testimonial after update of status on deals for each row execute function deal_closed_testimonial();

-- One-time to-do for Damien
insert into tasks (title, due_at)
select 'Start collecting testimonials from past sellers (text or video) for the website', now() + interval '3 days'
where not exists (select 1 from tasks where title like 'Start collecting testimonials%');

select (select count(*) from templates where name='Testimonial request') tpl, (select count(*) from tasks where status='todo') open_tasks;
