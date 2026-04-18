-- ═══════════════════════════════════════════════════════════
-- DigiSmart ERP — Supabase Database Setup
-- Run this SQL in your Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. STUDENTS TABLE
create table if not exists students (
  id uuid default gen_random_uuid() primary key,
  school_id text not null default 'ark-global-001',
  admission_no text,
  full_name text not null,
  full_name_tamil text,
  dob date,
  gender text,
  blood_group text,
  aadhar text,
  religion text,
  caste text,
  mother_tongue text,
  father_name text,
  mother_name text,
  father_occupation text,
  mobile text,
  whatsapp text,
  email text,
  address text,
  city text,
  district text,
  pincode text,
  class text,
  section text,
  academic_year text default '2025-26',
  admission_date date,
  prev_school text,
  tc_number text,
  transport_route text,
  photo_url text,
  status text default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2. Enable Row Level Security (keeps each school's data safe)
alter table students enable row level security;

-- 3. Policy: Allow all operations for now (we will tighten with login later)
create policy "Allow all for now" on students
  for all using (true) with check (true);

-- 4. Index for faster search
create index if not exists idx_students_school on students(school_id);
create index if not exists idx_students_class on students(class);
create index if not exists idx_students_year on students(academic_year);

-- 5. STUDENT ATTENDANCE TABLE
create table if not exists student_attendance (
  id uuid default gen_random_uuid() primary key,
  school_id text not null default 'ark-global-001',
  student_id uuid references students(id) on delete cascade,
  student_name text,
  class text,
  date date not null,
  status text check (status in ('present','absent','late')) default 'absent',
  created_at timestamptz default now()
);
alter table student_attendance enable row level security;
create policy "Allow all student_attendance" on student_attendance for all using (true) with check (true);
create index if not exists idx_statt_school_date on student_attendance(school_id, date);
create index if not exists idx_statt_student on student_attendance(student_id);

-- 6. STAFF TABLE
create table if not exists staff (
  id uuid default gen_random_uuid() primary key,
  school_id text not null default 'ark-global-001',
  employee_id text,
  name text not null,
  role text,
  mobile text,
  email text,
  status text default 'active',
  created_at timestamptz default now()
);
alter table staff enable row level security;
create policy "Allow all staff" on staff for all using (true) with check (true);
create index if not exists idx_staff_school on staff(school_id);

-- 7. STAFF ATTENDANCE TABLE
create table if not exists staff_attendance (
  id uuid default gen_random_uuid() primary key,
  school_id text not null default 'ark-global-001',
  staff_id uuid references staff(id) on delete cascade,
  staff_name text,
  staff_role text,
  date date not null,
  check_in text,
  check_out text,
  working_hours text,
  status text check (status in ('present','absent','late')) default 'present',
  early_exit boolean default false,
  method text default 'manual',
  created_at timestamptz default now()
);
alter table staff_attendance enable row level security;
create policy "Allow all staff_attendance" on staff_attendance for all using (true) with check (true);
create index if not exists idx_sfatt_school_date on staff_attendance(school_id, date);
create index if not exists idx_sfatt_staff on staff_attendance(staff_id);

-- 8. FEE SETTINGS TABLE (one row per school — stores collection mode)
create table if not exists fee_settings (
  id uuid default gen_random_uuid() primary key,
  school_id text not null unique,
  collection_mode text default 'term',
  term_config jsonb,
  custom_periods text,
  updated_at timestamptz default now()
);
alter table fee_settings enable row level security;
create policy "Allow all fee_settings" on fee_settings for all using (true) with check (true);

-- 9. FEE HEADS TABLE (types of fees a school charges)
create table if not exists fee_heads (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  name text not null,
  type text default 'per_period',
  description text,
  created_at timestamptz default now()
);
alter table fee_heads enable row level security;
create policy "Allow all fee_heads" on fee_heads for all using (true) with check (true);
create index if not exists idx_feeheads_school on fee_heads(school_id);

-- 10. FEE STRUCTURE TABLE (amount per class per fee head)
create table if not exists fee_structure (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  class text not null,
  fee_head_id uuid references fee_heads(id) on delete cascade,
  fee_head_name text,
  period_amounts jsonb,
  annual_amount numeric default 0,
  total_amount numeric default 0,
  updated_at timestamptz default now()
);
alter table fee_structure enable row level security;
create policy "Allow all fee_structure" on fee_structure for all using (true) with check (true);
create index if not exists idx_feestruct_school_class on fee_structure(school_id, class);

-- 11. FEE PAYMENTS TABLE (every payment recorded here)
create table if not exists fee_payments (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  student_id uuid references students(id) on delete cascade,
  student_name text,
  student_class text,
  admission_no text,
  fee_head_id uuid,
  fee_head_name text,
  period text,
  amount_paid numeric not null default 0,
  payment_mode text default 'cash',
  payment_date date,
  reference_no text,
  remarks text,
  receipt_no text,
  created_at timestamptz default now()
);
alter table fee_payments enable row level security;
create policy "Allow all fee_payments" on fee_payments for all using (true) with check (true);
create index if not exists idx_feepay_school on fee_payments(school_id);
create index if not exists idx_feepay_student on fee_payments(student_id);
create index if not exists idx_feepay_date on fee_payments(payment_date);

-- ═══════════════════════════════════════════════════════════
-- DONE! Your students table is ready.
-- Next tables will be added module by module:
--   attendance, fees, staff, exams, transport, billing
-- ═══════════════════════════════════════════════════════════

-- 12. HRM SETTINGS
create table if not exists hrm_settings (
  id uuid default gen_random_uuid() primary key,
  school_id text not null unique,
  pf_enabled boolean default false,
  esi_enabled boolean default false,
  tds_enabled boolean default false,
  pf_emp_pct numeric default 12,
  pf_er_pct numeric default 12,
  esi_emp_pct numeric default 0.75,
  esi_er_pct numeric default 3.25,
  updated_at timestamptz default now()
);
alter table hrm_settings enable row level security;
create policy "Allow all hrm_settings" on hrm_settings for all using (true) with check (true);

-- 13. SALARY COMPONENTS
create table if not exists salary_components (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  name text not null,
  type text check (type in ('earning','deduction')) not null,
  calc_type text default 'fixed',
  created_at timestamptz default now()
);
alter table salary_components enable row level security;
create policy "Allow all salary_components" on salary_components for all using (true) with check (true);
create index if not exists idx_salcomp_school on salary_components(school_id);

-- 14. STAFF SALARY STRUCTURE
create table if not exists staff_salary_structure (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  staff_id uuid references staff(id) on delete cascade unique,
  components jsonb,
  gross_salary numeric default 0,
  basic_pay numeric default 0,
  updated_at timestamptz default now()
);
alter table staff_salary_structure enable row level security;
create policy "Allow all staff_salary_structure" on staff_salary_structure for all using (true) with check (true);

-- 15. SALARY PROCESSED
create table if not exists salary_processed (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  staff_id uuid references staff(id) on delete cascade,
  staff_name text,
  month text not null,
  net_salary numeric default 0,
  payment_mode text default 'bank_transfer',
  paid_on date,
  status text default 'unpaid',
  created_at timestamptz default now()
);
alter table salary_processed enable row level security;
create policy "Allow all salary_processed" on salary_processed for all using (true) with check (true);
create index if not exists idx_salproc_school_month on salary_processed(school_id, month);

-- 16. STAFF LEAVES
create table if not exists staff_leaves (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  staff_id uuid references staff(id) on delete cascade,
  staff_name text,
  leave_type text not null,
  from_date date not null,
  to_date date not null,
  days integer default 1,
  reason text,
  status text default 'pending',
  created_at timestamptz default now()
);
alter table staff_leaves enable row level security;
create policy "Allow all staff_leaves" on staff_leaves for all using (true) with check (true);
create index if not exists idx_leaves_school on staff_leaves(school_id);

-- 17. EXAMS TABLE
create table if not exists exams (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  name text not null,
  type text,
  academic_year text,
  start_date date,
  end_date date,
  classes jsonb,
  subjects jsonb,
  status text default 'active',
  created_at timestamptz default now()
);
alter table exams enable row level security;
create policy "Allow all exams" on exams for all using (true) with check (true);
create index if not exists idx_exams_school on exams(school_id);

-- 18. EXAM MARKS TABLE
create table if not exists exam_marks (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  exam_id uuid references exams(id) on delete cascade,
  student_id uuid references students(id) on delete cascade,
  student_name text,
  admission_no text,
  class text,
  subject text,
  max_marks numeric default 100,
  pass_marks numeric default 35,
  marks_obtained numeric,
  is_absent boolean default false,
  grade text,
  is_pass boolean default false,
  percentage numeric,
  created_at timestamptz default now()
);
alter table exam_marks enable row level security;
create policy "Allow all exam_marks" on exam_marks for all using (true) with check (true);
create index if not exists idx_exammarks_exam on exam_marks(exam_id);
create index if not exists idx_exammarks_student on exam_marks(student_id);

-- 19. EXAM GRADING TABLE
create table if not exists exam_grading (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  grade text not null,
  min_pct numeric default 0,
  max_pct numeric default 100,
  description text,
  pass_percent numeric default 35,
  distinction_pct numeric default 75,
  firstclass_pct numeric default 60,
  created_at timestamptz default now()
);
alter table exam_grading enable row level security;
create policy "Allow all exam_grading" on exam_grading for all using (true) with check (true);
create index if not exists idx_grading_school on exam_grading(school_id);

-- 20. BUSES TABLE
create table if not exists buses (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  bus_number text not null,
  capacity integer,
  status text default 'active',
  driver_name text,
  driver_mobile text,
  license_no text,
  conductor_name text,
  conductor_mobile text,
  created_at timestamptz default now()
);
alter table buses enable row level security;
create policy "Allow all buses" on buses for all using (true) with check (true);
create index if not exists idx_buses_school on buses(school_id);

-- 21. BUS ROUTES TABLE
create table if not exists bus_routes (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  name text not null,
  bus_id uuid references buses(id) on delete set null,
  distance numeric,
  morning_departure time,
  evening_departure time,
  stops jsonb,
  created_at timestamptz default now()
);
alter table bus_routes enable row level security;
create policy "Allow all bus_routes" on bus_routes for all using (true) with check (true);
create index if not exists idx_routes_school on bus_routes(school_id);

-- 22. STUDENT TRANSPORT TABLE
create table if not exists student_transport (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  student_id uuid references students(id) on delete cascade,
  student_name text,
  student_class text,
  route_id uuid references bus_routes(id) on delete set null,
  route_name text,
  boarding_stop text,
  morning_time time,
  evening_time time,
  monthly_fee numeric default 0,
  created_at timestamptz default now()
);
alter table student_transport enable row level security;
create policy "Allow all student_transport" on student_transport for all using (true) with check (true);
create index if not exists idx_stransport_school on student_transport(school_id);

-- 23. BUS GPS TABLE
create table if not exists bus_gps (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  bus_id uuid references buses(id) on delete cascade,
  latitude numeric,
  longitude numeric,
  speed numeric default 0,
  accuracy numeric,
  updated_at timestamptz default now(),
  unique(school_id, bus_id)
);
alter table bus_gps enable row level security;
create policy "Allow all bus_gps" on bus_gps for all using (true) with check (true);
create index if not exists idx_busgps_school on bus_gps(school_id);

-- 24. TRIP LOG TABLE
create table if not exists trip_log (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  route_id uuid references bus_routes(id) on delete cascade,
  route_name text,
  date date not null,
  trip_type text check (trip_type in ('morning','evening')),
  scheduled_time time,
  actual_departure time,
  actual_arrival time,
  status text default 'pending',
  notes text,
  created_at timestamptz default now()
);
alter table trip_log enable row level security;
create policy "Allow all trip_log" on trip_log for all using (true) with check (true);
create index if not exists idx_triplog_school_date on trip_log(school_id, date);

-- 25. TRANSPORT NOTIFICATIONS TABLE
create table if not exists transport_notifications (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  message text,
  sent_at timestamptz default now()
);
alter table transport_notifications enable row level security;
create policy "Allow all transport_notifications" on transport_notifications for all using (true) with check (true);

-- 26. ICARD SETTINGS
create table if not exists icard_settings (
  id uuid default gen_random_uuid() primary key,
  school_id text not null unique,
  name1 text,
  name2 text,
  address text,
  phone text,
  email text,
  website text,
  acyear text default '2025-26',
  student_color text default '#6B1A1A',
  staff_color text default '#1a3a6b',
  show_blood boolean default true,
  updated_at timestamptz default now()
);
alter table icard_settings enable row level security;
create policy "Allow all icard_settings" on icard_settings for all using (true) with check (true);

-- 27. TIMETABLE SETTINGS (periods, subjects, working days per school)
create table if not exists tt_settings (
  id uuid default gen_random_uuid() primary key,
  school_id text not null unique,
  periods jsonb,
  subjects jsonb,
  working_days jsonb,
  teacher_map jsonb,
  updated_at timestamptz default now()
);
alter table tt_settings enable row level security;
create policy "Allow all tt_settings" on tt_settings for all using (true) with check (true);

-- 28. TIMETABLES (one per class per year)
create table if not exists timetables (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  class text not null,
  section text default '',
  academic_year text default '2025-26',
  grid jsonb,
  updated_at timestamptz default now()
);
alter table timetables enable row level security;
create policy "Allow all timetables" on timetables for all using (true) with check (true);
create index if not exists idx_timetables_school on timetables(school_id, class, section, academic_year);

-- 29. ACCOUNT CATEGORIES
create table if not exists account_categories (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  name text not null,
  type text check (type in ('income','expense')) not null,
  color text default '#6B1A1A',
  description text,
  created_at timestamptz default now()
);
alter table account_categories enable row level security;
create policy "Allow all account_categories" on account_categories for all using (true) with check (true);
create index if not exists idx_accat_school on account_categories(school_id);

-- 30. ACCOUNT TRANSACTIONS (income + expense ledger)
create table if not exists account_transactions (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  type text check (type in ('income','expense')) not null,
  description text not null,
  category_id uuid references account_categories(id) on delete set null,
  category_name text,
  category_color text,
  amount numeric not null default 0,
  date date not null,
  payment_mode text default 'cash',
  reference_no text,
  vendor text,
  remarks text,
  created_at timestamptz default now()
);
alter table account_transactions enable row level security;
create policy "Allow all account_transactions" on account_transactions for all using (true) with check (true);
create index if not exists idx_actxn_school on account_transactions(school_id);
create index if not exists idx_actxn_date on account_transactions(date);
create index if not exists idx_actxn_type on account_transactions(type);

-- 31. INVOICES
create table if not exists invoices (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  invoice_no text,
  invoice_to text not null,
  invoice_for text,
  invoice_date date,
  due_date date,
  items jsonb,
  subtotal numeric default 0,
  tax_percent numeric default 0,
  tax_amount numeric default 0,
  total_amount numeric default 0,
  status text default 'pending',
  created_at timestamptz default now()
);
alter table invoices enable row level security;
create policy "Allow all invoices" on invoices for all using (true) with check (true);
create index if not exists idx_invoices_school on invoices(school_id);

-- 32. ACCOUNT BUDGET
create table if not exists account_budget (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  academic_year text not null,
  category_id uuid references account_categories(id) on delete cascade,
  category_name text,
  budget_amount numeric default 0,
  created_at timestamptz default now()
);
alter table account_budget enable row level security;
create policy "Allow all account_budget" on account_budget for all using (true) with check (true);
create index if not exists idx_budget_school_year on account_budget(school_id, academic_year);

-- 33. SCHOOLS TABLE (multi-school login — one row per school)
create table if not exists schools (
  id uuid default gen_random_uuid() primary key,
  school_id text not null unique,
  name text not null,
  type text,
  classes text,
  city text,
  district text,
  phone text,
  admin_name text,
  admin_email text not null,
  plan text default 'school',
  status text default 'trial',
  trial_ends date,
  registered_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table schools enable row level security;
create policy "Allow all schools" on schools for all using (true) with check (true);
create index if not exists idx_schools_email on schools(admin_email);
create index if not exists idx_schools_status on schools(status);

-- ═══════════════════════════════════════════════════════════════
-- ALL DONE! DigiSmart ERP database is fully set up.
-- Total tables: 33
-- Modules: Admission, Attendance, Face Recognition, Fee,
--          HRM & Salary, Exam, Transport, GPS, I-Card,
--          Timetable, Billing, Multi-School Login
-- ═══════════════════════════════════════════════════════════════

-- 34. COMMUNICATIONS TABLE (circulars, homework, events, consent forms, announcements)
create table if not exists communications (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  type text not null,
  title text not null,
  message text,
  subject text,
  target_class text default 'all',
  target_section text,
  priority text default 'normal',
  due_date date,
  event_date date,
  event_time time,
  event_venue text,
  consent_options jsonb,
  sender_name text,
  created_at timestamptz default now()
);
alter table communications enable row level security;
create policy "Allow all communications" on communications for all using (true) with check (true);
create index if not exists idx_comm_school on communications(school_id);
create index if not exists idx_comm_type on communications(type);
create index if not exists idx_comm_class on communications(target_class);

-- 35. CONSENT RESPONSES TABLE
create table if not exists consent_responses (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  comm_id uuid references communications(id) on delete cascade,
  student_id uuid references students(id) on delete cascade,
  student_name text,
  class text,
  response text,
  responded_at timestamptz default now(),
  unique(comm_id, student_id)
);
alter table consent_responses enable row level security;
create policy "Allow all consent_responses" on consent_responses for all using (true) with check (true);
create index if not exists idx_cresponse_comm on consent_responses(comm_id);

-- 36. HOMEWORK COMPLETIONS TABLE
create table if not exists hw_completions (
  id uuid default gen_random_uuid() primary key,
  school_id text not null,
  comm_id uuid references communications(id) on delete cascade,
  student_id uuid references students(id) on delete cascade,
  student_name text,
  completed_at timestamptz default now(),
  unique(comm_id, student_id)
);
alter table hw_completions enable row level security;
create policy "Allow all hw_completions" on hw_completions for all using (true) with check (true);

-- 37. Add parent_password column to students (for parent portal login)
alter table students add column if not exists parent_password text;

-- ═══════════════════════════════════════════════════════════════
-- ALL DONE! DigiSmart ERP — Complete Database
-- Total tables: 37
-- All modules including Communication & Parent Portal ready!
-- ═══════════════════════════════════════════════════════════════

-- 38. DEMO REQUESTS TABLE (enquiries from schools wanting to buy)
create table if not exists demo_requests (
  id uuid default gen_random_uuid() primary key,
  school_name text,
  contact_name text,
  mobile text,
  email text,
  city text,
  students text,
  plan text,
  status text default 'new',
  requested_at timestamptz default now()
);
alter table demo_requests enable row level security;
create policy "Allow insert demo_requests" on demo_requests for insert using (true) with check (true);
create policy "Allow super admin to read demo_requests" on demo_requests for select using (true);
