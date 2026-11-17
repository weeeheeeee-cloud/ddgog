-- 명단 밖 아이 확인: 분류가 끝난 사진(done)이 오늘 명단 아이보다 '명단에 없는 아이'와 훨씬 더 닮았으면
-- 억지로 명단 아이에게 넣지 않고 '모르는 아이' 칸(review)으로 보내고 누구와 닮았는지 적어 둠.
-- (예: 쿠키 잭러셀만 명단에 있고 쿠키 포메가 온 날 → 포메 사진이 연탄이·구름으로 들어가던 문제)
-- AI가 새로 판단을 적은 경우(ai_note가 바뀜)에만 봄: 직원이 옮긴 사진(ai_note 그대로이거나 '직원…'),
-- 직원이 직접 고친 사진(manual), 학습 모드, '특정 아이만 찾기' 사진은 건드리지 않음.
create or replace function public.offroster_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  inb real; outs real; who text;
begin
  if new.status <> 'done' or coalesce(new.confidence, '') = 'manual' or coalesce(new.practice, false)
     or new.vec is null or coalesce(array_length(new.find_dogs, 1), 0) > 0
     or new.ai_note is not distinct from old.ai_note or coalesce(new.ai_note, '') like '직원%' then
    return new;
  end if;
  if not exists (select 1 from assignments a where a.day = new.day) then return new; end if;
  select max(1 - (r.vec <=> new.vec)) into inb
    from dog_refs r join assignments a on a.dog_id = r.dog_id and a.day = new.day where r.vec is not null;
  select 1 - (r.vec <=> new.vec), d.name || coalesce(' ' || d.breed, '') into outs, who
    from dog_refs r join dogs d on d.id = r.dog_id
   where r.vec is not null and d.active and not d.auto
     and not exists (select 1 from assignments a where a.day = new.day and a.dog_id = d.id)
   order by r.vec <=> new.vec limit 1;
  if outs >= 0.80 and outs >= coalesce(inb, 0) + 0.05 and coalesce(inb, 0) < 0.85 then
    new.status := 'review';
    new.dog_ids := '{}';
    new.confidence := 'low';
    new.ai_note := format('명단에 없는 %s와(과) 가장 닮았어요 (%s). 오늘 왔으면 명단에 넣고 옮겨 주세요', who, round(outs::numeric, 2));
  end if;
  return new;
end $$;

drop trigger if exists photos_offroster_check on public.photos;
create trigger photos_offroster_check before update on public.photos
  for each row when (new.status = 'done' and old.status is distinct from 'done')
  execute function public.offroster_check();
