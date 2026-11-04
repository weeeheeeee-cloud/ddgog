-- 자동 그룹(새 강아지) 기능 추가 — setup.sql 을 이미 실행한 경우 이것만 한 번 더 실행하세요.

alter table public.dogs add column if not exists auto boolean not null default false;

-- 강아지 그룹 합치기: src 의 사진·담당을 dst 로 옮기고 src 삭제
create or replace function public.merge_dogs(src uuid, dst uuid)
returns void
language sql
as $$
  update public.photos
     set dog_ids = array(select distinct unnest(array_replace(dog_ids, src, dst)))
   where src = any(dog_ids);
  delete from public.assignments a
   where a.dog_id = src
     and exists (select 1 from public.assignments b where b.day = a.day and b.dog_id = dst);
  update public.assignments set dog_id = dst where dog_id = src;
  delete from public.dogs where id = src;
$$;

grant execute on function public.merge_dogs(uuid, uuid) to authenticated;
