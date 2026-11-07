// 호텔링 상담지 사진 → 항목별 정보 (로그인한 직원만)
//  { images: [base64 jpeg, ...] } → { form: { owner_name, phone, address, visit_source, consult_date, pets: [...],
//      check_in, in_time, check_out, out_time, health, behavior, requests, vaccines: {...} } }
// 읽지 못하거나 확실하지 않은 칸은 null 로 둠 (지어내지 않음)

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("HOTEL_FORM_MODEL") ?? "claude-sonnet-5-5";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `You read a Korean dog hotel/daycare intake form ("[댕겨올개] 호텔 / 데이케어 입실 상담지") filled in by hand.
The printed form has these fields:
- 보호자명 (owner name), 연락처 (phone), 주소 (address)
- For up to 3 dogs in columns 1, 2, 3: 반려견 명 (name), 견종 (breed), 성별 checkboxes "M", "F", "중성화" (neutered),
  나이 "( 살) 년 월" (age in years and/or birth year+month), 몸무게 "kg" (weight)
- 입·퇴실 날짜 (check-in / check-out dates, often written like "11/13~11/15"), 방문 경로 (how they found us),
  입실 시간 (check-in time), 퇴실 시간 (check-out time)
- 건강, 특이 사항 (health notes), 행동 특이 사항 (behavior notes), 보호자 요청 사항 (owner requests)
- 예방접종 현황 checkboxes: 항체검사, 코로나장염, 광견병, 종합접종, 켄넬코프(기관지염), 신종 인플루엔자, and 접종병원 / 접종시기 (text)
- bottom: 년 월 일 (the date the form was written)
Several photos may show different parts or pages of the SAME form. Combine them.

Rules:
- Copy handwriting exactly as written (Korean). Do not translate, summarize or "fix" it.
- If a field is blank, unreadable or you are not sure, use null. NEVER guess or invent values.
- Checkbox: true only when clearly checked (✓, ✗, filled, circled). For sex use "M"/"F" or null.
  neutered: "yes" if 중성화 is checked, otherwise null.
- Dates as YYYY-MM-DD. If the year is not written, use the year given as TODAY (if that would put the date more than
  2 months in the past, use the next year). Times as HH:MM (24h; "오후 3시" → "15:00").
- age: keep as written, e.g. "3살", "2021년 5월", "3살 (2021년 5월)".
- weight: number in kg or null.
- phone: digits with dashes as written.
Reply with JSON only:
{"owner_name":..,"phone":..,"address":..,"visit_source":..,"consult_date":..,
 "pets":[{"name":..,"breed":..,"sex":..,"neutered":..,"age":..,"weight":..}],
 "check_in":..,"in_time":..,"check_out":..,"out_time":..,
 "health":..,"behavior":..,"requests":..,
 "vaccines":{"antibody":..,"corona":..,"rabies":..,"combo":..,"kennel":..,"flu":..,"hospital":..},
 "unsure":[<field names you could partly read but are not sure about>]}
Include only dogs whose column has something written.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!ANTHROPIC_KEY) return json({ error: "ANTHROPIC_API_KEY 가 없어요" }, 500);
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user) return json({ error: "로그인이 필요해요" }, 401);

  let images: string[] = [];
  try { ({ images = [] } = await req.json()); } catch { return json({ error: "bad request" }, 400); }
  images = (Array.isArray(images) ? images : []).filter((x) => typeof x === "string" && x.length > 100).slice(0, 6);
  if (!images.length) return json({ error: "사진이 없어요" }, 400);

  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const content: unknown[] = [{ type: "text", text: `TODAY: ${today}. ${images.length} photo(s) of the form:` }];
  images.forEach((b64, i) => {
    content.push({ type: "text", text: `photo ${i + 1}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64.replace(/^data:image\/\w+;base64,/, "") } });
  });

  for (let t = 0; t < 4; t++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, system: SYSTEM, messages: [{ role: "user", content }] }),
    });
    if (res.status === 429 || res.status === 529 || res.status >= 500) { await new Promise((r) => setTimeout(r, 3000 * (t + 1))); continue; }
    if (!res.ok) return json({ error: `AI ${res.status}: ${(await res.text()).slice(0, 200)}` }, 500);
    const out = await res.json();
    const text: string = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    try { return json({ form: m ? JSON.parse(m[0]) : {} }); }
    catch { return json({ error: "상담지를 읽지 못했어요. 더 밝고 반듯하게 찍어 주세요." }, 422); }
  }
  return json({ error: "AI가 바빠요. 잠시 후 다시 해 주세요." }, 503);
});
