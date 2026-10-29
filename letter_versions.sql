-- Letter versions (DLG HQ). Each campaign points at the exact letter wording it mailed, so the scoreboard can compare versions of the same letter.
create table if not exists letter_versions (
  id bigint generated always as identity primary key,
  template text not null,          -- file name, e.g. 'DLG Letter 1 - Blessings.docx'
  version integer not null,
  body text,                       -- the letter text (merge fields show as blanks)
  note text,                       -- what changed
  created_at timestamptz not null default now(),
  unique (template, version)
);
alter table campaigns add column if not exists letter_version_id bigint references letter_versions(id);
alter table letter_versions enable row level security;
create policy "owner all" on letter_versions for all to authenticated using (true) with check (true);

-- New or changed campaigns automatically get the latest version of their letter.
create or replace function campaigns_set_letter_version() returns trigger language plpgsql as $$
begin
  if new.template is not null and (new.letter_version_id is null or (tg_op = 'UPDATE' and new.template is distinct from old.template)) then
    select id into new.letter_version_id from letter_versions where template = new.template order by version desc limit 1;
  end if;
  return new;
end $$;
drop trigger if exists campaigns_letter_version on campaigns;
create trigger campaigns_letter_version before insert or update of template, letter_version_id on campaigns
  for each row execute function campaigns_set_letter_version();
