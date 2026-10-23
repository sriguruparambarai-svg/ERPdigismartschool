-- DigiSmart ERP — Discipline defaulters + Tamil messages (Oct 2026)
-- Run once in Supabase → SQL Editor → paste all → Run. Safe to run again.

-- 1. Discipline items (uniform, shoes, nails, hair, books, ID card) on each note
alter table public.defaulter_entries add column if not exists items text[];

-- 2. Allow the new 'discipline' kind (removes any old rule that only allowed the 4 homework/test kinds)
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.defaulter_entries'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute 'alter table public.defaulter_entries drop constraint ' || quote_ident(r.conname);
  end loop;
end $$;

alter table public.defaulter_entries
  add constraint defaulter_entries_kind_check
  check (kind in ('homework', 'test_not_written', 'test_absent', 'test_low_marks', 'discipline'));

-- 3. Tamil messages switch per school (super admin turns it on/off)
alter table public.schools add column if not exists has_tamil_msgs boolean default false;

-- 4. Switch it on for ARK
update public.schools set has_tamil_msgs = true where school_id = 'ark-global-school-mqp1gfuc';
