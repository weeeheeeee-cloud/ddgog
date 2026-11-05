// 직원이 고쳐 준 분류 실수를 기억하고, 헷갈린 두 아이의 구분 포인트를 스스로 다시 정리
// body: { photo_id, wrong_id|null, right_id|null }  →  { ok, tips }
//  wrong_id 만: AI가 엉뚱한 아이에게 넣음 / right_id 만: AI가 못 알아본 아이를 직원이 직접 넣음 / 둘 다: A→B 정정

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("LESSON_MODEL") ?? "claude-sonnet-5-5";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `A dog daycare's photo sorter made a mistake that staff corrected by hand: it put the photo under a WRONG dog,
and/or it failed to recognize the CORRECT dog in it. You get the photo, and for each dog involved its reference photos,
existing tips and body-part features. Learn from it so the same mistake never happens again.
Find concrete physical details that separate these dogs (coat colour/shade, markings and their positions,
head shape seen from above or behind, ear shape/colour, tail length/curl, leg length, size, coat texture).
Never use clothes, collars or harnesses. Write in Korean. Keep what is still true in the existing tips/features.
For the CORRECT dog, also update its body-part features with what this photo newly shows (e.g. how it looks from
behind, from above, lying down, with a new grooming length), keeping the same line format.
Reply with JSON only:
{"wrong_tips":"<틀리게 고른 아이의 구분 포인트, 기존 내용 포함 160자 이내, 없으면 빈 문자열>",
 "right_tips":"<정답 아이의 구분 포인트, 기존 내용 포함 160자 이내, 정답이 없으면 빈 문자열>",
 "right_features":"<정답 아이의 부위별 특징 전체(기존 + 이 사진에서 새로 알게 된 점), 400자 이내, 없으면 빈 문자열>",
 "note":"<이 사진에서 정답 아이임을 알 수 있는 단서 60자 이내>"}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "",
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "로그인이 필요해요" }, 401);

  let photoId = "", wrongId: string | null = null, rightId: string | null = null;
  try { ({ photo_id: photoId, wrong_id: wrongId = null, right_id: rightId = null } = await req.json()); } catch { return json({ error: "bad request" }, 400); }
  if (!photoId || (!wrongId && !rightId) || wrongId === rightId) return json({ error: "bad request" }, 400);

  try {
    const { data: photo } = await supa.from("photos").select("thumb_path").eq("id", photoId).single();
    if (!photo) return json({ error: "no photo" }, 404);
    const { data: blob } = await supa.storage.from("photos").download(photo.thumb_path);
    if (!blob) return json({ error: "no photo" }, 404);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = `lesson-${crypto.randomUUID()}.jpg`;
    await supa.storage.from("refs").upload(path, bytes, { contentType: "image/jpeg" });
    const { data: lesson } = await supa.from("lessons").insert({ wrong_dog: wrongId, right_dog: rightId, path }).select("id").single();

    // 헷갈린 두 아이의 구분 포인트 다시 정리
    const ids = [wrongId, rightId].filter(Boolean) as string[];
    const { data: dogs } = await supa.from("dogs").select("id, name, note, tips, tips_ai, features, dog_refs(path, created_at)").in("id", ids);
    const W = dogs?.find((d) => d.id === wrongId), R = dogs?.find((d) => d.id === rightId);
    if ((!W && !R) || !ANTHROPIC_KEY) return json({ ok: true });
    const content: Record<string, unknown>[] = [{ type: "text", text: "The photo that was sorted wrongly:" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: encodeBase64(bytes) } }];
    const addDog = async (d: NonNullable<typeof W>, label: string) => {
      content.push({ type: "text", text: `${label}: ${d.name}${d.note ? ` — ${d.note}` : ""}\ntips: ${d.tips_ai ?? ""} ${d.tips ? `/ staff: ${d.tips}` : ""}\n${d.features ?? ""}` });
      const refs = (d.dog_refs ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5);
      for (const r of refs) {
        const { data } = await supa.storage.from("refs").download(r.path);
        if (data) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: encodeBase64(new Uint8Array(await data.arrayBuffer())) } });
      }
    };
    if (W) await addDog(W, "WRONG dog (the sorter chose it, but it is NOT in this photo)");
    else content.push({ type: "text", text: "The sorter did not recognize the correct dog in this photo at all." });
    if (R) await addDog(R, "CORRECT dog (staff added it by hand)");
    else content.push({ type: "text", text: "The correct dog is unknown (not this one)." });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: SYSTEM, messages: [{ role: "user", content }] }),
    });
    if (!res.ok) return json({ ok: true, tips: null });
    const out = await res.json();
    const text: string = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    let p: { wrong_tips?: string; right_tips?: string; right_features?: string; note?: string } = {};
    try { p = m ? JSON.parse(m[0]) : {}; } catch { /* 무시 */ }
    if (W && p.wrong_tips) await supa.from("dogs").update({ tips_ai: p.wrong_tips.slice(0, 200) }).eq("id", W.id);
    if (R) {
      const upd: Record<string, string> = {};
      if (p.right_tips) upd.tips_ai = p.right_tips.slice(0, 200);
      if (p.right_features && p.right_features.length > 40) upd.features = p.right_features.slice(0, 700);
      if (Object.keys(upd).length) await supa.from("dogs").update(upd).eq("id", R.id);
    }
    if (lesson && p.note) await supa.from("lessons").update({ note: p.note.slice(0, 120) }).eq("id", lesson.id);
    return json({ ok: true, tips: p });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
