// 검수 끝난 사진으로 학습
//  body: { day, dog_ids?: string[], final?: true, curate_all?: true }
//  - 알림장 다운로드·다이얼독 저장 직후 (보통): 그날 그 아이 사진을 '직원 확인됨'으로 표시 + 새 모습 최대 3장 배움
//  - final: 그날 알림장 전송이 다 끝난 뒤 그날 사진 전체를 다시 훑어 새 모습을 최대 6장 더 배움 (이미 배운 날도 다시)
//  - curate_all: 모든 아이 대표 사진을 30장 이내로 정리만
//  대표 사진은 아이당 최대 30장. 넘으면 서로 가장 다른 모습(앞·옆·뒤·누운 모습·옷·미용)이 남도록 골라서
//  비슷한 사진끼리 겹친 것부터 뺌. 첫 프로필 사진은 항상 남김
// 인증: 직원 로그인 또는 x-worker-key

import { createClient } from "jsr:@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-worker-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PER_DOG = 3;        // 알림장 저장 때 아이당 새로 배우는 사진 수
const PER_DOG_FINAL = 6;  // 하루 마무리 학습 때 아이당 최대
const MAX_REFS = 30;      // 아이당 대표 사진 최대
const SAME = 0.93;        // 이보다 비슷하면 이미 아는 모습 → 건너뜀

