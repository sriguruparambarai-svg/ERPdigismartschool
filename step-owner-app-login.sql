-- DigiSmart ERP — Owner App login with the owner's own password (Nov 2026)
-- Run once in Supabase → SQL Editor → paste all → Run. Safe to run again.
-- DigiSmart super admin adds each person with a one-time starting PIN;
-- on first login they must make their own password, which nobody else can see.

create table if not exists public.owner_app_users (
  id            uuid default gen_random_uuid() primary key,
  school_id     text not null,
  name          text not null,
  phone         text not null,             -- 10-digit mobile number, used to log in
  start_pin     text,                      -- locked (hashed) one-time starting PIN; cleared after first login
  password      text,                      -- locked (hashed) password the person made themselves
  must_change   boolean default true,      -- true until they make their own password
  pass_ver      integer default 1,         -- goes up on every reset → old phones are logged out
  failed_tries  integer default 0,
  locked_until  timestamptz,
  last_login    timestamptz,
  created_at    timestamptz default now(),
  unique (school_id, phone)
);
create index if not exists idx_owner_app_users_phone on public.owner_app_users(phone);
alter table public.owner_app_users enable row level security;

-- Which person each phone's alerts belong to (so a reset logs out only that person's phone)
alter table public.owner_push_subscriptions add column if not exists user_id uuid;
