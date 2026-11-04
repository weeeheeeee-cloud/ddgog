// 댕겨올개 사진 분류 Edge Function
// 기준 사진(등록한 강아지 + AI가 자동으로 만든 "새 강아지" 그룹)과 새 사진을 Claude 에게 보내서
// 어떤 강아지인지 판별합니다. 처음 보는 강아지면 새 그룹을 자동으로 만듭니다.
// 필요한 Secret: ANTHROPIC_API_KEY  (선택: CLASSIFY_MODEL)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("CLASSIFY_MODEL") ?? "claude-haiku-5-5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM = `You identify individual dogs in photos taken at a dog daycare.
You get numbered reference photos (one per known dog, possibly none yet). Some dogs also have
"today's look": a photo of the same dog taken TODAY, showing what it looks like today.
Then you get ONE new photo, also taken today. Decide which known dogs appear in it.

How to recognize a dog — the face is NOT required. Use every clue together:
- Coat: color, pattern, patches and their positions, coat length and texture, grooming cut.
- Body: size, build, leg length, tail shape and how it is carried, ear shape and set.
- Clothes and accessories (outfit, harness, collar, bandana, hair clip): dogs wear the same
  ones all day, so a match with "today's look" is a STRONG clue. The older reference photo
  may show different clothes, so an outfit difference from it does not rule a dog out.
- A dog seen from the back or side, or with its face hidden, can still be matched when
  coat, body and clothes clearly fit one known dog and no other.
Many dogs look alike (e.g. several white Maltese). Only match when the specific dog is the same,
using the distinguishing details (clothes today, markings, size, cut) to tell them apart.

The photos are sent to each dog's owner, so decide who the photo is ABOUT.
- A MAIN dog is a subject of the photo: in focus, reasonably large, usually near the center.
  Dogs in the background, cut off at the edge, tiny or blurry are NOT main dogs.
- If two or three dogs share the frame equally (similar size, all in focus, all clearly shown,
  e.g. posing or playing together), they are ALL main dogs.

Reply with JSON only, no other text:
{"dogs":[<reference numbers of MAIN dogs>],"new_dog":true|false,"unknown_main":<number>,"confidence":"high"|"low","note":"<짧은 한국어 메모: 무엇으로 판단했는지>"}
- "dogs": the known dogs that are MAIN dogs in the new photo ([] if none).
- "unknown_main": how many MAIN dogs match none of the known dogs.
- "new_dog": true ONLY if the photo has exactly one MAIN dog, it matches none of the known dogs,
  and enough of it is visible (face, or clear body/coat/clothes) to recognize it again later.
  Then "dogs" must be [].
