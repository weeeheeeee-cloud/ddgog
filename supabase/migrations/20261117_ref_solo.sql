-- 대표 사진 독사진 점검 (ref-solo 함수가 dog_refs.dog_count 에 강아지 수를 적음)
alter table public.dog_refs add column if not exists dog_count smallint;
-- 지운 대표 사진 기록 (저장소 파일은 남겨 둠 → 되돌리려면 이 표에서 dog_refs 로 다시 넣으면 됨)
create table if not exists public.ref_trash (id uuid primary key, dog_id uuid, path text, reason text, removed_at timestamptz default now());
alter table public.ref_trash enable row level security;
