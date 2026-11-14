-- 픽드랍 기능 (이미 적용됨, 새 프로젝트에 설치할 때만 실행)
create table public.pd_dogs (
  id uuid primary key default gen_random_uuid(),
  name text not null, owner_name text, phone text, address text, note text,
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.pd_requests (
  dog_id uuid not null references public.pd_dogs(id) on delete cascade,
  week_start date not null,
  days smallint[] not null default '{}',
  memo text,
  day_added jsonb not null default '{}'::jsonb,
  day_removed jsonb not null default '{}'::jsonb,
  memo_changed_at timestamptz,
  by_staff boolean not null default false,
  first_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (dog_id, week_start)
);
create index pd_requests_week_idx on public.pd_requests (week_start);
create table public.pd_log (
  id bigint generated always as identity primary key,
  dog_id uuid not null references public.pd_dogs(id) on delete cascade,
  week_start date not null,
  added smallint[] not null default '{}', removed smallint[] not null default '{}',
  memo_changed boolean not null default false, by_staff boolean not null default false,
  created_at timestamptz not null default now()
);
create index pd_log_dog_idx on public.pd_log (dog_id);
create index pd_log_created_idx on public.pd_log (created_at desc);
create table public.push_subs (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh text not null, auth text not null,
  created_at timestamptz not null default now()
);
create index push_subs_user_idx on public.push_subs (user_id);
create table public.server_secrets (name text primary key, value text not null, created_at timestamptz not null default now());
alter table public.pd_dogs enable row level security;
alter table public.pd_requests enable row level security;
alter table public.pd_log enable row level security;
alter table public.push_subs enable row level security;
alter table public.server_secrets enable row level security;
create policy "staff all pd_dogs" on public.pd_dogs for all to authenticated using (true) with check (true);
create policy "staff read pd_requests" on public.pd_requests for select to authenticated using (true);
create policy "staff read pd_log" on public.pd_log for select to authenticated using (true);
create policy "own push_subs select" on public.push_subs for select to authenticated using (user_id = (select auth.uid()));
create policy "own push_subs insert" on public.push_subs for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own push_subs update" on public.push_subs for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own push_subs delete" on public.push_subs for delete to authenticated using (user_id = (select auth.uid()));
alter publication supabase_realtime add table public.pd_requests;

-- 사진 순서·대표 사진 (이미 적용됨)
create table public.photo_order (
  day date not null,
  dog_id uuid not null references public.dogs(id) on delete cascade,
  ids uuid[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (day, dog_id)
);
create index photo_order_dog_idx on public.photo_order (dog_id);
alter table public.photo_order enable row level security;
create policy "staff all photo_order" on public.photo_order for all to authenticated using (true) with check (true);

-- 견종은 이름 괄호 대신 따로 (이미 적용됨)
alter table public.dogs add column if not exists breed text;

-- 유치원 회원 (다이얼독 회원 명단, 북마크의 '회원 명단 가져오기'로 갱신)
create table if not exists public.kinder_members (
  id uuid primary key default gen_random_uuid(),
  dd_pet_id text unique, name text not null, breed text, birthday date, gender text, neutered text, weight numeric,
  owner_name text, phone text, address text, owners jsonb not null default '[]', dd_memo text, notes text,
  active boolean not null default true, dog_id uuid references public.dogs(id) on delete set null,
  synced_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.kinder_members enable row level security;
create policy "staff all kinder_members" on public.kinder_members for all to authenticated using (true) with check (true);

-- 고정 요일 (매주 같은 요일 아이: 신청 안 해도 이 요일로 들어감)
alter table public.pd_dogs add column if not exists fixed_days smallint[] not null default '{}';
