// 선생님 전용 업로드 링크 (로그인 없이 사진만 올림)
//  action "check": { token }                       → { ok, day }
//  action "sign":  { token, items: [{ id }] }       → { day, urls: [{ id, full, thumb }] }  (서명된 업로드 주소)
//  action "done":  { token, items: [{ id, taken_at, phash, sharp }] } → { added, skipped }
// upload_links 에 있는 켜진 토큰만 동작. 사진 보기·삭제는 불가

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function hamming(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return 99;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const token = String(body.token ?? "");
  if (!token) return json({ error: "링크가 올바르지 않아요" }, 403);
  const { data: link } = await admin.from("upload_links").select("token, active").eq("token", token).maybeSingle();
  if (!link || !link.active) return json({ error: "사용할 수 없는 링크예요. 원장님께 새 링크를 받아 주세요." }, 403);
  const day = kstToday();

  if (body.action === "check") return json({ ok: true, day });

  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 60) as Record<string, unknown>[];
  if (!items.length || items.some((x) => !UUID.test(String(x.id)))) return json({ error: "bad request" }, 400);

  if (body.action === "sign") {
    const urls = [];
    for (const it of items) {
      const id = String(it.id);
      const full = await admin.storage.from("photos").createSignedUploadUrl(`${day}/${id}.jpg`);
      const thumb = await admin.storage.from("photos").createSignedUploadUrl(`${day}/thumb/${id}.jpg`);
      if (full.error || thumb.error) return json({ error: "업로드 준비 실패" }, 500);
      urls.push({ id, full: full.data.token, thumb: thumb.data.token, fullPath: `${day}/${id}.jpg`, thumbPath: `${day}/thumb/${id}.jpg` });
    }
    return json({ day, urls });
  }

  if (body.action === "done") {
    // 이미 올라온 똑같은 사진(찍은 시각 같고 이미지 거의 같음)은 건너뜀
    // 학습 모드가 켜져 있으면 학습용 사진으로 따로 모음
    const { data: pm } = await admin.from("app_settings").select("value").eq("name", "practice").maybeSingle();
    const practice = pm?.value?.on === true;
    const { data: existing } = await admin.from("photos").select("phash, taken_at").eq("day", day).eq("practice", practice);
    const seen = (existing ?? []).map((p) => ({ h: p.phash as string, t: p.taken_at ? +new Date(p.taken_at) : null }));
    let added = 0, skipped = 0;
    const rows = [];
    for (const it of items) {
      const id = String(it.id);
      const h = typeof it.phash === "string" ? it.phash : null;
      const t = it.taken_at ? +new Date(String(it.taken_at)) : null;
      if (h && seen.some((x) => x.t === t && hamming(x.h, h) <= 4)) {
        skipped++;
        await admin.storage.from("photos").remove([`${day}/${id}.jpg`, `${day}/thumb/${id}.jpg`]);
        continue;
      }
      seen.push({ h: h ?? "", t });
      rows.push({
        id, day, path: `${day}/${id}.jpg`, thumb_path: `${day}/thumb/${id}.jpg`,
        taken_at: it.taken_at ?? null, phash: h, sharp: typeof it.sharp === "number" ? it.sharp : null, source: "teacher", practice,
        vec: typeof it.vec === "string" && /^\[[-0-9.,e]+\]$/.test(it.vec) && it.vec.split(",").length === 384 ? it.vec : null,
      });
      added++;
    }
    if (rows.length) {
      const { error } = await admin.from("photos").insert(rows);
      if (error) return json({ error: "저장 실패" }, 500);
    }
    return json({ added, skipped });
  }
  return json({ error: "unknown action" }, 400);
});
