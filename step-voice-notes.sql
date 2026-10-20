-- DigiSmart ERP — Voice Messages to parents (Oct 2026)
-- The office records a short voice message; parents of the chosen classes hear it
-- in the parent app. Every message is deleted automatically after its days are up
-- (homework at most 2 days, everything else at most 15 days).
-- Paste this whole file into Supabase → SQL Editor → Run. Safe to run more than once.

create table if not exists voice_notes (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  title text not null,
  kind text not null default 'general',          -- homework / exam / instructions / wishes / general
  target_classes jsonb not null default '["all"]'::jsonb,
  audio_url text not null,
  duration_sec int default 0,
  sender_name text,
  expires_on date not null,
  created_at timestamptz default now(),
  constraint voice_kind_ok check (kind in ('homework','exam','instructions','wishes','general')),
  constraint voice_days_ok check (expires_on <= (created_at at time zone 'Asia/Kolkata')::date + 15)
);
alter table voice_notes enable row level security;
-- No browser access: only the server (api/voice-notes, api/parent-data) reads or writes this table.
create index if not exists idx_voice_school on voice_notes(school_id);
create index if not exists idx_voice_expiry on voice_notes(expires_on);

-- Storage folder for the recordings (public links with random names, like the gallery),
-- each file at most 4 MB.
insert into storage.buckets (id, name, public, file_size_limit)
values ('voice-notes', 'voice-notes', true, 4194304)
on conflict (id) do nothing;
