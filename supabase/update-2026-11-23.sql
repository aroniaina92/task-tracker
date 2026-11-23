-- =====================================================================
-- MY STEPS – update of 23 Nov 2026: ☀️ "Do today" is for one day
-- Run once in Supabase: SQL Editor → New snippet → paste → Run. Safe to run again.
-- (Run the 17 Nov update first if you have not done it yet.)
-- =====================================================================
alter table public.tasks add column if not exists today_set date;   -- the day ☀️ was set

create or replace function public.tasks_before_write() returns trigger
language plpgsql as $$
declare base date; nxt date; today_mg date := (now() at time zone 'Indian/Antananarivo')::date; n int;
begin
  new.updated_at := now();
  -- ☀️ "Do today" remembers the day it was set (it only counts for that day)
  if new.today and (tg_op = 'INSERT' or not coalesce(old.today, false) or new.today_set is null) then new.today_set := today_mg;
  elsif not new.today then new.today_set := null; end if;
  if new.status = 'Completed' and (tg_op = 'INSERT' or old.status is distinct from 'Completed') then
    if new.completed_on is null then new.completed_on := now(); end if;
    new.today := false; new.start_now := '';
    -- repeating task: create the next one (only once, even if it is reopened and ticked again)
    if coalesce(new.repeat, '') <> '' and not coalesce(new.repeat_spawned, false) and public.next_repeat(current_date, new.repeat) is not null then
      base := coalesce(new.due_date, today_mg);
      n := 1; nxt := public.next_repeat(base, new.repeat, 1);
      while nxt <= today_mg and n < 5000 loop n := n + 1; nxt := public.next_repeat(base, new.repeat, n); end loop;
      insert into public.tasks (owner_id, main_goal, category, objective, task, priority, energy, context, scheduled_date, due_date,
                                est_hours, notes, dependencies, waiting_on, auto_schedule, time_category, repeat)
      values (new.owner_id, new.main_goal, new.category, new.objective, new.task, new.priority, new.energy, new.context,
              case when new.scheduled_date is not null then new.scheduled_date + (nxt - base) end, nxt,
              new.est_hours, new.notes, new.dependencies, new.waiting_on, new.auto_schedule, new.time_category, new.repeat);
      new.repeat_spawned := true;
    end if;
  elsif new.status <> 'Completed' and tg_op = 'UPDATE' and old.status = 'Completed' then
    new.completed_on := null;
  end if;
  return new;
end $$;
drop trigger if exists tasks_before_write on public.tasks;
create trigger tasks_before_write before insert or update on public.tasks
  for each row execute function public.tasks_before_write();

-- tasks already marked ☀️ count for today
update public.tasks set today_set = (now() at time zone 'Indian/Antananarivo')::date where today and today_set is null;
