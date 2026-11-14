-- DigiSmart ERP — Automatic fee reminders + Owner App (Nov 2026)
-- Run once in Supabase → SQL Editor → paste all → Run. Safe to run again.
-- Only the ERP server (service key) reads and writes the new tables.

-- 1. Each school's reminder settings (on/off, days before and after the due date, van due dates)
alter table public.fee_settings add column if not exists auto_reminders jsonb;

-- 2. Every reminder sent to a parent — one per child per day at most
create table if not exists public.fee_auto_reminders (
  id         uuid default gen_random_uuid() primary key,
  school_id  text not null,
  student_id uuid not null,
  sent_on    date not null,
  kind       text not null,              -- 'before' (due soon) or 'after' (overdue)
  student_name  text,
  student_class text,
  mobile     text,                        -- so the owner can call parents without the app
  lines      jsonb,                       -- [{ text, amount, due }] month / term and amount
  total      numeric default 0,
  message    text,                        -- the full message the parent sees
  has_app    boolean default false,       -- parent had phone alerts on when it was sent
  seen_at    timestamptz,                 -- when the parent opened it in the parent app
  created_at timestamptz default now(),
  unique (school_id, student_id, sent_on)
);
alter table public.fee_auto_reminders add column if not exists mobile text;
create index if not exists idx_feeauto_school_day on public.fee_auto_reminders(school_id, sent_on);
alter table public.fee_auto_reminders enable row level security;

-- 3. Owner App: the owner's phones that get alerts
create table if not exists public.owner_push_subscriptions (
  id         uuid default gen_random_uuid() primary key,
  school_id  text not null,
  endpoint   text not null,
  p256dh     text not null,
  auth       text not null,
  updated_at timestamptz default now(),
  unique (school_id, endpoint)
);
alter table public.owner_push_subscriptions enable row level security;

-- 4. Owner App inbox: one alert per kind per day (e.g. today's fee reminders)
create table if not exists public.owner_alerts (
  id         uuid default gen_random_uuid() primary key,
  school_id  text not null,
  kind       text not null,               -- 'fee_reminders' (more kinds later)
  alert_date date not null,
  title      text,
  body       text,
  data       jsonb,
  created_at timestamptz default now(),
  unique (school_id, kind, alert_date)
);
create index if not exists idx_owner_alerts_school on public.owner_alerts(school_id, alert_date desc);
alter table public.owner_alerts enable row level security;

-- Reminders stay OFF until the school switches them on in Fee Management → Settings →
-- Automatic Fee Reminders (use "See who gets a reminder" there first to check the list).
