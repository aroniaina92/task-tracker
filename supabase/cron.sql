-- =====================================================================
-- MY STEPS – automatic re-planning (Supabase Cron)
-- 1. Database → Extensions (or Integrations → Cron): turn on  pg_cron  and  pg_net
-- 2. Replace YOUR-PROJECT-REF and YOUR-CRON-SECRET below (same value as the
--    CRON_SECRET secret of the "owner" function), then run this in the SQL Editor.
-- Times are UTC: :07 every hour, and a full re-plan at 23:15 UTC = 02:15 in Madagascar.
-- =====================================================================
select cron.unschedule(jobname) from cron.job where jobname in ('mysteps-hourly', 'mysteps-nightly');

select cron.schedule('mysteps-hourly', '7 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/owner',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'YOUR-CRON-SECRET'),
    body := '{"action":"cron","mode":"incremental"}'::jsonb,
    timeout_milliseconds := 60000);
$$);

select cron.schedule('mysteps-nightly', '15 23 * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/owner',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'YOUR-CRON-SECRET'),
    body := '{"action":"cron","mode":"full"}'::jsonb,
    timeout_milliseconds := 120000);
$$);

-- check:  select jobname, schedule from cron.job;
-- runs:   select * from cron.job_run_details order by start_time desc limit 10;
