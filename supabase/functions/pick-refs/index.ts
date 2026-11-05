// 지난 알림장 사진 묶음에서 대표 사진 고르기
// body: { name: string, images: base64 JPEG[] (최대 40), max?: number }
//   → { picks: number[], note: string, skipped: number }
// 알림장 사진에는 다른 아이·여러 마리·강아지 없는 사진이 섞여 있으므로,
// 가장 자주 나오는 아이(= 그 알림장의 주인공)가 혼자 또는 확실한 주인공인 사진만 다양한 각도로 고름

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("PICK_MODEL") ?? "claude-haiku-5-5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `You help build reference photos for a dog-recognition system at a Korean dog daycare.
You get numbered photos taken from past daily reports (알림장) written for ONE dog, whose name is given.
Most photos show that dog, but some may show other dogs, several dogs together, people, food, or no dog.
1. Work out which dog is the report's subject: the individual dog that appears most consistently.
2. Pick photos where THAT dog is clearly visible and is the only dog or clearly the main subject.
   Skip blurry photos, photos where it is tiny or mostly hidden, and photos dominated by other dogs.
3. From the good photos, choose up to MAX that together cover different views:
   face/front, side, back, full body, lying down, different outfits or grooming. Avoid near-duplicates.
4. Write a short Korean description of the dog's appearance to help tell it apart from similar dogs
   (견종 추정, 털색·무늬, 체구, 귀·꼬리, 눈에 띄는 특징). Do not mention clothes.
Reply with JSON only:
{"picks":[<photo numbers>],"note":"<한국어 40자 이내>","consistent":true|false}
"consistent": false if you could not find one dog that clearly appears in most photos.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!ANTHROPIC_KEY) return json({ error: "ANTHROPIC_API_KEY 가 설정되지 않았어요" }, 500);

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "",
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "로그인이 필요해요" }, 401);

  let name = "", images: string[] = [], max = 12;
  try {
    const body = await req.json();
    name = String(body.name ?? "").trim();
    images = (Array.isArray(body.images) ? body.images : []).filter(Boolean).slice(0, 40);
    max = Math.max(1, Math.min(20, Number(body.max) || 12));
  } catch {
    return json({ error: "bad request" }, 400);
  }
  if (!images.length) return json({ error: "사진이 없어요" }, 400);

  const content: Record<string, unknown>[] = [{ type: "text", text: `Dog's name: ${name || "(unknown)"}\nMAX = ${max}` }];
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
  let parsed: { picks?: unknown; note?: unknown; consistent?: unknown } = {};
  const m = text.match(/\{[\s\S]*\}/);
  try { parsed = m ? JSON.parse(m[0]) : {}; } catch {
    const p = text.match(/"picks"\s*:\s*\[([^\]]*)\]/);
    parsed = { picks: p ? p[1].split(",").map((x) => Number(x.trim())) : [] };
  }
  const picks = [...new Set((Array.isArray(parsed.picks) ? parsed.picks : [])
    .map(Number).filter((n) => n >= 1 && n <= images.length))].slice(0, max).map((n) => n - 1);
  return json({
    picks,
    note: typeof parsed.note === "string" ? parsed.note.slice(0, 80) : "",
    consistent: parsed.consistent !== false,
    skipped: images.length - picks.length,
  });
});
