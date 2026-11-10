// 출석 보드 사진에서 강아지 이름 읽기
// body: { images: base64 JPEG[] (또는 image 하나), known: string[] }  →  { names, unsure, hotel(H 표시), kinder(K 표시 = 유치원생), daycare(D 표시 = 데이케어 손님) }
// 보드 오른쪽 호텔링·데이케어 칸도 읽음. 같은 이름이 K 칸과 H/D 칸에 따로 있으면 다른 아이 → "몽이" + "몽이 데이"처럼 둘 다 넣음
// 출석 보드 사진뿐 아니라 다이얼독 등 앱의 알림장·예약 목록 캡처도 읽음

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

const SYSTEM = `You read images that list the dogs present today at a Korean dog daycare / dog hotel.
Each image is either a photo of a whiteboard or paper attendance list (usually handwritten Korean),
or a screenshot of a pet-care app (e.g. 다이얼독) showing today's 알림장 / reservations / check-ins.
There may be several images (e.g. scrolled screenshots); combine them and remove duplicates.
Lists can include extra notes (owner names, times, phone numbers, breeds, sections like 데이케어 / 호텔링 / 미용,
buttons and menu labels in app screenshots, checkmarks, arrows).
Read EVERY section of the board: the main daycare columns AND any separate area (often on the right, a different
colour, titled "Hotel"/"Hotering"/호텔링/데이) listing hotel or daycare guests. Do not skip any section.
Extract ONLY the dogs' names.
- Ignore section headers, times, dates, prices, owner names, phone numbers, breeds and other notes.
- In app screenshots, ignore UI text (tabs, buttons, menu items, status labels like 작성완료/미작성).
- Names in an app may be written with the breed or owner, e.g. "콩이(말티즈)" or "콩이 / 김OO" → just "콩이".
- If a list of known dog names is given and a handwritten word is plausibly one of them, use the known spelling.
- Keep each dog exactly once. BUT if the same name appears in two different sections with different marks
  (e.g. "몽이 K" in the main columns and "몽이 D" in the hotel/daycare area), they are DIFFERENT dogs: list both entries.
- Include EVERY dog on the list, hotel guests too, even when a name is not among the known names
  (new or one-off guests are common).
- Hotel guests (호텔링) are marked with an "H" (e.g. "H 콩이", "콩이(H)", "콩이 h", a circled H, or listed
  under an H / 호텔 section). Do NOT include the H in the name; give it the mark "H".
- Daycare (유치원) dogs are marked with a "K" (e.g. "K 콩이", "콩이(K)", "콩이 k", a circled K, or listed
  under a K / 유치원 section). Do NOT include the K in the name; give it the mark "K".
  A dog can have both K and H (a daycare dog staying at the hotel) on the same line: then give both marks.
- Day guests (시간제 데이케어 손님) are marked with a "D" (e.g. "몽이 D", "뭉치 D"), usually in the hotel area with
  check-in times like "12:00 입실". Do NOT include the D in the name.
- Staff often write a short breed before or after the name to tell same-name dogs apart
  (e.g. "말티푸 호두", "웰시 여름", "포메 구름", "비숑 하루", "꼬숑 두식", "쿠키 잭"). Put the name in "name" and that
  breed word in "breed" (keep it as written, e.g. "웰시", "포메", "잭"). Leave "breed" empty when none is written.
- Ignore free-form notes and walk-order lists written below the grid (e.g. "산책 1. 뭉치 제리…", "빵이뚱이 15시 퇴실준비"):
  those repeat dogs already listed; only read names from the name column of each section.
List the entries in the order they are written on the board: the main section column by column
(left column top to bottom, then the next column), then the hotel/daycare section top to bottom.
Reply with JSON only:
{"entries":[{"name":"<이름>","breed":"<적힌 견종 또는 빈칸>","marks":["K"|"H"|"D", ...],"section":"main"|"hotel"}, ...],"unsure":["<읽기 애매한 이름>", ...]}
"unsure" lists names (from entries) whose handwriting you were not sure about.`;

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

  let images: string[] = [], known: string[] = [];
  try {
    const body = await req.json();
    images = Array.isArray(body.images) ? body.images : body.image ? [body.image] : [];
    known = body.known ?? [];
  } catch {
    return json({ error: "bad request" }, 400);
  }
  images = images.filter(Boolean).slice(0, 10);
  if (!images.length) return json({ error: "사진이 없어요" }, 400);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          ...images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
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
  let parsed: { names?: unknown; unsure?: unknown; hotel?: unknown; kinder?: unknown; entries?: unknown } = {};
  try { parsed = m ? JSON.parse(m[0]) : {}; } catch { /* 아래에서 빈 값 */ }
  const clean = (a: unknown) =>
    [...new Set((Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter(Boolean))];
  // 이름 앞뒤에 붙은 H·K 표시 떼기 ("H 콩이", "콩이(K)", "K H 콩이")
  const strip = (n: string) => { let x = n; for (let i = 0; i < 3; i++) x = x.replace(/\s*\(?\s*[HhKk]\s*\)?\s*$|^\s*\(?[HhKk]\)?\s+/g, "").trim(); return x; };
  const stripD = (n: string) => n.replace(/\s*\(?\s*[Dd]\s*\)?\s*$|^\s*\(?[Dd]\)?\s+/g, "").trim();
  if (Array.isArray(parsed.entries)) {
    // 같은 이름이 K 칸과 H/D 칸에 따로 있으면 다른 아이: H/D 쪽 이름에 " 호텔링"/" 데이"를 붙여 따로 둠
    const ents = (parsed.entries as { name?: unknown; breed?: unknown; marks?: unknown }[]).map((e) => {
      const marks = (Array.isArray(e.marks) ? e.marks : []).map((m) => String(m).toUpperCase().trim()).filter((m) => ["K", "H", "D"].includes(m));
      return { name: stripD(strip(String(e.name ?? "").trim())), breed: String(e.breed ?? "").trim(), marks };
    }).filter((e) => e.name);
    // 보드 순서 그대로. 같은 이름이 둘이면 K(유치원생) 줄이 원래 이름을 갖고, H/D 손님 쪽에 "데이"·"호텔링"이 붙음
    const keyOf = (n: string) => n.replace(/\s+/g, "");
    const hasK = new Set(ents.filter((e) => e.marks.includes("K")).map((e) => keyOf(e.name)));
    const names: string[] = [], hotel: string[] = [], kinder: string[] = [], daycare: string[] = [];
    const seen = new Map<string, string[]>(); // 이름 → 이미 넣은 표시
    const sigs = new Set<string>();
    for (const e of ents) {
      let name = e.name;
      const key = keyOf(name);
      const prev = seen.get(key);
      // 같은 줄이 두 번 읽힌 것 (이름·견종·표시가 다 같음) → 버림. "웰시 여름 K"와 "포메 여름 K"는 다른 아이
      const sig = `${key}|${keyOf(e.breed)}|${e.marks.join()}`;
      if (sigs.has(sig)) continue;
      sigs.add(sig);
      const twin = !!prev || ents.filter((x) => keyOf(x.name) === key).length > 1;
      if (twin && !e.marks.includes("K") && hasK.has(key)) name = `${name} ${e.marks.includes("D") ? "데이" : e.marks.includes("H") ? "호텔링" : "2"}`;
      else if (e.breed) name = `${name} ${e.breed}`; // "웰시 여름" → "여름 웰시" (사이트가 견종으로 어느 여름인지 고름)
      seen.set(key, e.marks);
      names.push(name);
      if (e.marks.includes("K")) kinder.push(name);
      if (e.marks.includes("H")) hotel.push(name);
      if (e.marks.includes("D")) daycare.push(name);
    }
    return json({ names, unsure: clean(parsed.unsure).map(strip), hotel, kinder, daycare });
  }
  const names = clean(parsed.names).map(strip).filter(Boolean);
  const hotel = clean(parsed.hotel).map(strip).filter(Boolean);
  const kinder = clean(parsed.kinder).map(strip).filter(Boolean);
  return json({ names: [...new Set([...names, ...hotel, ...kinder])], unsure: clean(parsed.unsure), hotel: [...new Set(hotel)], kinder: [...new Set(kinder)], daycare: [] });
});
