// 다이얼독 지난 알림장 → 명단·대표 사진·특징 일괄 학습 (관리용)
// 다이얼독 파트너 페이지에서 실행되는 스크립트가 호출. import_tokens 의 토큰이 맞아야만 동작.
//  action "pick": { name, breed, color, images: base64[] (120px 썸네일, 최대 80) } → { picks, consistent }
//  action "save": { name, breed, color, petId, images: base64[] (512px, 최대 18) }
//                 → 이전 다이얼독 대표 사진 교체 + 부위별 특징(features) 학습 → { dogId, added, created, features }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { decodeBase64 } from "jsr:@std/encoding@1/base64";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const PICK_MODEL = Deno.env.get("IMPORT_PICK_MODEL") ?? "claude-sonnet-5-5";
const FEATURE_MODEL = Deno.env.get("IMPORT_FEATURE_MODEL") ?? "claude-sonnet-5-5";

let CORS: Record<string, string> = {};
const corsFor = (_origin: string | null) => ({
  "Access-Control-Allow-Origin": "https://dialodog.com",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "content-type, x-import-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function claude(model: string, system: string, content: unknown[], max = 4000) {
  for (let t = 0; t < 4; t++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: max, system, messages: [{ role: "user", content }] }),
    });
    if (res.status === 429 || res.status === 529 || res.status >= 500) { await new Promise((r) => setTimeout(r, 4000 * (t + 1))); continue; }
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out = await res.json();
    return (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  }
  throw new Error("busy");
}
const parseJson = (text: string) => {
  const m = text.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : {}; } catch { return {}; }
};

const PICK_SYSTEM = `You build reference photos for recognizing ONE dog at a Korean dog daycare.
You get small numbered photos from past daily reports (알림장) written for that dog (name, breed, color given).
Most show that dog; some show other dogs, groups, people, food or no dog.
1. Work out which individual dog is the reports' subject: the one appearing most consistently and fitting breed/color.
2. Choose up to MAX photos of THAT dog where it is the only dog or clearly the main subject.
   Staff photos often show only part of a dog, and the system must recognize the dog from those too.
   So deliberately cover MANY VIEWS, not only faces:
   face/front, side profile, top of the head (photographed from above), back of the head,
   the back/등 from above, rear and tail, legs/paws, lying down, sitting, full body, different grooming lengths.
   A partial photo is GOOD if it clearly shows that dog's coat/pattern; skip blurry, tiny or ambiguous ones
   and photos where another dog dominates. Avoid near-duplicates.
Reply with JSON only: {"picks":[<photo numbers>],"consistent":true|false}`;

const FEATURE_SYSTEM = `You describe ONE dog so that a vision model can recognize it at a dog daycare
even when only PART of the dog is visible (top of head, back of head, back, tail, legs) and the dog wears clothes.
You get the dog's name, breed and reference photos (different days, angles and grooming).
Write in Korean, concrete and visual, only what you can actually see. Never use clothes, collars or harnesses.
Reply with JSON only:
{"note":"<한 줄 요약 40자 이내: 견종·털색·체구>",
 "features":"<부위별 특징, 각 항목 짧게, 줄바꿈으로 구분>\\n얼굴: …\\n정수리·머리통(위에서): …\\n뒤통수·귀: …\\n등·몸통(위/옆): …\\n꼬리·엉덩이: …\\n다리·발: …\\n체형·크기: …\\n털 길이·질감·미용: …"}
Mention patches/markings and their exact positions, colour gradients, ear shape and colour, tail length/curl/plume,
leg length, body length vs height. Keep the whole "features" under 400 Korean characters.`;

