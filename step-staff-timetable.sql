-- DigiSmart ERP — Send to staff (Oct 2026)
-- Keeps the copy of the master timetable last SENT to teachers, so the principal can
-- edit and save the master freely; teachers' app shows only this sent copy.
-- Safe to run more than once.
alter table tt_master add column if not exists staff_grid jsonb;
alter table tt_master add column if not exists staff_classes jsonb;
alter table tt_master add column if not exists staff_sent_at timestamptz;
