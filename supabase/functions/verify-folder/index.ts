// 폴더 다시 검수: 한 아이 폴더의 사진이 정말 그 아이인지 기준(대표 사진 + 직원이 고른 기준 사진)과 비교해서
// 너무 다른 사진은 빼고(맨 아래 '모르는 아이'로), 누운 사진은 바로 세움
// body: { dog_id, photo_ids: string[] (최대 8), anchor_ids?: string[] (직원이 고른 기준 사진, 최대 3) }
//   → { results: [{ id, same, rotate, note }] }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("VERIFY_MODEL") ?? "claude-sonnet-5-5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `You check a folder of photos that should all show ONE specific dog at a dog daycare.
You get the dog's name, notes, distinguishing points and REFERENCE photos (these definitely show the dog;
"staff-chosen" ones were picked by staff from today's photos, so the dog looks exactly like that today:
same grooming, same clothes). Then numbered photos from the folder.
For each numbered photo decide:
- "same": true if THIS dog is properly shown in the photo (main subject, or clearly visible with its face).
  false if the dog in the photo is a DIFFERENT dog (different coat colour/shade, size, build, head shape,
  ears, tail, grooming), or this dog is not properly visible at all. Look-alike dogs of the same breed come
  every day, so compare the specific details, not just breed and colour. When it is a different dog, say so.
  If the dog is only partly visible but everything visible fits, keep it (true).
- "rotate": degrees the photo must be turned CLOCKWISE to stand upright (floor at the bottom). 0 if upright.
Reply with JSON only: {"results":[{"n":<photo number>,"same":true|false,"rotate":0|90|180|270,"note":"<한국어 20자 이내>"}]}`;

async function b64(supa: ReturnType<typeof createClient>, bucket: string, path: string) {
  const { data } = await supa.storage.from(bucket).download(path);
  return data ? encodeBase64(new Uint8Array(await data.arrayBuffer())) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "",
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "로그인이 필요해요" }, 401);

  let body: { dog_id?: string; photo_ids?: string[]; anchor_ids?: string[] };
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const ids = (body.photo_ids ?? []).slice(0, 8);
  if (!body.dog_id || !ids.length) return json({ error: "dog_id and photo_ids required" }, 400);

  const { data: dog } = await supa.from("dogs").select("id, name, note, tips, tips_ai, features, dog_refs(path, created_at)").eq("id", body.dog_id).single();
  if (!dog) return json({ error: "no dog" }, 404);
  const { data: photos } = await supa.from("photos").select("id, thumb_path").in("id", ids);
  const { data: anchors } = (body.anchor_ids ?? []).length
    ? await supa.from("photos").select("id, thumb_path").in("id", (body.anchor_ids ?? []).slice(0, 3))
    : { data: [] as { id: string; thumb_path: string }[] };

  const refs = (dog.dog_refs ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const k = anchors?.length ? 6 : 8;
  const pick = refs.length <= k ? refs : Array.from({ length: k }, (_, i) => refs[Math.floor((i * refs.length) / k)]);

  const content: Record<string, unknown>[] = [];
  const tips = [dog.tips, dog.tips_ai].filter(Boolean).join(" / ");
  content.push({ type: "text", text: `Dog: ${dog.name}${dog.note ? ` — ${dog.note}` : ""}${tips ? `\n구분: ${tips}` : ""}${dog.features ? `\n부위별 특징:\n${dog.features}` : ""}\nReference photos:` });
  for (const r of pick) {
    const d = await b64(supa, "refs", r.path);
    if (d) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: d } });
  }
  for (const a of anchors ?? []) {
    const d = await b64(supa, "photos", a.thumb_path);
    if (!d) continue;
    content.push({ type: "text", text: "Staff-chosen reference from today (this IS the dog, today's look):" });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: d } });
  }
  content.push({ type: "text", text: "Folder photos to check:" });
  const order: string[] = [];
  for (const id of ids) {
    const p = (photos ?? []).find((x) => x.id === id);
    if (!p) continue;
    const d = await b64(supa, "photos", p.thumb_path);
    if (!d) continue;
    order.push(id);
    content.push({ type: "text", text: `Photo ${order.length}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: d } });
  }
  if (!order.length) return json({ results: [] });

  let text = "";
  for (let t = 0; t < 4; t++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: SYSTEM, messages: [{ role: "user", content }] }),
    });
    if (res.status === 429 || res.status === 529 || res.status >= 500) { await new Promise((r) => setTimeout(r, 3000 * (t + 1))); continue; }
    if (!res.ok) return json({ error: `Claude API ${res.status}` }, 500);
    const out = await res.json();
    text = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    break;
  }
  if (!text) return json({ error: "busy", retryable: true }, 503);
  const m = text.match(/\{[\s\S]*\}/);
  let parsed: { results?: { n: number; same: boolean; rotate?: number; note?: string }[] } = {};
  try { parsed = m ? JSON.parse(m[0]) : {}; } catch { /* 빈 결과 */ }
  const results = (parsed.results ?? []).filter((r) => r.n >= 1 && r.n <= order.length).map((r) => ({
    id: order[r.n - 1],
    same: r.same !== false,
    rotate: [0, 90, 180, 270].includes(Number(r.rotate)) ? Number(r.rotate) : 0,
    note: typeof r.note === "string" ? r.note.slice(0, 60) : "",
  }));
  return json({ results });
});
