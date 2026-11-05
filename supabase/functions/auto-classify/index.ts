// 서버 자동 분류 작업자: 1분마다(pg_cron) 불려서 오늘 대기 중인 사진을 분류
// 원장님 컴퓨터가 꺼져 있어도 선생님이 올린 사진이 알아서 분류됨
// 출석 명단이 확정된 날만 동작 (명단 없이 전체와 비교하면 느리고 부정확)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ROT_MODEL = Deno.env.get("ROTATE_MODEL") ?? "claude-haiku-5-5";
const ROT_SYSTEM = `You check whether a photo from a dog daycare is upright. Phone photos are often saved sideways or upside down.
Decide how many degrees the photo must be turned CLOCKWISE so it looks natural: floor/grass/ground at the bottom,
walls and furniture vertical, people standing upright, dogs' legs pointing down to the floor, any text readable.
Dogs lying on their side or photographed from directly above can look odd: rely on the floor, furniture and people.
Reply with JSON only: {"rotate":0|90|180|270,"sure":true|false}`;

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
  const { data: pm } = await admin.from("app_settings").select("value").eq("name", "practice").maybeSingle();
  if (!count && pm?.value?.on !== true) return json({ skipped: "no roster" });

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
  // 회전 전용 확인: 분류된 사진 중 아직 회전을 따로 확인하지 않은 것 (직원이 돌린 사진은 제외)
  let rotated = 0, checked = 0;
  if (ANTHROPIC_KEY && Date.now() - started < 100_000) {
    const { data: rot } = await admin.from("photos").select("id, thumb_path, rotation")
      .eq("day", day).eq("status", "done").eq("rotation_checked", false).limit(30);
    const list = rot ?? [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(6, list.length) }, async () => {
      while (i < list.length && Date.now() - started < 130_000) {
        const p = list[i++];
        try {
          const { data: b } = await admin.storage.from("photos").download(p.thumb_path);
          if (!b) continue;
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({ model: ROT_MODEL, max_tokens: 1500, system: ROT_SYSTEM, messages: [{ role: "user", content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: encodeBase64(new Uint8Array(await b.arrayBuffer())) } },
              { type: "text", text: "How many degrees clockwise to make it upright?" },
            ] }] }),
          });
          if (!res.ok) continue;
          const out = await res.json();
          const text: string = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
          const m = text.match(/\{[\s\S]*\}/);
          const j = m ? JSON.parse(m[0]) : {};
          const r = [0, 90, 180, 270].includes(Number(j.rotate)) ? Number(j.rotate) : null;
          const upd: Record<string, unknown> = { rotation_checked: true };
          if (r !== null && j.sure !== false && r !== (p.rotation ?? 0)) { upd.rotation = r; rotated++; }
          // 다시 확인한 사이 직원이 돌렸으면 덮어쓰지 않음
          await admin.from("photos").update(upd).eq("id", p.id).eq("rotation_checked", false);
          checked++;
        } catch { /* 다음 번에 다시 */ }
      }
    }));
  }
  return json({ day, done, copied, failed, checked, rotated });
});
