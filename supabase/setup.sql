-- 댕겨올개 사진 분류 — Supabase 초기 설정
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run 하세요. (한 번만)

create extension if not exists pgcrypto;

-- 선생님
create table if not exists public.teachers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

-- 강아지 명단 (기준 사진 1장 + 특징 메모)
create table if not exists public.dogs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  note text,                 -- 견종·털색·특징 (분류 힌트)
  ref_path text,             -- refs 버킷 안의 기준 사진 경로
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 날짜별 담당 (알림장 분배)
create table if not exists public.assignments (
  day date not null,
  dog_id uuid not null references public.dogs(id) on delete cascade,
  teacher_id uuid references public.teachers(id) on delete set null,
  primary key (day, dog_id)
);

-- 업로드된 사진
create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  path text not null unique,          -- 원본(1600px) 경로
  thumb_path text not null,           -- 썸네일(640px) 경로
  uploaded_by uuid default auth.uid(),
  status text not null default 'pending'
    check (status in ('pending','done','review','error')),
  dog_ids uuid[] not null default '{}',
  confidence text,
  ai_note text,
  created_at timestamptz not null default now()
);
create index if not exists photos_day_idx on public.photos(day);
create index if not exists photos_dogs_idx on public.photos using gin(dog_ids);

-- 로그인한 직원만 접근
alter table public.teachers    enable row level security;
alter table public.dogs        enable row level security;
alter table public.assignments enable row level security;
alter table public.photos      enable row level security;

drop policy if exists staff_all on public.teachers;
drop policy if exists staff_all on public.dogs;
drop policy if exists staff_all on public.assignments;
drop policy if exists staff_all on public.photos;
create policy staff_all on public.teachers    for all to authenticated using (true) with check (true);
create policy staff_all on public.dogs        for all to authenticated using (true) with check (true);
create policy staff_all on public.assignments for all to authenticated using (true) with check (true);
create policy staff_all on public.photos      for all to authenticated using (true) with check (true);

-- 사진 저장 버킷 (비공개)
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false), ('refs', 'refs', false)
on conflict (id) do nothing;

drop policy if exists staff_read   on storage.objects;
drop policy if exists staff_insert on storage.objects;
drop policy if exists staff_update on storage.objects;
drop policy if exists staff_delete on storage.objects;
create policy staff_read   on storage.objects for select to authenticated using (bucket_id in ('photos','refs'));
create policy staff_insert on storage.objects for insert to authenticated with check (bucket_id in ('photos','refs'));
create policy staff_update on storage.objects for update to authenticated using (bucket_id in ('photos','refs'));
create policy staff_delete on storage.objects for delete to authenticated using (bucket_id in ('photos','refs'));

-- 선생님 기본 명단 (관리 탭에서 수정 가능)
insert into public.teachers (name, sort) values
  ('에이미', 1), ('원익', 2), ('세훈', 3), ('신디', 4), ('하율', 5), ('형민', 6)
on conflict (name) do nothing;
