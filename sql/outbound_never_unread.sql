-- Sent messages never count as unread (Nov 14, 2026).
-- messages.is_read defaults to false, so any sent text/email/call saved without is_read=true
-- (some sync paths don't set it) lit up the inbox like a new message. This makes every
-- outgoing message read automatically, and fixes the ones already saved.
-- Run once in Supabase > SQL Editor.

create or replace function messages_out_is_read() returns trigger language plpgsql as $$
begin
  if new.direction = 'out' then new.is_read := true; end if;
  return new;
end $$;

drop trigger if exists messages_out_is_read on messages;
create trigger messages_out_is_read before insert or update of direction, is_read on messages
  for each row execute function messages_out_is_read();

update messages set is_read = true where direction = 'out' and coalesce(is_read, false) = false;
