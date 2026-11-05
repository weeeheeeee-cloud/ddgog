// 서버 자동 분류 작업자: 1분마다(pg_cron) 불려서 오늘 대기 중인 사진을 분류
// 원장님 컴퓨터가 꺼져 있어도 선생님이 올린 사진이 알아서 분류됨
// 출석 명단이 확정된 날만 동작 (명단 없이 전체와 비교하면 느리고 부정확)

import { createClient } from "jsr:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

function hamming(a: string | null, b: string | null) {
  if (!a || !b || a.length !== b.length) return 99;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

Deno.serve(async (req) => {
  const admin = createClient(URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: k } = await admin.from("internal_keys").select("key").eq("name", "worker").single();
  if (!k || req.headers.get("x-worker-key") !== k.key) return json({ error: "forbidden" }, 403);

  const day = kstToday();
  const { count } = await admin.from("assignments").select("dog_id", { count: "exact", head: true }).eq("day", day);
  if (!count) return json({ skipped: "no roster" });

  const started = Date.now();
  let done = 0, copied = 0, failed = 0;
  // 약 100초 동안 8장씩 가져와서 처리
  while (Date.now() - started < 100_000) {
    const { data: batch } = await admin.rpc("claim_pending", { p_day: day, p_n: 8 });
    if (!batch?.length) break;
    // 연속으로 찍은 거의 같은 사진은 가장 선명한 1장만 판단하고 결과를 나머지에 적용
    const sorted = [...batch].sort((a, b) => String(a.taken_at ?? "").localeCompare(String(b.taken_at ?? "")));
    const groups: (typeof batch)[] = [];
    for (const p of sorted) {
      const g = groups[groups.length - 1];
      const last = g?.[g.length - 1];
      if (g && p.taken_at && last?.taken_at && Math.abs(+new Date(p.taken_at) - +new Date(last.taken_at)) <= 5000 &&
        hamming(g[0].phash, p.phash) <= 12) g.push(p);
      else groups.push([p]);
    }
    await Promise.all(groups.map(async (g) => {
      const rep = g.reduce((m, x) => ((x.sharp ?? 0) > (m.sharp ?? 0) ? x : m), g[0]);
      let ok = false;
      for (let t = 0; t < 3 && !ok; t++) {
        const r = await fetch(`${URL}/functions/v1/classify`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-worker-key": k.key, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
          body: JSON.stringify({ photo_id: rep.id }),
        });
        ok = r.ok;
        if (!ok) await new Promise((s) => setTimeout(s, 3000 * (t + 1)));
      }
      if (!ok) { failed++; await admin.from("photos").update({ status: "pending", claimed_at: null }).eq("id", rep.id).eq("status", "working"); }
      else done++;
      const sibs = g.filter((x) => x.id !== rep.id).map((x) => x.id);
      if (!sibs.length) return;
      if (ok) {
        const { data: r } = await admin.from("photos").select("dog_ids, status, confidence, rotation").eq("id", rep.id).single();
        if (r) {
          await admin.from("photos").update({ ...r, ai_note: "연속 사진: 바로 앞 사진과 같은 분류", claimed_at: null }).in("id", sibs);
          copied += sibs.length;
          return;
        }
      }
      await admin.from("photos").update({ status: "pending", claimed_at: null }).in("id", sibs);
    }));
  }
  return json({ day, done, copied, failed });
});
