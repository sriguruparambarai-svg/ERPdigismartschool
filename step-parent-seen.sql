-- DigiSmart ERP — Seen / Not seen by parents (Nov 2026)
-- Run once in Supabase → SQL Editor → paste all → Run. Safe to run again.
-- Only the ERP server (service key) reads and writes these.

-- 1. When each child's parent last opened the parent app
create table if not exists public.parent_app_seen (
  school_id  text not null,
  student_id uuid not null,
  first_at   timestamptz default now(),   -- first time ever opened
  last_at    timestamptz default now(),   -- most recent opening
  primary key (school_id, student_id)
);
alter table public.parent_app_seen enable row level security;

-- 2. When the parent saw each homework / test / discipline message
alter table public.defaulter_entries add column if not exists seen_at timestamptz;
