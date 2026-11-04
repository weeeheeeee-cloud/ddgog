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
You get numbered reference photos (one per known dog, possibly none yet), then ONE new photo.
Decide which reference dogs appear in the new photo.
Compare fur color and pattern, face markings, ear shape, muzzle, size and coat length.
Clothes, collars and backgrounds can differ between photos, so do not rely on them.
Many dogs look alike (e.g. several white Maltese). Only match when the specific dog is the same.
Reply with JSON only, no other text:
{"dogs":[<reference numbers>],"new_dog":true|false,"confidence":"high"|"low","note":"<짧은 한국어 메모>"}
- "dogs": every reference dog clearly visible in the new photo ([] if none).
- "new_dog": true ONLY if the new photo shows exactly one dog, clearly visible with its face,
  and it matches none of the references. Then "dogs" must be [].
- "confidence": "low" if a dog is blurry, mostly hidden, or two references look alike.`;

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
    Deno.env.get("SUPABASE_ANON_KEY")!,
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
    let status = parsed.confidence === "high" && ids.length > 0 ? "done" : "review";

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
