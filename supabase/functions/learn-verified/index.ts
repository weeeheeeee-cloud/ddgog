// 검수 끝난 사진으로 학습: 알림장 다운로드·다이얼독 임시저장이 끝나면 호출
//  body: { day, dog_ids?: string[] }  (dog_ids 없으면 그날 사진이 있는 모든 아이)
//  1) 그날 그 아이 사진을 '직원 확인됨(manual)'으로 → 지문 분류에서 그 아이 기준 사진으로 쓰임
//  2) 아이마다 혼자 나온 사진 중 기존 대표 사진과 다른 모습(옷·미용·각도)을 최대 3장 골라 대표 사진(학습)으로 추가
//  3) 학습 사진이 너무 많아지지 않게 아이당 최근 15장만 유지
// 인증: 직원 로그인 또는 x-worker-key(다이얼독 임시저장 서버에서 호출)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-worker-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PER_DOG = 3;        // 하루에 아이당 새로 배우는 사진 수
const KEEP_LEARN = 15;    // 아이당 학습 사진 최대
const SAME = 0.93;        // 이보다 비슷하면 이미 아는 모습 → 건너뜀

const parseVec = (v: unknown): number[] | null => {
  if (!v) return null;
  if (Array.isArray(v)) return v as number[];
  try { return JSON.parse(String(v)); } catch { return null; }
};
const cos = (a: number[], b: number[]) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / (Math.sqrt(x * y) || 1);
};

async function rotatedJpeg(bytes: Uint8Array, rot: number) {
  if (!rot) return bytes;
  const img = await Image.decode(bytes);
  img.rotate(rot); // 시계 방향
  return await img.encodeJPEG(85);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 인증
  const wk = req.headers.get("x-worker-key");
  if (wk) {
    const { data: k } = await admin.from("internal_keys").select("key").eq("name", "worker").single();
    if (!k || k.key !== wk) return json({ error: "forbidden" }, 403);
  } else {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
    if (!data?.user) return json({ error: "로그인이 필요해요" }, 401);
  }

  let body: { day?: string; dog_ids?: string[] };
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const day = String(body.day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "day 필요" }, 400);

  // 그날 분류된 사진
  const photos: { id: string; dog_ids: string[]; vec: unknown; thumb_path: string; rotation: number | null; confidence: string | null; sharp: number | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await admin.from("photos").select("id, dog_ids, vec, thumb_path, rotation, confidence, sharp")
      .eq("day", day).eq("status", "done").eq("practice", false).range(from, from + 999);
    photos.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const { data: dogs } = await admin.from("dogs").select("id, auto").eq("auto", false);
  const named = new Set((dogs ?? []).map((d) => d.id));
  let ids = Array.isArray(body.dog_ids) && body.dog_ids.length ? body.dog_ids.filter((x) => named.has(x))
    : [...new Set(photos.flatMap((p) => p.dog_ids ?? []))].filter((x) => named.has(x));
  if (!ids.length) return json({ ok: true, dogs: 0 });

  // 이미 학습한 아이는 확인 표시만 다시
  const { data: doneRows } = await admin.from("learned_days").select("dog_id").eq("day", day).in("dog_id", ids);
  const already = new Set((doneRows ?? []).map((r) => r.dog_id));

  // 1) 확인됨 표시 (혼자 나온 사진 + 여럿 나온 사진 모두: 직원이 이 분류로 보냈으니 맞음)
  const idSet = new Set(ids);
  const toMark = photos.filter((p) => p.confidence !== "manual" && (p.dog_ids ?? []).some((d) => idSet.has(d)));
  for (let i = 0; i < toMark.length; i += 200) {
    await admin.from("photos").update({ confidence: "manual" }).in("id", toMark.slice(i, i + 200).map((p) => p.id));
  }

  // 2) 아이별 새 모습 학습
  let added = 0;
  const report: Record<string, number> = {};
  for (const dogId of ids) {
    if (already.has(dogId)) continue;
    const solo = photos.filter((p) => (p.dog_ids ?? []).length === 1 && p.dog_ids[0] === dogId)
      .map((p) => ({ ...p, v: parseVec(p.vec) })).filter((p) => p.v)
      .sort((a, b) => (b.sharp ?? 0) - (a.sharp ?? 0));
    const { data: refs } = await admin.from("dog_refs").select("id, path, vec, created_at").eq("dog_id", dogId);
    const known = (refs ?? []).map((r) => parseVec(r.vec)).filter(Boolean) as number[][];
    let n = 0;
    for (const p of solo) {
      if (n >= PER_DOG) break;
      if (known.some((k) => cos(k, p.v!) >= SAME)) continue;
      try {
        const { data: blob } = await admin.storage.from("photos").download(p.thumb_path);
        if (!blob) continue;
        const bytes = await rotatedJpeg(new Uint8Array(await blob.arrayBuffer()), p.rotation ?? 0);
        const path = `${dogId}-learn-${Date.now()}-${n}.jpg`;
        const up = await admin.storage.from("refs").upload(path, bytes, { contentType: "image/jpeg" });
        if (up.error) continue;
        await admin.from("dog_refs").insert({ dog_id: dogId, path, vec: p.vec });
        known.push(p.v!);
        n++;
      } catch (e) { console.error("learn", dogId, String(e)); }
    }
    added += n;
    report[dogId] = n;
    // 3) 학습 사진은 최근 KEEP_LEARN 장만
    const { data: learnRefs } = await admin.from("dog_refs").select("id, path, created_at").eq("dog_id", dogId)
      .like("path", "%-learn-%").order("created_at", { ascending: false });
    const extra = (learnRefs ?? []).slice(KEEP_LEARN);
    if (extra.length) {
      await admin.from("dog_refs").delete().in("id", extra.map((r) => r.id));
      await admin.storage.from("refs").remove(extra.map((r) => r.path));
    }
    await admin.from("learned_days").upsert({
      day, dog_id: dogId, refs_added: n,
      photos_marked: toMark.filter((p) => p.dog_ids.includes(dogId)).length,
    }, { onConflict: "day,dog_id" });
  }
  return json({ ok: true, dogs: ids.length, marked: toMark.length, refs_added: added, report });
});
