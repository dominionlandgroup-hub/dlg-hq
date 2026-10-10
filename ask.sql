-- Claude assistant: read-only queries. The transaction is switched to READ ONLY before the query runs,
-- so nothing the query does (including calling other functions) can change data.
create or replace function ai_readonly_query(q text) returns json language plpgsql security definer set search_path=public set statement_timeout='10s' as $$
declare r json; s text := trim(both from regexp_replace(q, ';\s*$', ''));
begin
  if s !~* '^(select|with)\s' then raise exception 'Only SELECT queries are allowed'; end if;
  if position(';' in s) > 0 then raise exception 'One statement at a time'; end if;
  perform set_config('transaction_read_only', 'on', true);
  execute format('select coalesce(json_agg(t), ''[]''::json) from (select * from (%s) q0 limit 200) t', s) into r;
  return r;
end $$;
revoke all on function ai_readonly_query(text) from public, anon, authenticated;
grant execute on function ai_readonly_query(text) to service_role;

create table if not exists ai_chats (id bigint generated always as identity primary key, user_email text, question text, answer text, created_at timestamptz default now());
alter table ai_chats enable row level security;
drop policy if exists "owner all" on ai_chats;
create policy "owner all" on ai_chats for all to authenticated using (true) with check (true);
select ai_readonly_query('select count(*) n from leads') ok;
