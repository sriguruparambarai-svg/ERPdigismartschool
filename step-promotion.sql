-- DigiSmart ERP — Year-end promotion + fee years (Nov 2026)
-- Run once in Supabase → SQL Editor → paste all → Run. Safe to run again.
-- Run this BEFORE the first promotion. (The ERP keeps working without it, but fee years
-- only start separating once it has run.)

-- 1. Every payment belongs to an academic year (e.g. '2026-27')
alter table public.fee_payments add column if not exists academic_year text;
create index if not exists idx_feepay_year on public.fee_payments(school_id, academic_year);
-- Payments already in the ERP all count for the current year, exactly as they do today,
-- so nobody's balance changes when this is run.
update public.fee_payments
   set academic_year = case
     when extract(month from now() at time zone 'Asia/Kolkata') >= 6
       then extract(year from now() at time zone 'Asia/Kolkata')::int::text || '-' ||
            lpad(((extract(year from now() at time zone 'Asia/Kolkata')::int + 1) % 100)::text, 2, '0')
     else (extract(year from now() at time zone 'Asia/Kolkata')::int - 1)::text || '-' ||
            lpad((extract(year from now() at time zone 'Asia/Kolkata')::int % 100)::text, 2, '0')
   end
 where academic_year is null;

-- 2. The school's current fee year (changes only when the school promotes — not by itself on 1 June)
alter table public.fee_settings add column if not exists current_year text;
update public.fee_settings
   set current_year = case
     when extract(month from now() at time zone 'Asia/Kolkata') >= 6
       then extract(year from now() at time zone 'Asia/Kolkata')::int::text || '-' ||
            lpad(((extract(year from now() at time zone 'Asia/Kolkata')::int + 1) % 100)::text, 2, '0')
     else (extract(year from now() at time zone 'Asia/Kolkata')::int - 1)::text || '-' ||
            lpad((extract(year from now() at time zone 'Asia/Kolkata')::int % 100)::text, 2, '0')
   end
 where current_year is null;

-- 3. Last year's unpaid fees carried into the new year
create table if not exists public.fee_arrears (
  id           uuid default gen_random_uuid() primary key,
  school_id    text not null,
  student_id   uuid not null,
  from_year    text not null,              -- the year the money was due, e.g. '2026-27'
  amount       numeric not null default 0,
  lines        jsonb,                      -- what was unpaid: [{ text, amount }]
  promotion_id uuid,
  created_at   timestamptz default now(),
  unique (school_id, student_id, from_year)
);
alter table public.fee_arrears enable row level security;

-- 4. Each promotion (so it runs once a year and can be undone the same day)
create table if not exists public.promotions (
  id          uuid default gen_random_uuid() primary key,
  school_id   text not null,
  from_year   text not null,
  to_year     text not null,
  changes     jsonb,                       -- each child: old class / year / status → new
  counts      jsonb,
  done_by     text,
  done_at     timestamptz default now(),
  undone_at   timestamptz,
  unique (school_id, from_year)
);
alter table public.promotions enable row level security;
