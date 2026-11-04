-- Buy box text alert (Nov 2026): every buy box form submission creates a "New buy box: ..." task (submit_buybox);
-- this trigger calls the buybox-alert edge function, which texts Damien's cell from the builders line.
create table if not exists buybox_alerts (task_id bigint primary key, created_at timestamptz default now(), sent boolean, error text);
alter table buybox_alerts enable row level security;
create or replace function buybox_alert_trg() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.title like 'New buy box: %' then
    perform net.http_post(url := 'https://gdejlpdltnstbwtdpggm.supabase.co/functions/v1/buybox-alert',
      body := jsonb_build_object('task_id', new.id), headers := '{"Content-Type":"application/json"}'::jsonb);
  end if;
  return new;
end $$;
drop trigger if exists buybox_alert on tasks;
create trigger buybox_alert after insert on tasks for each row execute function buybox_alert_trg();
