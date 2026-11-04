// 댕겨올개 사진 분류 Edge Function
// 그날 등원한 강아지들의 기준 사진과 새 사진을 Claude 에게 보내서 어떤 강아지인지 판별합니다.
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
You get numbered reference photos (one per dog, with optional notes), then ONE new photo.
Decide which of the reference dogs appear in the new photo.
Compare fur color and pattern, face markings, ear shape, muzzle, size and coat length.
Clothes, collars and backgrounds can differ between photos, so do not rely on them.
Reply with JSON only, no other text:
{"dogs":[<reference numbers>],"confidence":"high"|"low","note":"<짧은 한국어 메모>"}
- "dogs": every listed dog clearly visible in the new photo ([] if none).
- "confidence": "low" if a dog is blurry, mostly hidden, or two references look alike.`;

// 기준 사진은 인스턴스가 살아있는 동안 메모리에 보관
const refCache = new Map<string, string>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function download(supa: ReturnType<typeof createClient>, bucket: string, path: string) {
  const { data, error } = await supa.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`download failed: ${bucket}/${path}`);
  return encodeBase64(new Uint8Array(await data.arrayBuffer()));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!ANTHROPIC_KEY) return json({ error: "ANTHROPIC_API_KEY 가 설정되지 않았어요" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
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

  // 후보: 그날 담당이 지정된 강아지 → 없으면 활성 강아지 전체
  const { data: assigned } = await supa
    .from("assignments").select("dog_id").eq("day", photo.day);
  let q = supa.from("dogs").select("id, name, note, ref_path")
    .eq("active", true).not("ref_path", "is", null).order("name");
  if (assigned && assigned.length) q = q.in("id", assigned.map((a) => a.dog_id));
  const { data: dogs } = await q;
  if (!dogs || dogs.length === 0) {
    await supa.from("photos").update({ status: "review", ai_note: "기준 사진이 등록된 강아지가 없어요" }).eq("id", photoId);
    return json({ status: "review" });
  }

  try {
    const content: unknown[] = [{ type: "text", text: "Reference dogs:" }];
    for (let i = 0; i < dogs.length; i++) {
      const d = dogs[i];
      let b64 = refCache.get(d.ref_path!);
      if (!b64) {
        b64 = await download(supa, "refs", d.ref_path!);
        refCache.set(d.ref_path!, b64);
      }
      content.push({ type: "text", text: `[${i + 1}] ${d.name}${d.note ? ` — ${d.note}` : ""}` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
    }
    // 기준 사진 묶음은 같은 날 반복되므로 캐시 지점 표시
    (content[content.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };

    const target = await download(supa, "photos", photo.thumb_path);
    content.push({ type: "text", text: "New photo to classify:" });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: target } });

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
      // 잠시 후 다시 시도할 수 있도록 pending 유지
      return json({ error: "busy", retryable: true }, 503);
    }
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);

    const out = await res.json();
    const text: string = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { dogs: [], confidence: "low", note: "응답 해석 실패" };

    const nums: number[] = Array.isArray(parsed.dogs) ? parsed.dogs.map(Number) : [];
    const ids = [...new Set(nums.filter((n) => n >= 1 && n <= dogs.length).map((n) => dogs[n - 1].id))];
    const confident = parsed.confidence === "high" && ids.length > 0;

    await supa.from("photos").update({
      dog_ids: ids,
      confidence: parsed.confidence ?? null,
      ai_note: typeof parsed.note === "string" ? parsed.note.slice(0, 200) : null,
      status: confident ? "done" : "review",
    }).eq("id", photoId);

    return json({ status: confident ? "done" : "review", dog_ids: ids });
  } catch (e) {
    await supa.from("photos").update({ status: "error", ai_note: String(e).slice(0, 200) }).eq("id", photoId);
    return json({ error: String(e) }, 500);
  }
});
