-- DLG lead ranking (Nov 27, 2026, Damien): chase the most years delinquent first, then the most owed.
-- score = 100 per year delinquent + 1 per $100 owed + 200 heirs/estate + 300 tax foreclosure filed/referred + 100 multiple lots
-- Read from the card's BACK TAXES line, e.g. "BACK TAXES (...): 10 years past due (2016-2025) - $33,514 total past due".
-- Set automatically on Duet cards (labels starting 📞 or 🔎) whenever the notes or label change.

create or replace function public.dlg_rank_score(p_notes text, p_label text) returns integer
language plpgsql immutable as $$
declare t text; yrs int; y1 int; y2 int; amt numeric; s int; head text;
begin
  t := substring(coalesce(p_notes,'') from 'BACK TAXES[^\n]*');
  if t is null then return null; end if;
  yrs := nullif(substring(t from '(\d+) years? (?:past due|delinquent)'), '')::int;
  if yrs is null then yrs := nullif(substring(t from 'on (\d+) past bills'), '')::int; end if;
  if yrs is null then
    y1 := nullif(substring(t from '(20\d\d|19\d\d)\s*-\s*(?:20\d\d)'), '')::int;
    y2 := nullif(substring(t from '(?:20\d\d|19\d\d)\s*-\s*(20\d\d)'), '')::int;
    if y1 is not null and y2 is not null and y2 >= y1 then yrs := y2 - y1 + 1; end if;
  end if;
  if yrs is null then return null; end if;
  yrs := least(yrs, 10);  -- NC collects 10 years at most
  amt := nullif(replace(substring(t from '\$([\d,]+(?:\.\d\d)?)'), ',', ''), '')::numeric;
  head := coalesce(p_label,'') || ' ' || left(coalesce(p_notes,''), 1500);
  s := yrs * 100 + coalesce(round(amt / 100), 0)::int;
  if head ~* '(heirs?|estate|\mest\M|\mhrs\M|deceased)' then s := s + 200; end if;
  if coalesce(p_notes,'') ~* '(ATT REF|referred to the county.{0,20}foreclosure|tax foreclosure (case|filed)|foreclosure case \d|\d\dCVD\d+|\d\dSP\d+)' then s := s + 300; end if;
  if head ~* '(\d+\s*lots|\d+\s*parcels|both parcels|\+\s*\d+\s*lots?)' then s := s + 100; end if;
  return s;
end $$;

create or replace function public.dlg_rank_trigger() returns trigger language plpgsql as $$
declare sc int;
begin
  if coalesce(new.property_label,'') ~ '^(📞|🔎)' then
    sc := dlg_rank_score(new.notes, new.property_label);
    if sc is not null then new.call_score := sc; end if;
  end if;
  return new;
end $$;

drop trigger if exists dlg_rank_on_deals on public.deals;
create trigger dlg_rank_on_deals before insert or update of notes, property_label on public.deals
  for each row execute function public.dlg_rank_trigger();

-- re-rank every Duet card now
update public.deals set call_score = dlg_rank_score(notes, property_label)
 where property_label ~ '^(📞|🔎)' and dlg_rank_score(notes, property_label) is not null;

select count(*) filter (where property_label like '📞%') as dialer_ranked,
       count(*) filter (where property_label like '🔎%') as research_ranked
  from public.deals where property_label ~ '^(📞|🔎)' and dlg_rank_score(notes, property_label) is not null;
