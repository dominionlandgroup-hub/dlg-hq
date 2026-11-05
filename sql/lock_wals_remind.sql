-- Nov 2026 sweep: wals_remind() sends Vacant Land Specialist course reminder emails. Only the daily cron job
-- "wals reminders" (runs as postgres, 14:00 UTC) should call it; anyone with the public key could call it before this.
revoke execute on function public.wals_remind() from public, anon, authenticated;
select has_function_privilege('anon','public.wals_remind()','execute') as anon_can_run,
       has_function_privilege('postgres','public.wals_remind()','execute') as cron_can_run;
