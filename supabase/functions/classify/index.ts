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
You get numbered known dogs, each with one or more reference photos taken from different angles
(front, side, back, lying down…), possibly none yet. Some dogs also have
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
Many dogs look alike (e.g. several white Maltese, several Australian Shepherds). Only match when the
specific dog is the same. Clothes change from day to day, so the body itself decides.
Some dogs come with "구분" (distinguishing points) written by staff or found by comparing look-alikes,
e.g. tail length, a spot on the face, ear color, size. These are DECISIVE: before choosing between
similar dogs, look for each listed point in the new photo. If the point that would decide is not
visible (e.g. the tail is hidden) and two look-alikes still fit, set confidence "low".

The photos are sent to each dog's owner, so decide which dogs this photo should be sent to.
- A photo with several dogs goes to EVERY dog that is properly shown in it: clearly visible,
  recognizable, and a meaningful part of the picture (playing together, sitting side by side,
  walking as a group, group shots). Owners like seeing their dog with friends.
- Leave out only dogs that are barely in it: tiny far in the background, mostly cut off at the edge,
  heavily blurred, or only a paw/tail showing. Those owners would not recognize their dog.
In the reply, "MAIN dogs" means exactly these dogs that are properly shown.

Reply with JSON only, no other text:
{"dogs":[<reference numbers of MAIN dogs>],"new_dog":true|false,"unknown_main":<number>,"confidence":"high"|"low","rotate":0|90|180|270,"note":"<한국어 30자 이내: 판단 근거>"}
Keep "note" very short (under 30 Korean characters).
- "dogs": ALL known dogs properly shown in the new photo (one or several; [] if none).
- "unknown_main": how many properly shown dogs match none of the known dogs.
- "new_dog": true if the photo has exactly one MAIN dog and you are fairly sure it is none of the
  known dogs (e.g. clearly different coat color, size or breed type), even if its face is hidden.
  Then "dogs" must be []. Do not set it when the dog could plausibly be one of the known dogs.
- "rotate": how many degrees the NEW photo must be turned CLOCKWISE to stand upright (floor/ground at the
  bottom, dogs and people the right way up). 0 if it is already upright. Phone photos are often saved
  sideways (90 or 270) or upside down (180); judge from the floor, walls, furniture, people and the dogs' bodies.
