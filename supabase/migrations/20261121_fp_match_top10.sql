-- fp_match 가 5마리까지만 돌려줘서, 분류(classify)가 '지문 상위 8마리'를 AI에게 보여 준다고 해 놓고
-- 실제로는 5마리만 보여 주고 있었음. 흰 아이들은 정답이 6~8등에 있는 경우가 있어 놓침 → 10마리까지
CREATE OR REPLACE FUNCTION public.fp_match(q vector, dogs uuid[], p_day date, p_photo uuid)
 RETURNS TABLE(dog_id uuid, sim real, n integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  with cand as (
    select r.dog_id, (1 - (r.vec <=> q)) as s from dog_refs r
     where r.dog_id = any(dogs) and r.vec is not null
    union all
    select p.dog_ids[1], (1 - (p.vec <=> q)) - case when p.confidence = 'manual' then 0 else 0.02 end
      from photos p
     where p.vec is not null and p.id <> p_photo and cardinality(p.dog_ids) = 1
       and p.dog_ids[1] = any(dogs) and p.status = 'done'
       and coalesce(p.confidence, '') in ('manual', 'high')
       and p.day > p_day - 60
  ), ranked as (
    select c.dog_id, c.s, row_number() over (partition by c.dog_id order by c.s desc) rn from cand c
  ), base as (
    select r.dog_id, avg(r.s) as s, count(*)::int as n from ranked r where rn <= 3 group by r.dog_id
  ), neg as (
    select l.wrong_dog as dog_id, max(1 - (l.vec <=> q)) as s from lessons l
     where l.vec is not null and l.wrong_dog = any(dogs) group by l.wrong_dog
  )
  select b.dog_id, (b.s - case when n2.s >= 0.9 then (n2.s - 0.85) else 0 end)::real as sim, b.n
    from base b left join neg n2 on n2.dog_id = b.dog_id
   order by 2 desc limit 10;
$function$;