- "confidence": "high" when the clues clearly point to one dog. "low" if the dog is blurry or
  mostly hidden, if two known dogs fit about equally, or if it is unclear which dogs are main.`;

const refCache = new Map<string, string>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type Supa = ReturnType<typeof createClient>;

async function download(supa: Supa, bucket: string, path: string) {
  const { data, error } = await supa.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`download failed: ${bucket}/${path}`);
  return new Uint8Array(await data.arrayBuffer());
}

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

  let photoId: string;
  try {
    ({ photo_id: photoId } = await req.json());
  } catch {
    return json({ error: "bad request" }, 400);
  }

  const { data: photo, error: pErr } = await supa
    .from("photos").select("id, day, thumb_path").eq("id", photoId).single();
  if (pErr || !photo) return json({ error: "사진을 찾을 수 없어요" }, 404);

  // 후보: 그날 담당이 지정된 강아지 + 이름 안 붙은 자동 그룹. 담당 지정이 없으면 활성 강아지 전체
  const { data: assigned } = await supa.from("assignments").select("dog_id").eq("day", photo.day);
  let q = supa.from("dogs").select("id, name, note, ref_path")
    .eq("active", true).not("ref_path", "is", null).order("created_at");
  if (assigned && assigned.length) {
    q = q.or(`id.in.(${assigned.map((a) => a.dog_id).join(",")}),auto.eq.true`);
  }
  const { data: dogs } = await q;
  const refs = dogs ?? [];

  try {
    const content: Record<string, unknown>[] = [];
    if (refs.length) {
      content.push({ type: "text", text: "Reference dogs:" });
      for (let i = 0; i < refs.length; i++) {
        const d = refs[i];
        let b64 = refCache.get(d.ref_path!);
        if (!b64) {
          b64 = encodeBase64(await download(supa, "refs", d.ref_path!));
          refCache.set(d.ref_path!, b64);
        }
        content.push({ type: "text", text: `[${i + 1}] ${d.name}${d.note ? ` — ${d.note}` : ""}` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
      }
      content[content.length - 1].cache_control = { type: "ephemeral" };
    } else {
      content.push({ type: "text", text: "Reference dogs: none yet." });
    }

    // 오늘 모습: 오늘 이미 분류된 사진 중 강아지별 가장 최근 1장 (옷·미용 상태가 그날 그대로라 큰 단서)
    if (refs.length) {
      const { data: today } = await supa.from("photos")
        .select("id, thumb_path, dog_ids").eq("day", photo.day).eq("status", "done")
        .neq("id", photoId).order("created_at", { ascending: false }).limit(400);
      const latest = new Map<string, string>();
      for (const p of today ?? []) {
        if (p.dog_ids.length !== 1) continue; // 한 마리만 나온 사진만 써야 헷갈리지 않음
        const d = p.dog_ids[0];
        if (!latest.has(d)) latest.set(d, p.thumb_path);
      }
      const looks = refs.map((d, i) => ({ n: i + 1, name: d.name, path: latest.get(d.id) })).filter((x) => x.path);
      if (looks.length) {
        content.push({ type: "text", text: "Today's look (same dogs, photographed today):" });
        for (const x of looks) {
          let b64 = refCache.get("today:" + x.path);
          if (!b64) {
            b64 = encodeBase64(await download(supa, "photos", x.path!));
            refCache.set("today:" + x.path, b64);
          }
          content.push({ type: "text", text: `[${x.n}] ${x.name} — today` });
          content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
        }
      }
    }

    const targetBytes = await download(supa, "photos", photo.thumb_path);
    content.push({ type: "text", text: "New photo to classify:" });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: encodeBase64(targetBytes) } });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: "user", content }],
      }),
    });

    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      return json({ error: "busy", retryable: true }, 503);
    }
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);

    const out = await res.json();
    const text: string = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { dogs: [], confidence: "low", note: "응답 해석 실패" };
    const note = typeof parsed.note === "string" ? parsed.note.slice(0, 200) : null;

    const nums: number[] = Array.isArray(parsed.dogs) ? parsed.dogs.map(Number) : [];
    let ids = [...new Set(nums.filter((n) => n >= 1 && n <= refs.length).map((n) => refs[n - 1].id))];
    // 주인공 중 모르는 아이가 섞여 있으면 사람이 확인하도록
    const unknownMain = Number(parsed.unknown_main) || 0;
    let status = parsed.confidence === "high" && ids.length > 0 && unknownMain === 0 ? "done" : "review";

    // 처음 보는 강아지 → 새 그룹 자동 생성 (이 사진을 기준 사진으로)
    if (!ids.length && parsed.new_dog === true && parsed.confidence === "high") {
      const { count } = await supa.from("dogs").select("id", { count: "exact", head: true });
      const { data: dog, error: dErr } = await supa.from("dogs")
        .insert({ name: `새 강아지 ${(count ?? 0) + 1}`, auto: true }).select("id").single();
      if (dErr || !dog) throw new Error("새 그룹 생성 실패");
      const refPath = `${dog.id}-${Date.now()}.jpg`;
      const up = await supa.storage.from("refs")
        .upload(refPath, targetBytes, { contentType: "image/jpeg" });
      if (up.error) throw new Error("기준 사진 저장 실패");
      await supa.from("dogs").update({ ref_path: refPath }).eq("id", dog.id);
      ids = [dog.id];
      status = "done";
    }

    await supa.from("photos").update({
      dog_ids: ids,
      confidence: parsed.confidence ?? null,
      ai_note: note,
      status,
    }).eq("id", photoId);

    return json({ status, dog_ids: ids });
  } catch (e) {
    await supa.from("photos").update({ status: "error", ai_note: String(e).slice(0, 200) }).eq("id", photoId);
    return json({ error: String(e) }, 500);
  }
});