- "confidence": "high" when the clues clearly point to one dog. "low" if the dog is blurry or
  mostly hidden, or if two known dogs fit about equally for one of the dogs in the photo.`;

const refCache = new Map<string, string>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type Supa = ReturnType<typeof createClient>;

// 응답이 길어 잘리거나 코드블록으로 감싸져도 최대한 읽어냄
function parseReply(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* 아래에서 필드별로 시도 */ }
  }
  const dogs = text.match(/"dogs"\s*:\s*\[([^\]]*)\]/);
  const rot = text.match(/"rotate"\s*:\s*(\d+)/);
  const conf = text.match(/"confidence"\s*:\s*"(high|low)"/);
  const nd = text.match(/"new_dog"\s*:\s*(true|false)/);
  const um = text.match(/"unknown_main"\s*:\s*(\d+)/);
  if (!dogs) return { dogs: [], confidence: "low", note: "응답 해석 실패" };
  return {
    dogs: dogs[1].split(",").map((x) => Number(x.trim())).filter((n) => n > 0),
    confidence: conf ? conf[1] : "low",
    new_dog: nd ? nd[1] === "true" : false,
    unknown_main: um ? Number(um[1]) : 0,
    rotate: rot ? Number(rot[1]) : 0,
    note: null,
  };
}

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
  let q = supa.from("dogs").select("id, name, note, tips, tips_ai, ref_path, dog_refs(path, created_at)")
    .eq("active", true).order("created_at");
  if (assigned && assigned.length) {
    q = q.or(`id.in.(${assigned.map((a) => a.dog_id).join(",")}),auto.eq.true`);
  }
  const { data: dogs } = await q;
  // 오늘 명단에 있지만 대표 사진이 없는 아이 수 (호텔링 손님 등)
  const faceless = assigned && assigned.length
    ? (dogs ?? []).filter((d) => !(d.dog_refs ?? []).length && !d.ref_path && assigned.some((a) => a.dog_id === d.id)).length
    : 0;
  // 대표 사진이 하나라도 있는 강아지만 후보. 전체 이미지 수가 너무 많아지지 않게 강아지당 장수 조절
  const withRefs = (dogs ?? []).map((d) => {
    const paths = (d.dog_refs ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((r) => r.path);
    if (!paths.length && d.ref_path) paths.push(d.ref_path);
    return { ...d, paths };
  }).filter((d) => d.paths.length);
  // 한 번에 보내는 대표 사진은 최대 MAX_REF_IMAGES장 (요금이 비싸지는 길이를 넘지 않도록).
  // 강아지 수로 나눠 강아지당 최대 10장, 사진이 더 많으면 고르게 골라 다양한 각도가 들어가게 함
  // 많이 보낼수록 느려짐: 명단 확정한 날(보통 20~30마리)은 아이당 4~6장, 명단 없으면 아이당 1장
  const MAX_REF_IMAGES = 120;
  const perDog = Math.max(1, Math.min(6, Math.floor(MAX_REF_IMAGES / Math.max(1, withRefs.length))));
  const spread = (arr: string[], k: number) =>
    arr.length <= k ? arr : Array.from({ length: k }, (_, i) => arr[Math.floor((i * arr.length) / k)]);
  // 직원이 고쳐 준 최근 사진(-learn-)은 꼭 포함: 가장 최근 2장 + 나머지에서 고르게
  const pickRefs = (arr: string[], k: number) => {
    if (arr.length <= k || k < 3) return spread(arr, k);
    return [...spread(arr.slice(0, -2), k - 2), ...arr.slice(-2)];
  };
  const refs = withRefs.map((d) => ({ ...d, paths: pickRefs(d.paths, perDog) }));

  // 대표 사진을 한꺼번에(16장씩 동시에) 미리 불러옴. 한 장씩 받으면 사진 1장 분류에 1분 넘게 걸림
  const needPaths = [...new Set(refs.flatMap((d) => d.paths))].filter((p) => !refCache.has(p));
  for (let i = 0; i < needPaths.length; i += 16) {
    await Promise.all(needPaths.slice(i, i + 16).map(async (path) => {
      try { refCache.set(path, encodeBase64(await download(supa, "refs", path))); } catch { /* 없는 파일은 건너뜀 */ }
    }));
  }

  try {
    const content: Record<string, unknown>[] = [];
    if (refs.length) {
      content.push({ type: "text", text: "Reference dogs:" });
      for (let i = 0; i < refs.length; i++) {
        const d = refs[i];
        const tips = [d.tips, d.tips_ai].filter(Boolean).join(" / ");
        content.push({ type: "text", text: `[${i + 1}] ${d.name}${d.note ? ` — ${d.note}` : ""}${tips ? ` | 구분: ${tips}` : ""}${d.paths.length > 1 ? ` (${d.paths.length} photos)` : ""}` });
        for (const path of d.paths) {
          const b64 = refCache.get(path);
          if (b64) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
        }
      }
      content[content.length - 1].cache_control = { type: "ephemeral" };
    } else {
      content.push({ type: "text", text: "Reference dogs: none yet." });
    }
    if (faceless) {
      content.push({ type: "text", text: `Note: ${faceless} dog(s) here today have NO reference photos yet (e.g. hotel guests). ` +
        "So unfamiliar dogs are expected: if a dog does not clearly match a known dog, treat it as unknown " +
        "(new_dog / unknown_main) instead of forcing it onto a similar-looking known dog." });
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
        await Promise.all(looks.filter((x) => !refCache.has("today:" + x.path)).map(async (x) => {
          try { refCache.set("today:" + x.path, encodeBase64(await download(supa, "photos", x.path!))); } catch { /* 건너뜀 */ }
        }));
        for (const x of looks) {
          const b64 = refCache.get("today:" + x.path);
          if (!b64) continue;
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
        max_tokens: 3000,
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
    const parsed = parseReply(text);
    const note = typeof parsed.note === "string" ? parsed.note.slice(0, 200) : null;

    const nums: number[] = Array.isArray(parsed.dogs) ? parsed.dogs.map(Number) : [];
    let ids = [...new Set(nums.filter((n) => n >= 1 && n <= refs.length).map((n) => refs[n - 1].id))];
    // 주인공 중 모르는 아이가 섞여 있으면 사람이 확인하도록
    const unknownMain = Number(parsed.unknown_main) || 0;
    let status = parsed.confidence === "high" && ids.length > 0 && unknownMain === 0 ? "done" : "review";

    // 처음 보는 강아지 → 새 그룹 자동 생성 (이 사진을 기준 사진으로)
    if (!ids.length && parsed.new_dog === true && unknownMain <= 1) {
      const { count } = await supa.from("dogs").select("id", { count: "exact", head: true });
      const { data: dog, error: dErr } = await supa.from("dogs")
        .insert({ name: `새 강아지 ${(count ?? 0) + 1}`, auto: true }).select("id").single();
      if (dErr || !dog) throw new Error("새 그룹 생성 실패");
      const refPath = `${dog.id}-${Date.now()}.jpg`;
      const up = await supa.storage.from("refs")
        .upload(refPath, targetBytes, { contentType: "image/jpeg" });
      if (up.error) throw new Error("기준 사진 저장 실패");
      await supa.from("dogs").update({ ref_path: refPath }).eq("id", dog.id);
      await supa.from("dog_refs").insert({ dog_id: dog.id, path: refPath });
      ids = [dog.id];
      status = "done";
    }

    const rotation = [0, 90, 180, 270].includes(Number(parsed.rotate)) ? Number(parsed.rotate) : 0;
    await supa.from("photos").update({
      rotation,
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
