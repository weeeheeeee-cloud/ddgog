// DB 대표 사진 점검: 대표 사진마다 강아지가 몇 마리 나왔는지 세어 dog_refs.dog_count 에 적음
// (독사진이 아닌 대표 사진을 찾아 정리하려고). 형제견 아이는 건너뜀.
// body: { limit?: number }  (내부 작업자 키 x-worker-key 필요) → { checked, left }
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("REF_SOLO_MODEL") ?? "claude-haiku-5-5";
const SIBLINGS = ["비비모모", "코코지몽", "빵이뚱이", "칸비비", "버터도우", "뽀숑토리", "솔이별이", "하루모니",
  "승동복동", "사랑진주", "럭키벨라", "하몽테디", "푸&루 (포메,푸들)", "이클가리"];
const SYSTEM = `You get numbered photos from a dog daycare. For EACH photo count the dogs that are clearly visible:
a dog counts if its head or most of its body is visible and recognizable.
Do NOT count: tiny dogs far in the background, only a paw / tail / back edge cut off at the border, heavy blur, toys, pictures of dogs, people.
Reply with JSON only: {"r":[{"n":<photo number>,"dogs":<count>}]}`;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: k } = await admin.from("internal_keys").select("key").eq("name", "worker").single();
  if (!k || req.headers.get("x-worker-key") !== k.key) return json({ error: "forbidden" }, 403);
  const body = await req.json().catch(() => ({}));
  const limit = Math.min(64, Number(body.limit) || 48);
  const { data: dogs } = await admin.from("dogs").select("id, name").eq("auto", false);
  const skip = (dogs ?? []).filter((d) => SIBLINGS.includes(d.name)).map((d) => d.id);
  let q = admin.from("dog_refs").select("id, path, dog_id").is("dog_count", null).order("created_at").limit(limit);
  if (skip.length) q = q.not("dog_id", "in", `(${skip.join(",")})`);
  const { data: refs, error: qerr } = await q;
  if (qerr) return json({ error: qerr.message }, 500);
  const list = refs ?? [];
  const batches: typeof list[] = [];
  for (let i = 0; i < list.length; i += 8) batches.push(list.slice(i, i + 8));
  let checked = 0, lastTxt = "";
  await Promise.all(batches.map(async (b) => {
    const content: Record<string, unknown>[] = [];
    const ok: typeof b = [];
    for (const r of b) {
      const { data } = await admin.storage.from("refs").download(r.path);
      if (!data) { await admin.from("dog_refs").update({ dog_count: -1 }).eq("id", r.id); continue; }
      ok.push(r);
      content.push({ type: "text", text: `Photo ${ok.length}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: encodeBase64(new Uint8Array(await data.arrayBuffer())) } });
    }
    if (!ok.length) return;
    content.push({ type: "text", text: `Count the dogs in each of the ${ok.length} photos.` });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, system: SYSTEM, messages: [{ role: "user", content }] }),
    });
    if (!res.ok) { lastTxt = `${res.status} ${(await res.text()).slice(0, 200)}`; console.error(lastTxt); return; }
    const out = await res.json();
    const txt = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    // JSON이 조금 깨져도 읽히게: {"n":1,"dogs":2} 쌍만 뽑음
    const r = [...txt.matchAll(/"n"\s*:\s*"?(\d+)"?[^{}]*?"dogs"\s*:\s*"?(\d+)/g)].map((m) => ({ n: m[1], dogs: m[2] }));
    if (!r.length) { console.error("no parse", txt.slice(0, 300)); lastTxt = txt.slice(0, 300); }
    for (const x of r) {
      const ref = ok[Number(x.n) - 1];
      if (!ref || !Number.isFinite(Number(x.dogs))) continue;
      await admin.from("dog_refs").update({ dog_count: Math.max(0, Math.min(9, Math.round(Number(x.dogs)))) }).eq("id", ref.id);
      checked++;
    }
  }));
  let lq = admin.from("dog_refs").select("id", { count: "exact", head: true }).is("dog_count", null);
  if (skip.length) lq = lq.not("dog_id", "in", `(${skip.join(",")})`);
  const { count } = await lq;
  return json({ picked: list.length, checked, left: count, note: lastTxt || undefined });
});
