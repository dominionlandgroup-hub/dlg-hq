-- Remove the foreclosure scout from Supabase (Damien, Oct 30 2026: focus is infill lots + minor splits only).
-- Permanently deletes the foreclosure tables and their data.
select cron.unschedule(jobid) from cron.job where command ilike '%foreclosure%' or jobname ilike '%foreclosure%';
drop table if exists foreclosure_cases cascade;
drop table if exists foreclosure_scout_runs cascade;
drop table if exists foreclosure_settings cascade;
-- Remove Acreage Play (Damien, Oct 30 2026).
drop table if exists acreage_tracts cascade;
drop table if exists acreage_buyers cascade;
drop table if exists acreage_comps cascade;
