// 출석 보드 사진에서 강아지 이름 읽기
// body: { image: base64 JPEG, known: string[] }  →  { names: string[], unsure: string[] }

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("BOARD_MODEL") ?? "claude-sonnet-5-5"; // 손글씨라 하루 한 번은 더 정확한 모델로

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `You read a photo of a whiteboard (or paper) used for daily attendance at a Korean dog daycare / dog hotel.
It lists the names of the dogs present today, usually handwritten in Korean, sometimes with extra notes
(owner names, times, sections like 데이케어 / 호텔링 / 미용, checkmarks, arrows).
Extract ONLY the dogs' names.
- Ignore section headers, times, dates, prices, owner names, phone numbers and other notes.
- If a list of known dog names is given and a handwritten word is plausibly one of them, use the known spelling.
- Keep each name exactly once.
Reply with JSON only:
{"names":["<이름>", ...],"unsure":["<읽기 애매한 이름>", ...]}
"unsure" lists names (already included in "names") whose handwriting you were not sure about.`;

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

  let image = "", known: string[] = [];
  try {
    ({ image, known = [] } = await req.json());
  } catch {
    return json({ error: "bad request" }, 400);
  }
  if (!image) return json({ error: "사진이 없어요" }, 400);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: known.length ? `Known dog names: ${known.join(", ")}` : "No known dog names yet." },
        ],
      }],
    }),
  });
  if (res.status === 429 || res.status === 529 || res.status >= 500) return json({ error: "AI가 바빠요. 잠시 후 다시 시도해 주세요." }, 503);
  if (!res.ok) return json({ error: `Claude API ${res.status}` }, 500);

  const out = await res.json();
  const text: string = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  let parsed: { names?: unknown; unsure?: unknown } = {};
  try { parsed = m ? JSON.parse(m[0]) : {}; } catch { /* 아래에서 빈 값 */ }
  const clean = (a: unknown) =>
    [...new Set((Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter(Boolean))];
  return json({ names: clean(parsed.names), unsure: clean(parsed.unsure) });
});
