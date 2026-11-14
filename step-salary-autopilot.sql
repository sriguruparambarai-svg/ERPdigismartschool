-- DigiSmart ERP — Salary on autopilot (Nov 2026)
-- Run once in Supabase → SQL Editor → paste all → Run. Safe to run again.
-- On the last day of each month the ERP prepares the salary sheet by itself and the
-- owner approves it in the Owner App (or sends it back to the office with a note).

create table if not exists public.salary_runs (
  id           uuid default gen_random_uuid() primary key,
  school_id    text not null,
  month        text not null,                 -- 'YYYY-MM'
  status       text not null default 'waiting',  -- waiting | approved | sent_back
  rows         jsonb,                         -- one line per staff: gross, LOP days, deduction, net …
  totals       jsonb,                         -- staff, gross, net, lop_staff, lop_amount, missing
  prepared_at  timestamptz default now(),
  prepared_by  text,                          -- 'auto' or the office login that sent it
  decided_at   timestamptz,
  decided_by   text,                          -- Owner App person's name
  note         text,                          -- owner's note when sending back
  unique (school_id, month)
);
alter table public.salary_runs enable row level security;
