-- DigiSmart ERP — each school's own wording for defaulter messages (Nov 2026)
-- Run once in Supabase → SQL Editor → paste all → Run. Safe to run again.
-- Only the ERP server (service key) reads and writes this table.

create table if not exists public.defaulter_wording (
  school_id  text primary key,
  wording    jsonb not null default '{}'::jsonb,   -- { homework: {en, ta}, test_absent: {en, ta}, ... }
  updated_at timestamptz default now(),
  updated_by text
);

alter table public.defaulter_wording enable row level security;
