-- 유치원 회원 상담지 사진 (사진은 hotel-forms 버킷의 kinder/<member_id>/ 아래에 저장)
create table if not exists public.kinder_forms (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.kinder_members(id) on delete cascade,
  path text not null,
  created_at timestamptz not null default now()
);
create index if not exists kinder_forms_member_idx on public.kinder_forms(member_id);
alter table public.kinder_forms enable row level security;
create policy "staff all kinder_forms" on public.kinder_forms for all to authenticated using (true) with check (true);