type Item = { key: string; v: number[] | null; isNew: boolean; keep: boolean; bonus: number };
// 서로 가장 다른 사진들로 최대 MAX_REFS장 고르기 (멀리 떨어진 점부터 차례로)
//  keep: 반드시 남김(첫 프로필 사진·지문 없는 사진). 새 사진은 newLimit장까지만, 이미 아는 모습(SAME 이상)은 안 넣음
function pickDiverse(items: Item[], newLimit: number): Set<string> {
  const chosen: Item[] = items.filter((x) => x.keep);
  const pool = items.filter((x) => !x.keep);
  let newCount = 0;
  const maxSim = (x: Item) => {
    if (!x.v) return 0;
    let m = -1;
    for (const c of chosen) if (c.v) { const s = cos(c.v, x.v); if (s > m) m = s; }
    return m;
  };
  if (!chosen.some((c) => c.v) && pool.length) {
    // 시작점: 가장 그 아이다운 사진(다른 사진들과 평균적으로 가장 비슷한 것, 기존 사진 중에서)
    const base = pool.filter((x) => !x.isNew && x.v);
    const cand = base.length ? base : pool.filter((x) => x.v);
    let best: Item | null = null, bs = -9;
    for (const a of cand) {
      let t = 0;
      for (const b of cand) if (a !== b) t += cos(a.v!, b.v!);
      if (t > bs) { bs = t; best = a; }
    }
    if (best) { chosen.push(best); if (best.isNew) newCount++; pool.splice(pool.indexOf(best), 1); }
  }
  while (chosen.length < MAX_REFS && pool.length) {
    let best = -1, bs = -9;
    for (let i = 0; i < pool.length; i++) {
      const x = pool[i];
      if (x.isNew && newCount >= newLimit) continue;
      const m = maxSim(x);
      if (x.isNew && m >= SAME) continue;
      const score = (1 - m) + x.bonus;
      if (score > bs) { bs = score; best = i; }
    }
    if (best < 0) break;
    const x = pool.splice(best, 1)[0];
    chosen.push(x);
    if (x.isNew) newCount++;
  }
  // 30장이 안 되면 기존 사진은 모두 남김
  if (chosen.length < MAX_REFS) for (const x of pool) if (!x.isNew && chosen.length < MAX_REFS) chosen.push(x);
  return new Set(chosen.map((x) => x.key));
}

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
  // 정확히 90도 단위로 시계 방향 회전 (보간 없이 픽셀 그대로)
  let cur = await Image.decode(bytes);
  for (let k = 0; k < ((rot / 90) | 0) % 4; k++) {
    const W = cur.width, H = cur.height, out = new Image(H, W), s = cur.bitmap, d = out.bitmap;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4, di = (x * H + (H - 1 - y)) * 4;
      d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = s[si + 3];
    }
    cur = out;
  }
  return await cur.encodeJPEG(85);
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

  let body: { day?: string; dog_ids?: string[]; final?: boolean; curate_all?: boolean };
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const { data: dogRows } = await admin.from("dogs").select("id, auto, ref_path").eq("auto", false);
  const profile = new Map((dogRows ?? []).map((d) => [d.id, d.ref_path as string | null]));
  type Cand = { id: string; v: number[]; vec: unknown; thumb_path: string; rotation: number | null };

  // 아이 한 마리 대표 사진 정리 (+ 새 후보 사진 중 필요한 것만 추가)
  async function curate(dogId: string, cands: Cand[], newLimit: number) {
    const { data: refs } = await admin.from("dog_refs").select("id, path, vec, created_at").eq("dog_id", dogId);
    const prof = profile.get(dogId);
    const items: Item[] = [
      ...(refs ?? []).map((r) => {
        const v = parseVec(r.vec);
        return { key: "r:" + r.id, v, isNew: false, keep: r.path === prof || !v, bonus: r.path.includes("-learn-") ? 0.01 : 0.03 };
      }),
      ...cands.map((p) => ({ key: "p:" + p.id, v: p.v, isNew: true, keep: false, bonus: 0 })),
    ];
    const pick = pickDiverse(items, newLimit);
    let added = 0;
    for (const p of cands) {
      if (!pick.has("p:" + p.id)) continue;
      try {
        const { data: blob } = await admin.storage.from("photos").download(p.thumb_path);
        if (!blob) continue;
        const bytes = await rotatedJpeg(new Uint8Array(await blob.arrayBuffer()), p.rotation ?? 0);
        const path = `${dogId}-learn-${Date.now()}-${added}.jpg`;
        const up = await admin.storage.from("refs").upload(path, bytes, { contentType: "image/jpeg" });
        if (up.error) continue;
        await admin.from("dog_refs").insert({ dog_id: dogId, path, vec: p.vec });
        added++;
      } catch (e) { console.error("learn", dogId, String(e)); }
    }
    const drop = (refs ?? []).filter((r) => !pick.has("r:" + r.id));
    if (drop.length) {
      await admin.from("dog_refs").delete().in("id", drop.map((r) => r.id));
      const files = drop.map((r) => r.path).filter((x) => x !== prof);
      if (files.length) await admin.storage.from("refs").remove(files);
    }
    return { added, removed: drop.length };
  }

  if (body.curate_all) {
    let removed = 0;
    for (const d of dogRows ?? []) removed += (await curate(d.id, [], 0)).removed;
    return json({ ok: true, removed });
  }

  const day = String(body.day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "day 필요" }, 400);
  const final = body.final === true;

  // 그날 분류된 사진
  const photos: { id: string; dog_ids: string[]; vec: unknown; thumb_path: string; rotation: number | null; confidence: string | null; sharp: number | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await admin.from("photos").select("id, dog_ids, vec, thumb_path, rotation, confidence, sharp")
      .eq("day", day).eq("status", "done").eq("practice", false).range(from, from + 999);
    photos.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const named = new Set((dogRows ?? []).map((d) => d.id));
  const ids = Array.isArray(body.dog_ids) && body.dog_ids.length ? body.dog_ids.filter((x) => named.has(x))
    : [...new Set(photos.flatMap((p) => p.dog_ids ?? []))].filter((x) => named.has(x));
  if (!ids.length) return json({ ok: true, dogs: 0 });

  // 이미 학습한 아이는 확인 표시만 다시 (하루 마무리 학습은 다시 훑음)
  const { data: doneRows } = await admin.from("learned_days").select("dog_id").eq("day", day).in("dog_id", ids);
  const already = new Set(final ? [] : (doneRows ?? []).map((r) => r.dog_id));

  // 1) 확인됨 표시 (직원이 이 분류로 보냈으니 맞음)
  const idSet = new Set(ids);
  const toMark = photos.filter((p) => p.confidence !== "manual" && (p.dog_ids ?? []).some((d) => idSet.has(d)));
  for (let i = 0; i < toMark.length; i += 200) {
    await admin.from("photos").update({ confidence: "manual" }).in("id", toMark.slice(i, i + 200).map((p) => p.id));
  }

  // 2) 아이별 새 모습 학습 + 대표 사진 30장 이내로 정리
  let added = 0, removed = 0;
  const report: Record<string, number> = {};
  for (const dogId of ids) {
    if (already.has(dogId)) continue;
    const solo = photos.filter((p) => (p.dog_ids ?? []).length === 1 && p.dog_ids[0] === dogId)
      .map((p) => ({ ...p, v: parseVec(p.vec) })).filter((p) => p.v)
      .sort((a, b) => (b.sharp ?? 0) - (a.sharp ?? 0));
    // 후보: 혼자 나온 선명한 사진. 거의 같은 장면(연속 촬영)은 하나만
    const cands: Cand[] = [];
    for (const p of solo) {
      if (cands.length >= 40) break;
      if (cands.some((c) => cos(c.v, p.v!) >= 0.96)) continue;
      cands.push(p as Cand);
    }
    const r = await curate(dogId, cands, final ? PER_DOG_FINAL : PER_DOG);
    added += r.added; removed += r.removed;
    report[dogId] = r.added;
    const prev = final ? (await admin.from("learned_days").select("refs_added").eq("day", day).eq("dog_id", dogId).maybeSingle()).data?.refs_added ?? 0 : 0;
    await admin.from("learned_days").upsert({
      day, dog_id: dogId, refs_added: prev + r.added,
      photos_marked: toMark.filter((p) => p.dog_ids.includes(dogId)).length,
    }, { onConflict: "day,dog_id" });
  }
  return json({ ok: true, final, dogs: ids.length, marked: toMark.length, refs_added: added, refs_removed: removed, report });
});
