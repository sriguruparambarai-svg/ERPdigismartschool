-- DigiSmart ERP — Library (Nov 2026)
-- Run once in Supabase → SQL Editor → paste all → Run. Safe to run again.

create table if not exists public.library_books (
  id         uuid default gen_random_uuid() primary key,
  school_id  text not null,
  title      text not null,
  author     text,
  subject    text,                 -- Story, Science, Tamil, Reference …
  class_name text,                 -- optional: for which class
  copies     integer default 1,
  shelf      text,
  created_at timestamptz default now()
);
create index if not exists idx_library_books_school on public.library_books(school_id);
alter table public.library_books enable row level security;

create table if not exists public.library_loans (
  id             uuid default gen_random_uuid() primary key,
  school_id      text not null,
  book_id        uuid not null,
  book_title     text,
  borrower_type  text not null,    -- student | staff
  student_id     uuid,
  staff_id       uuid,
  borrower_name  text,
  borrower_class text,
  issued_on      date not null,
  due_on         date not null,
  returned_on    date,
  lost           boolean default false,
  note           text,
  done_by        text,
  created_at     timestamptz default now()
);
create index if not exists idx_library_loans_school on public.library_loans(school_id, returned_on);
create index if not exists idx_library_loans_student on public.library_loans(student_id);
alter table public.library_loans enable row level security;
