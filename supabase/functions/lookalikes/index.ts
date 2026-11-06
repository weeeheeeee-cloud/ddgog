// 닮은 아이들끼리 사진을 나란히 비교해서 구분 포인트(tips_ai) 만들기
//  action "groups":  명단 전체(이름+메모)를 보고 헷갈릴 만한 아이들끼리 묶음 → { groups: [[id,...], ...] }
//  action "compare": { ids: [...] } 그 묶음의 대표 사진을 나란히 보고 아이별 구분 포인트 저장
// import_tokens 의 토큰이 있어야 동작 (직원 화면에서는 쓰지 않는 관리용)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const GROUP_MODEL = Deno.env.get("LOOKALIKE_GROUP_MODEL") ?? "claude-sonnet-5-5";
const COMPARE_MODEL = Deno.env.get("LOOKALIKE_COMPARE_MODEL") ?? "claude-sonnet-5-5";

let CORS: Record<string, string> = {};
const corsFor = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin ?? "*",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "content-type, x-import-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function claude(model: string, system: string, content: unknown[], max = 6000) {
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
  throw new Error("Claude busy");
}
const parseJson = (text: string) => {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : {};
};

const GROUP_SYSTEM = `You organize a dog daycare's roster. Each line is: number. name — appearance note.
Group together dogs that a person (or a vision model) could CONFUSE in photos: same or similar breed type
and similar coat color/pattern/size (e.g. several white Maltese/Bichon/poodle types, several Australian
Shepherds, several cream Pomeranians, several black-and-tan dogs).
Rules: a dog appears in at most one group; groups have 2–8 dogs; dogs with nothing similar are left out.
Reply with JSON only: {"groups":[[<numbers>],[<numbers>],...]}`;

const COMPARE_SYSTEM = `You help a dog daycare tell apart look-alike dogs in photos.
You get several dogs that look similar. Each has a name, a short note, maybe staff tips, and reference photos.
Study the photos of ALL dogs side by side and find, for each dog, the concrete physical details that
separate it from the others in this group: tail length/shape/carriage, ear shape and color, face markings
(spots, blaze, mask), eye color, coat pattern and patch positions, leg/chest/paw markings, size and build,
coat texture, grooming style. Clothes, collars and harnesses change daily, so NEVER use them.
Staff tips are true; build on them.
For WHITE curly dogs (bichon, maltipoo, maltese, coton), "white and curly" separates nothing. Compare instead:
nose colour (black / brown / slightly pink), tear stains (none / light / brown), head volume and shape
(huge puffy round vs small or narrow), muzzle length, ear length and colour tinge, cream/apricot tinge on body,
body size and leg length, tail plume. Name the single most decisive point first.
Write each dog's tips in Korean (60자 이내), naming which look-alike(s) it should not be confused with,
e.g. "해랑·루나와 비슷하나 얼굴에 점박이. 레티는 꼬리 보통 길이". Only state what you can actually see.
If some photos of a dog seem to show a different dog, list their photo numbers in "suspect".
Reply with JSON only: {"dogs":[{"n":<dog number>,"tips":"<한국어>","suspect":[<photo numbers>]}]}`;

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

  try {
    if (body.action === "groups") {
      const { data: dogs } = await admin.from("dogs").select("id, name, note, tips")
        .eq("active", true).eq("auto", false).order("name");
      const list = dogs ?? [];
      const lines = list.map((d, i) => `${i + 1}. ${d.name} — ${[d.note, d.tips].filter(Boolean).join(" / ") || "(메모 없음)"}`).join("\n");
      const text = await claude(GROUP_MODEL, GROUP_SYSTEM, [{ type: "text", text: lines }], 8000);
      const groups = (parseJson(text).groups ?? []) as number[][];
      const seen = new Set<string>();
      const out = groups.map((g) => g.map((n) => list[n - 1]?.id).filter((id) => id && !seen.has(id) && seen.add(id)))
        .filter((g) => g.length >= 2);
      return json({ groups: out, names: out.map((g) => g.map((id) => list.find((d) => d.id === id)!.name)) });
    }

    if (body.action === "compare") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 10) as string[];
      if (ids.length < 2) return json({ error: "need 2+ ids" }, 400);
      const { data: dogs } = await admin.from("dogs")
        .select("id, name, note, tips, ref_path, dog_refs(id, path, created_at)").in("id", ids);
      const list = (dogs ?? []).map((d) => {
        const refs = (d.dog_refs ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at));
        const per = ids.length <= 4 ? 5 : ids.length <= 6 ? 4 : 3;
        const pick = refs.length <= per ? refs : Array.from({ length: per }, (_, i) => refs[Math.floor((i * refs.length) / per)]);
        return { ...d, pick };
      });
      const content: Record<string, unknown>[] = [];
      let photoNo = 0;
      const photoMap: Record<number, string> = {};
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        content.push({ type: "text", text: `Dog ${i + 1}: ${d.name}${d.note ? ` — ${d.note}` : ""}${d.tips ? ` | staff tips: ${d.tips}` : ""}` });
        for (const r of d.pick) {
          const { data } = await admin.storage.from("refs").download(r.path);
          if (!data) continue;
          photoNo++;
          photoMap[photoNo] = r.id;
          content.push({ type: "text", text: `photo ${photoNo} (dog ${i + 1})` });
          content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: encodeBase64(new Uint8Array(await data.arrayBuffer())) } });
        }
      }
      const text = await claude(COMPARE_MODEL, COMPARE_SYSTEM, content, 6000);
      const res = (parseJson(text).dogs ?? []) as { n: number; tips: string; suspect?: number[] }[];
      const saved: { name: string; tips: string; suspect: number }[] = [];
      for (const r of res) {
        const d = list[r.n - 1];
        if (!d || typeof r.tips !== "string") continue;
        await admin.from("dogs").update({ tips_ai: r.tips.slice(0, 160) }).eq("id", d.id);
        saved.push({ name: d.name, tips: r.tips, suspect: (r.suspect ?? []).length });
      }
      return json({ saved });
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
  return json({ error: "unknown action" }, 400);
});
