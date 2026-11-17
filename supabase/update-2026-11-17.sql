-- =====================================================================
-- MY STEPS – update of 17 Nov 2026: repeating tasks + habits
-- Run once in Supabase: SQL Editor → New snippet → paste → Run.
-- Safe to run again.
-- =====================================================================

-- ---------- Repeating tasks ----------
alter table public.tasks add column if not exists repeat         text    not null default '';   -- '', daily, weekdays, weekly, biweekly, monthly, yearly
alter table public.tasks add column if not exists repeat_spawned boolean not null default false; -- next copy already made

drop function if exists public.next_repeat(date, text);   -- older test version
-- the date n repeats after d (monthly/yearly always counted from the original day, so 31 Jan → 28 Feb → 31 Mar)
create or replace function public.next_repeat(d date, rule text, n int default 1) returns date
language plpgsql immutable as $$
declare x date := d; i int := 0;
begin
  case rule
    when 'daily'    then return d + n;
    when 'weekly'   then return d + 7 * n;
    when 'biweekly' then return d + 14 * n;
    when 'monthly'  then return (d + make_interval(months => n))::date;
    when 'yearly'   then return (d + make_interval(years => n))::date;
    when 'weekdays' then
      while i < n loop x := x + 1; if extract(isodow from x) < 6 then i := i + 1; end if; end loop;
      return x;
    else return null;
  end case;
end $$;

-- completion date, "do today", "do now" and the next copy of a repeating task
create or replace function public.tasks_before_write() returns trigger
language plpgsql as $$
declare base date; nxt date; today_mg date := (now() at time zone 'Indian/Antananarivo')::date; n int;
begin
  new.updated_at := now();
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

-- ---------- Habits (reserved time, owner's scheduling) ----------
create table if not exists public.habits (
  id         text primary key default substr(md5(random()::text || clock_timestamp()::text), 1, 8),
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  minutes    int  not null default 30 check (minutes between 5 and 480),
  days       int[] not null default '{1,2,3,4,5}',                       -- 0 = Sunday … 6 = Saturday
  ideal      text not null default '06:00' check (ideal ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  flex       int  not null default 60 check (flex between 0 and 360),    -- may move this many minutes earlier or later
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.habits enable row level security;
drop policy if exists "own rows" on public.habits;
create policy "own rows" on public.habits for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
grant select, insert, update, delete on public.habits to authenticated;
grant execute on function public.next_repeat(date, text, int) to authenticated;