Deno.serve(async (req) => {
  CORS = corsFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const tok = req.headers.get("x-import-token") ?? "";
  const { data: okTok } = tok
    ? await admin.from("import_tokens").select("token").eq("token", tok).gt("expires_at", new Date().toISOString()).maybeSingle()
    : { data: null };
  if (!okTok) return json({ error: "forbidden" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const name = String(body.name ?? "").trim();
  const breed = String(body.breed ?? "").trim();
  const color = String(body.color ?? "").trim();

  try {
    // ---- 명단(이름) 목록
    if (body.action === "list") {
      const { data } = await admin.from("dogs").select("id, name, auto, active, dd_pet_id");
      return json({ dogs: data ?? [] });
    }

    const images = (Array.isArray(body.images) ? body.images : []).filter(Boolean) as string[];
    if (!name || !images.length) return json({ error: "name and images required" }, 400);

    // ---- 대표 사진 고르기 (작은 썸네일로)
    if (body.action === "pick") {
      const max = Math.max(1, Math.min(20, Number(body.max) || 16));
      const imgs = images.slice(0, 80);
      const content: Record<string, unknown>[] = [{
        type: "text", text: `Dog: ${name}${breed ? ` / breed: ${breed}` : ""}${color ? ` / color: ${color}` : ""}\nMAX = ${max}`,
      }];
      imgs.forEach((data, i) => {
        content.push({ type: "text", text: `Photo ${i + 1}:` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
      });
      const text = await claude(PICK_MODEL, PICK_SYSTEM, content, 4000);
      const p = parseJson(text);
      const picks = [...new Set((Array.isArray(p.picks) ? p.picks : []).map(Number)
        .filter((n: number) => n >= 1 && n <= imgs.length))].slice(0, max).map((n) => (n as number) - 1);
      return json({ picks, consistent: p.consistent !== false, ...(picks.length ? {} : { raw: text.slice(0, 300) }) });
    }

    // ---- 저장: 예전 다이얼독 대표 사진 교체 + 특징 학습
    if (body.action === "save") {
      const imgs = images.slice(0, 18);
      const petId = String(body.petId ?? "") || null;
      const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
      const { data: all } = await admin.from("dogs").select("id, name, note, ref_path, auto, dd_pet_id");
      const named = (all ?? []).filter((d) => !d.auto);
      const wanted = String(body.dbName ?? name);
      let dog = (petId && named.find((d) => d.dd_pet_id === petId)) ||
        named.find((d) => norm(d.name) === norm(wanted)) || null;
      let created = false;
      if (!dog) {
        const { data, error } = await admin.from("dogs").insert({ name: wanted, auto: false, active: true, dd_pet_id: petId })
          .select("id, name, note, ref_path, auto, dd_pet_id").single();
        if (error || !data) return json({ error: "dog insert failed" }, 500);
        dog = data;
        created = true;
      }

      // 특징 먼저 (사진이 좋으니 Sonnet 으로)
      const content: Record<string, unknown>[] = [{ type: "text", text: `Dog: ${name}${breed ? ` / breed: ${breed}` : ""}${color ? ` / color: ${color}` : ""}` }];
      imgs.forEach((data) => content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }));
      const f = parseJson(await claude(FEATURE_MODEL, FEATURE_SYSTEM, content, 4000));
      const features = typeof f.features === "string" ? f.features.slice(0, 700) : null;
      const note = typeof f.note === "string" ? f.note.slice(0, 80) : null;

      // 예전에 다이얼독에서 가져온 대표 사진(-dd-)만 지우고 교체. 직원이 올린 사진·학습 사진은 그대로
      const { data: old } = await admin.from("dog_refs").select("id, path").eq("dog_id", dog.id);
      const oldDd = (old ?? []).filter((r) => r.path.includes("-dd-"));
      let added = 0;
      const newPaths: string[] = [];
      for (const b64 of imgs) {
        const path = `${dog.id}-dd-${Date.now()}-${added}.jpg`;
        const up = await admin.storage.from("refs").upload(path, decodeBase64(b64), { contentType: "image/jpeg" });
        if (up.error) continue;
        await admin.from("dog_refs").insert({ dog_id: dog.id, path });
        newPaths.push(path);
        added++;
      }
      if (added >= 3 && oldDd.length) {
        await admin.from("dog_refs").delete().in("id", oldDd.map((r) => r.id));
        await admin.storage.from("refs").remove(oldDd.map((r) => r.path));
      }
      const upd: Record<string, unknown> = { dd_pet_id: petId };
      if (features) upd.features = features;
      if (note) upd.note = note;
      if (!dog.ref_path || (added >= 3 && oldDd.some((r) => r.path === dog!.ref_path))) upd.ref_path = newPaths[0] ?? dog.ref_path;
      await admin.from("dogs").update(upd).eq("id", dog.id);
      return json({ dogId: dog.id, name: dog.name, added, removed: added >= 3 ? oldDd.length : 0, created, features });
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
  return json({ error: "unknown action" }, 400);
});
