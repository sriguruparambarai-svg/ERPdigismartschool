-- DigiSmart ERP — Daily Check Sheet, repeat defaulters and "I have seen" (Nov 2026)
-- Run once in Supabase → SQL Editor → paste all → Run. Safe to run again.
-- Only the ERP server (service key) reads and writes these.

-- 1. Repeat-defaulter messages: 3 times in a week (homework / class test / discipline, counted separately).
--    The parent taps "I have seen"; if not within 2 days, the office calls and the owner sees it.
create table if not exists public.defaulter_repeats (
  id           uuid primary key default gen_random_uuid(),
  school_id    text not null,
  student_id   text not null,
  student_name text,
  class        text,
  section      text,
  kind_group   text not null check (kind_group in ('homework', 'test', 'discipline')),
  times        int  not null default 0,
  entry_ids    text[] not null default '{}',   -- the defaulter_entries counted in this message
  message      text not null,
  sent_at      timestamptz not null default now(),
  seen_at      timestamptz,                    -- the parent opened it
  ack_at       timestamptz,                    -- the parent tapped "I have seen"
  called_at    timestamptz,                    -- the office called the parent
  called_by    text
);
create index if not exists defaulter_repeats_school_sent on public.defaulter_repeats (school_id, sent_at desc);
create index if not exists defaulter_repeats_student on public.defaulter_repeats (school_id, student_id);
alter table public.defaulter_repeats enable row level security;

-- 2. Homework corrected? (Yes / No ticked by the teacher on the Daily Check Sheet)
create table if not exists public.homework_corrections (
  school_id  text not null,
  class      text not null,
  section    text not null default '',
  hw_date    date not null,      -- the day the homework was given
  subject    text not null,
  teacher    text,
  corrected  boolean,            -- null = not ticked
  checked_on date,               -- the sheet's day
  marked_by  text,
  updated_at timestamptz default now(),
  primary key (school_id, class, section, hw_date, subject)
);
alter table public.homework_corrections enable row level security;
