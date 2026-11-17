-- DigiSmart ERP — Van delay / van update messages to the Parents App (Nov 2026)
-- Run once in Supabase → SQL Editor.
--
-- The office picks a route (and optionally only some stops) on the Transport page
-- and presses "Send to Parents App". Only the parents of children on that route /
-- those stops see the message in their app (for that day) and get a phone alert.
--
-- Locked table: no public policies, so only the server (api/bus-gps.js, service key)
-- can read or write it. Parents never read it straight from the database.

create table if not exists transport_messages (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  route_id uuid,
  route_name text,
  kind text default 'delay',            -- 'delay' or 'reached'
  stops jsonb default '[]'::jsonb,      -- empty = every stop on the route
  student_ids jsonb default '[]'::jsonb,
  message text,
  sent_by text,
  students_count int default 0,
  phones_reached int default 0,
  created_at timestamptz default now()
);
alter table transport_messages enable row level security;

create index if not exists transport_messages_school_time on transport_messages (school_id, created_at desc);
create index if not exists transport_messages_students on transport_messages using gin (student_ids);
