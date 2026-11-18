-- DigiSmart ERP — "Not done yet" alerts (Nov 2026)
-- Run once in Supabase → SQL Editor → paste all → Run. Safe to run again.
-- Only the ERP server (service key) reads and writes these.

-- 1. Owner App people can be the owner (fees, salary, reports) or the principal (only "not done yet" alerts)
alter table public.owner_app_users add column if not exists role text not null default 'owner';
alter table public.owner_app_users drop constraint if exists owner_app_users_role_check;
alter table public.owner_app_users add constraint owner_app_users_role_check check (role in ('owner', 'principal'));

-- 2. Which classes' Daily Check Sheet came in each day
create table if not exists public.check_sheet_days (
  school_id  text not null,
  class      text not null,
  section    text not null default '',
  saved_on   date not null,          -- the day the office saved it
  sheet_date date,                   -- the day on the sheet
  staff      text,
  saved_at   timestamptz default now(),
  primary key (school_id, class, section, saved_on)
);
alter table public.check_sheet_days enable row level security;

-- 3. TeachBot's part: teachers who didn't submit their day / last week's checklist not uploaded
create table if not exists public.not_done_feed (
  school_id  text not null,
  day        date not null,
  part       text not null,          -- 'teachers'
  data       jsonb,
  updated_at timestamptz default now(),
  primary key (school_id, day, part)
);
alter table public.not_done_feed enable row level security;
