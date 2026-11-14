-- DigiSmart ERP — Store & Stock (Nov 2026)
-- Run once in Supabase → SQL Editor → paste all → Run. Safe to run again.
-- Books, workbooks, notebooks, stationery, uniforms (sold to children, added to their fees)
-- and the school's own supplies (stock only). Only the ERP server reads and writes these.

create table if not exists public.store_items (
  id         uuid default gen_random_uuid() primary key,
  school_id  text not null,
  name       text not null,
  category   text not null default 'books',   -- books | notebooks | stationery | uniform | supplies
  size       text,                            -- uniforms: 28, 30, M, L …
  class_name text,                            -- optional: which class it is for
  price      numeric default 0,               -- selling price to the child
  cost       numeric default 0,               -- buying price (for stock value)
  stock      integer default 0,
  min_stock  integer default 0,               -- below this it shows "Low stock"
  for_sale   boolean default true,            -- false = school's own supplies
  active     boolean default true,
  created_at timestamptz default now()
);
create index if not exists idx_store_items_school on public.store_items(school_id);
alter table public.store_items enable row level security;

-- Every stock movement: received, given to a child, used by the school, corrected, returned
create table if not exists public.store_moves (
  id           uuid default gen_random_uuid() primary key,
  school_id    text not null,
  item_id      uuid not null,
  item_name    text,
  kind         text not null,                 -- in | issue | use | adjust | return
  qty          integer not null,              -- + into stock, − out of stock
  unit_price   numeric default 0,
  student_id   uuid,
  student_name text,
  sale_id      uuid,
  note         text,
  done_by      text,
  created_at   timestamptz default now()
);
create index if not exists idx_store_moves_school on public.store_moves(school_id, created_at desc);
alter table public.store_moves enable row level security;

-- Class-wise sets, e.g. "Class 3 full set": [{ item_id, qty }]
create table if not exists public.store_sets (
  id         uuid default gen_random_uuid() primary key,
  school_id  text not null,
  class_name text not null,
  name       text not null,
  items      jsonb not null default '[]',
  created_at timestamptz default now()
);
alter table public.store_sets enable row level security;

-- What a child took — becomes a fee item until paid
create table if not exists public.store_sales (
  id            uuid default gen_random_uuid() primary key,
  school_id     text not null,
  bill_no       text not null,
  student_id    uuid not null,
  student_name  text,
  student_class text,
  academic_year text,
  items         jsonb,                         -- [{ item_id, name, size, qty, price, amount }]
  total         numeric default 0,
  set_id        uuid,
  cancelled     boolean default false,
  done_by       text,
  created_at    timestamptz default now(),
  unique (school_id, bill_no)
);
create index if not exists idx_store_sales_student on public.store_sales(school_id, student_id);
alter table public.store_sales enable row level security;
