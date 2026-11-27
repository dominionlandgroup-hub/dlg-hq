-- Caller card shows every parcel on a multi-lot lead (Nov 27, 2026).
-- caller_lead_core's 'apn' becomes the main parcel plus every parcel in deals.extra_property_ids,
-- e.g. "5612-13-8996, 5612-13-9850". Applied in Supabase on Nov 27, 2026; safe to run again.
do $do$ declare s text; n text; begin
  s := pg_get_functiondef('public.caller_lead_core(bigint)'::regprocedure);
  if position('extra_property_ids) and q.apn is not null' in s) > 0 then return; end if;  -- already applied
  n := replace(s, '''apn'', coalesce(p.apn, l.apn)',
    '''apn'', concat_ws('', '', coalesce(p.apn, l.apn), (select string_agg(q.apn, '', '' order by q.apn) from properties q where q.id = any(d.extra_property_ids) and q.apn is not null))');
  if n = s then raise exception 'caller_lead_core: apn pattern not found'; end if;
  execute n;
end $do$;
