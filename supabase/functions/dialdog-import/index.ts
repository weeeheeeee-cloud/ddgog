// 다이얼독 지난 알림장 → 명단·대표 사진 일괄 가져오기 (일회성)
// 다이얼독 파트너 페이지에서 실행되는 스크립트가 호출. IMPORT_TOKEN 이 맞아야만 동작.
//  action "pick": { name, images: base64[] (작은 썸네일) } → { picks, note, consistent }
//  action "save": { name, breed, color, note, images: base64[] (512px JPEG) } → { dogId, added, created }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { decodeBase64 } from "jsr:@std/encoding@1/base64";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("PICK_MODEL") ?? "claude-haiku-5-5";

// 다이얼독 페이지는 요청에 쿠키를 함께 보내므로 출처를 정확히 지정해야 함
let CORS: Record<string, string> = {};
const corsFor = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin === "https://dialodog.com" ? origin : "https://dialodog.com",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "content-type, x-import-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `You help build reference photos for a dog-recognition system at a Korean dog daycare.
You get numbered small photos taken from past daily reports (알림장) written for ONE dog (name, breed and color given).
Most photos show that dog, but some show other dogs, several dogs together, people, food, or no dog.
1. Work out which dog is the reports' subject: the individual dog that appears most consistently and fits the breed/color.
2. Pick photos where THAT dog is clearly visible and is the only dog or clearly the main subject.
   Skip blurry photos, photos where it is tiny or mostly hidden, and photos dominated by other dogs.
3. From the good photos, choose up to MAX that together cover different views:
   face/front, side, back, full body, lying down, different grooming. Avoid near-duplicates.
4. Write a short Korean description of the dog's appearance that helps tell it apart from similar dogs
   (털색·무늬, 체구, 귀·꼬리, 미용 스타일, 눈에 띄는 특징). Do not mention clothes.
Reply with JSON only:
{"picks":[<photo numbers>],"note":"<한국어 40자 이내>","consistent":true|false}`;

Deno.serve(async (req) => {
  CORS = corsFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // 일회성 토큰은 잠긴 테이블(import_tokens)에 보관: 서비스 키로만 읽을 수 있음
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const tok = req.headers.get("x-import-token") ?? "";
  const { data: okTok } = tok
    ? await admin.from("import_tokens").select("token").eq("token", tok).gt("expires_at", new Date().toISOString()).maybeSingle()
    : { data: null };
  if (!okTok) return json({ error: "forbidden" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const name = String(body.name ?? "").trim();
  const images = (Array.isArray(body.images) ? body.images : []).filter(Boolean).slice(0, 40) as string[];
  if (!name || !images.length) return json({ error: "name and images required" }, 400);

  // ---- 대표 사진 고르기
  if (body.action === "pick") {
    const max = Math.max(1, Math.min(20, Number(body.max) || 10));
    const content: Record<string, unknown>[] = [{
      type: "text",
      text: `Dog: ${name}${body.breed ? ` / breed: ${body.breed}` : ""}${body.color ? ` / color: ${body.color}` : ""}\nMAX = ${max}`,
    }];
    images.forEach((data, i) => {
      content.push({ type: "text", text: `Photo ${i + 1}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
    });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, system: SYSTEM, messages: [{ role: "user", content }] }),
    });
    if (res.status === 429 || res.status === 529 || res.status >= 500) return json({ error: "busy", retryable: true }, 503);
    if (!res.ok) return json({ error: `Claude API ${res.status}` }, 500);
    const out = await res.json();
    const text: string = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    let p: { picks?: unknown; note?: unknown; consistent?: unknown } = {};
    const m = text.match(/\{[\s\S]*\}/);
    try { p = m ? JSON.parse(m[0]) : {}; } catch {
      const x = text.match(/"picks"\s*:\s*\[([^\]]*)\]/);
      p = { picks: x ? x[1].split(",").map((v) => Number(v.trim())) : [] };
    }
    const picks = [...new Set((Array.isArray(p.picks) ? p.picks : []).map(Number)
      .filter((n) => n >= 1 && n <= images.length))].slice(0, max).map((n) => n - 1);
    return json({
      picks, note: typeof p.note === "string" ? p.note.slice(0, 80) : "", consistent: p.consistent !== false,
      ...(picks.length ? {} : { raw: text.slice(0, 400), stop: out.stop_reason }),
    });
  }

  // ---- 명단에 저장 + 대표 사진 업로드
  if (body.action === "save") {
    const supa = admin;
    const note = String(body.note ?? "").trim() || null;
    const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const { data: all } = await supa.from("dogs").select("id, name, note, ref_path, auto");
    let dog = (all ?? []).find((d) => !d.auto && norm(d.name) === norm(name));
    let created = false;
    if (!dog) {
      const { data, error } = await supa.from("dogs").insert({ name, note, auto: false, active: true })
        .select("id, name, note, ref_path, auto").single();
      if (error || !data) return json({ error: "dog insert failed" }, 500);
      dog = data;
      created = true;
    } else if (!dog.note && note) {
      await supa.from("dogs").update({ note }).eq("id", dog.id);
    }
    let added = 0;
    for (const b64 of images.slice(0, 20)) {
      const path = `${dog.id}-dd-${Date.now()}-${added}.jpg`;
      const up = await supa.storage.from("refs").upload(path, decodeBase64(b64), { contentType: "image/jpeg" });
      if (up.error) continue;
      await supa.from("dog_refs").insert({ dog_id: dog.id, path });
      if (!dog.ref_path) {
        await supa.from("dogs").update({ ref_path: path }).eq("id", dog.id);
        dog.ref_path = path;
      }
      added++;
    }
    return json({ dogId: dog.id, added, created });
  }

  return json({ error: "unknown action" }, 400);
});
