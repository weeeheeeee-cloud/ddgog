// 다이얼독 알림장 임시저장: 다이얼독 화면에서 실행되는 스크립트(dd-push.js)가 호출
//  action "list": { token, day? } → 그날 분류된 사진을 다이얼독 반려견(petId)별로 { day, dogs: [{ petId, name, photos: [{ id, url, rotation, pushed }] }] }
//  action "mark": { token, items: [{ photo_id, pet_id }] } → 다이얼독에 넣은 사진 기록 (다음에 같은 사진을 또 넣지 않게)
// 관리 탭에서 만든 dd_push_links 열쇠가 켜져 있어야만 동작

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "https://dialodog.com",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = String(body.token ?? "");
  const { data: link } = token
    ? await admin.from("dd_push_links").select("token, active").eq("token", token).maybeSingle()
    : { data: null };
  if (!link?.active) return json({ error: "버튼 열쇠가 맞지 않아요. 사진함 관리 탭에서 북마크를 다시 만들어 주세요." }, 403);
  await admin.from("dd_push_links").update({ last_used: new Date().toISOString() }).eq("token", token);

  try {
    if (body.action === "list") {
      const day = typeof body.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : kstToday();
      const { data: dogs } = await admin.from("dogs").select("id, name, dd_pet_id").not("dd_pet_id", "is", null);
      const byDog = new Map((dogs ?? []).map((d) => [d.id, d]));
      const photos: { id: string; path: string; rotation: number | null; dog_ids: string[]; taken_at: string | null; created_at: string }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data } = await admin.from("photos").select("id, path, rotation, dog_ids, taken_at, created_at")
          .eq("day", day).eq("status", "done").eq("practice", false).range(from, from + 999);
        photos.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      const { data: done } = await admin.from("dd_pushed").select("photo_id, pet_id").in("photo_id", photos.map((p) => p.id).slice(0, 5000));
      const pushed = new Set((done ?? []).map((x) => `${x.photo_id}|${x.pet_id}`));
      // 사진함에서 정한 순서(맨 앞 = 대표 사진)
      const { data: orders } = await admin.from("photo_order").select("dog_id, ids").eq("day", day);
      const orderOf = new Map((orders ?? []).map((o: { dog_id: string; ids: string[] }) => [o.dog_id, new Map((o.ids ?? []).map((id, i) => [id, i]))]));
      const out = new Map<string, { petId: string; name: string; dogId: string; photos: { id: string; path: string; rotation: number; pushed: boolean; t: string }[] }>();
      for (const p of photos) {
        for (const id of p.dog_ids ?? []) {
          const d = byDog.get(id);
          if (!d) continue;
          if (!out.has(d.dd_pet_id)) out.set(d.dd_pet_id, { petId: d.dd_pet_id, name: d.name, dogId: d.id, photos: [] });
          out.get(d.dd_pet_id)!.photos.push({ id: p.id, path: p.path, rotation: p.rotation ?? 0, pushed: pushed.has(`${p.id}|${d.dd_pet_id}`), t: p.taken_at ?? p.created_at });
        }
      }
      // 정한 순서(없으면 찍은 순서)대로, 주소는 1시간짜리
      const all = [...out.values()];
      const paths = [...new Set(all.flatMap((d) => d.photos.map((p) => p.path)))];
      const urls = new Map<string, string>();
      for (let i = 0; i < paths.length; i += 500) {
        const { data } = await admin.storage.from("photos").createSignedUrls(paths.slice(i, i + 500), 3600);
        (data ?? []).forEach((x) => x.signedUrl && x.path && urls.set(x.path, x.signedUrl));
      }
      return json({
        day,
        dogs: all.map((d) => ({
          petId: d.petId, name: d.name,
          photos: d.photos.sort((a, b) => {
            const r = orderOf.get(d.dogId);
            const ra = r?.get(a.id) ?? 1e9, rb = r?.get(b.id) ?? 1e9;
            return ra - rb || a.t.localeCompare(b.t);
          }).map((p) => ({ id: p.id, url: urls.get(p.path), rotation: p.rotation, pushed: p.pushed })).filter((p) => p.url),
        })),
      });
    }
    if (body.action === "mark") {
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 2000) as { photo_id: string; pet_id: string }[];
      if (items.length) await admin.from("dd_pushed").upsert(items.map((x) => ({ photo_id: x.photo_id, pet_id: String(x.pet_id) })), { ignoreDuplicates: true });
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
  return json({ error: "unknown action" }, 400);
});
