-- =====================================================================
-- MY STEPS – Supabase database
-- Paste this whole file in Supabase: SQL Editor → New query → Run.
-- Safe to run again (it only creates what is missing).
-- =====================================================================

-- ---------- People ----------
create table if not exists public.profiles (
  id    uuid primary key references auth.users(id) on delete cascade,
  email text,
  name  text,
  role  text not null default 'user' check (role in ('admin', 'user'))
);

-- a profile is created automatically for each new account
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Goals, categories, objectives ----------
create table if not exists public.goals (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  sort       int  not null default 0,
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);
create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  main_goal  text,
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);
create table if not exists public.objectives (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  category   text,
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

-- ---------- Tasks ----------
create table if not exists public.tasks (
  id             text primary key default substr(md5(random()::text || clock_timestamp()::text), 1, 8),
  owner_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  main_goal      text,
  category       text,
  objective      text,
  task           text not null,
  priority       text,
  energy         int check (energy between 1 and 5),
  context        text,
  scheduled_date date,
  due_date       date,
  est_hours      numeric(6,2),
  status         text not null default 'Not Started',
  notes          text,
  dependencies   text,
  waiting_on     text,
  today          boolean not null default false,
  completed_on   timestamptz,
  start_now      text not null default '',
  auto_schedule  boolean not null default false,
  time_category  text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists tasks_owner_idx on public.tasks (owner_id, status);

-- completion date, "do today" and "do now" are kept consistent by the database
create or replace function public.tasks_before_write() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'Completed' and (tg_op = 'INSERT' or old.status is distinct from 'Completed') then
    if new.completed_on is null then new.completed_on := now(); end if;
    new.today := false; new.start_now := '';
  elsif new.status <> 'Completed' and tg_op = 'UPDATE' and old.status = 'Completed' then
    new.completed_on := null;
  end if;
  return new;
end $$;
drop trigger if exists tasks_before_write on public.tasks;
create trigger tasks_before_write before insert or update on public.tasks
  for each row execute function public.tasks_before_write();

-- ---------- Ideas ----------
create table if not exists public.ideas (
  id         text primary key default substr(md5(random()::text || clock_timestamp()::text), 1, 8),
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  text       text not null,
  title      text generated always as (left(split_part(text, E'\n', 1), 120)) stored,
  color      text not null default 'sand',
  pinned     boolean not null default false,
  goal       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Meeting requests (written by the booking function only) ----------
create table if not exists public.bookings (
  id         text primary key default substr(md5(random()::text || clock_timestamp()::text), 1, 10),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  email      text not null,
  minutes    int  not null,
  start_at   timestamptz not null,
  end_at     timestamptz not null,
  topic      text not null default '',
  status     text not null default 'Pending' check (status in ('Pending', 'Accepted', 'Declined')),
  event_id   text,
  meet_link  text,
  created_at timestamptz not null default now()
);

-- ---------- Settings + scheduler status (one row per person) ----------
create table if not exists public.settings (
  owner_id         uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data             jsonb not null default '{}'::jsonb,   -- time categories, goal map, booking options…
  status           jsonb not null default '{}'::jsonb,   -- written by the scheduler
  google_connected boolean not null default false,
  sched_lock       timestamptz,                          -- stops two planning runs at the same time
  updated_at       timestamptz not null default now()
);
alter table public.settings add column if not exists sched_lock timestamptz;

-- ---------- Google token (never readable from the app) ----------
create table if not exists public.google_tokens (
  owner_id      uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  updated_at    timestamptz not null default now()
);

-- =====================================================================
-- Privacy rules (Row Level Security): everyone sees and changes only their own rows
-- =====================================================================
alter table public.profiles      enable row level security;
alter table public.goals         enable row level security;
alter table public.categories    enable row level security;
alter table public.objectives    enable row level security;
alter table public.tasks         enable row level security;
alter table public.ideas         enable row level security;
alter table public.bookings      enable row level security;
alter table public.settings      enable row level security;
alter table public.google_tokens enable row level security;   -- no policy: only the server functions can read it

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select using (id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array['goals', 'categories', 'objectives', 'tasks', 'ideas'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;

drop policy if exists "own bookings" on public.bookings;
create policy "own bookings" on public.bookings for select using (owner_id = auth.uid());

drop policy if exists "own settings read" on public.settings;
create policy "own settings read" on public.settings for select using (owner_id = auth.uid());
drop policy if exists "own settings insert" on public.settings;
create policy "own settings insert" on public.settings for insert with check (owner_id = auth.uid());
drop policy if exists "own settings update" on public.settings;
create policy "own settings update" on public.settings for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- =====================================================================
-- Reset tools (called from the app: Me → Advanced)
-- =====================================================================
create or replace function public.reset_many(kind text, names text[], itself boolean)
returns text language plpgsql security invoker set search_path = public as $$
declare t int := 0; o int := 0; c int := 0; g int := 0; n int; cats text[];
begin
  if kind = 'objective' then
    delete from tasks where owner_id = auth.uid() and objective = any(names); get diagnostics t = row_count;
    if itself then delete from objectives where owner_id = auth.uid() and name = any(names); get diagnostics o = row_count; end if;
  elsif kind = 'category' then
    delete from tasks where owner_id = auth.uid() and category = any(names); get diagnostics t = row_count;
    delete from objectives where owner_id = auth.uid() and category = any(names); get diagnostics o = row_count;
    if itself then delete from categories where owner_id = auth.uid() and name = any(names); get diagnostics c = row_count; end if;
  elsif kind = 'goal' then
    select coalesce(array_agg(name), '{}') into cats from categories where owner_id = auth.uid() and main_goal = any(names);
    delete from tasks where owner_id = auth.uid() and main_goal = any(names); get diagnostics t = row_count;
    delete from objectives where owner_id = auth.uid() and category = any(cats); get diagnostics o = row_count;
    delete from categories where owner_id = auth.uid() and main_goal = any(names); get diagnostics c = row_count;
    if itself then delete from goals where owner_id = auth.uid() and name = any(names); get diagnostics g = row_count; end if;
  else
    raise exception 'Unknown reset kind %', kind;
  end if;
  return 'Removed ' || t || ' task(s)'
    || case when o > 0 then ', ' || o || ' objective(s)' else '' end
    || case when c > 0 then ', ' || c || ' categor' || case when c > 1 then 'ies' else 'y' end else '' end
    || case when g > 0 then ', ' || g || ' goal(s)' else '' end || '.';
end $$;

create or replace function public.reset_all(also_goals boolean)
returns text language plpgsql security invoker set search_path = public as $$
declare t int;
begin
  delete from tasks where owner_id = auth.uid(); get diagnostics t = row_count;
  delete from objectives where owner_id = auth.uid();
  delete from categories where owner_id = auth.uid();
  if also_goals then delete from goals where owner_id = auth.uid(); end if;
  return t || ' task(s) removed' || case when also_goals then ', goals removed too.' else '. Goals kept.' end;
end $$;

grant execute on function public.reset_many(text, text[], boolean) to authenticated;
grant execute on function public.reset_all(boolean) to authenticated;
