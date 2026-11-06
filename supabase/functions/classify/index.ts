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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-worker-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM = `You identify individual dogs in photos taken at a dog daycare.
You may also get "past mistakes": photos that were matched to the wrong dog before, with the correct answer.
Study them: the same look-alike dogs come every day, so do not repeat those mistakes.
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
WHITE DOGS NEED EXTRA CARE: this daycare has many white curly dogs (bichons, maltipoos, maltese, cotons)
and they are the most common mistakes. For a white dog, never decide from "white and curly" alone. Check, one by one:
nose colour (black vs brownish vs slightly PINK), tear stains (none / light / brown) and where,
head shape and size (huge round puffy "afro" head vs small or narrow head, long vs short muzzle),
ear length and whether ears are hidden in the head fluff, cream/apricot tinge on ears or back,
body size and leg length, tail plume. Compare these against each white candidate's 구분 and 부위별 특징.
If two white candidates still fit equally, choose the one that matches the most specific points and set confidence "low".
Many dogs come with "부위별 특징" (what the face, top of the head, back of the head, back, tail and legs look like).
Staff photos often show only part of a dog (just the head from above, the back of the head, the back, the rear),
so compare the visible part with that dog's matching body-part description and reference photos of the same view.
Some dogs come with "구분" (distinguishing points) written by staff or found by comparing look-alikes,
e.g. tail length, a spot on the face, ear color, size. These are DECISIVE: before choosing between
similar dogs, look for each listed point in the new photo. If the point that would decide is not
visible (e.g. the tail is hidden) and two look-alikes still fit, set confidence "low".

The photos are sent to each dog's owner, so decide which dogs this photo should be sent to.
- The photo's main subject (the dog the photo was clearly taken of: biggest, in focus, centred) always counts,
  even if its face is hidden (back of the head, back, from above). Identify it from body, coat and clothes.
- Any OTHER dog in the photo counts only if its FACE is clearly visible (eyes and muzzle seen) and it is a
  real part of the picture (posing or playing together with the main dog, side by side, a group shot).
- Leave out every other dog: dogs in the background, dogs whose face is not visible (sniffing the ground,
  turned away, head down or cut off), dogs that are small, blurred or cut off at the edge. Their owners
  would not want this photo, so do NOT list them in "dogs" and do NOT count them in "unknown_main".
In the reply, "MAIN dogs" means exactly these dogs that are properly shown.

Reply with JSON only, no other text:
{"dogs":[<reference numbers of MAIN dogs>],"sure":[<numbers from "dogs" you are confident about>],"new_dog":true|false,"unknown_main":<number>,"confidence":"high"|"low","rotate":0|90|180|270,"note":"<한국어 30자 이내: 판단 근거>"}
Keep "note" very short (under 30 Korean characters).
- "dogs": ALL known dogs properly shown in the new photo (one or several; [] if none). ALWAYS give your best
  guess for each properly shown dog, even when unsure: only today's attendees are listed, so pick the best fit
  among them using reference photos, body-part features and today's look. Leave a dog out of "dogs" only when it
  clearly matches NONE of them (different breed type, coat colour or size). List in "sure" only the ones you are
  confident about. Judge each dog separately: an unclear second dog does NOT make you unsure about a dog you recognize.
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

  // 서버 자동 분류(작업자)는 내부 키로, 직원 화면은 로그인으로
  let supa: Supa;
  const wk = req.headers.get("x-worker-key");
  if (wk) {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: k } = await admin.from("internal_keys").select("key").eq("name", "worker").single();
    if (!k || k.key !== wk) return json({ error: "forbidden" }, 403);
    supa = admin;
  } else {
    supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "",
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return json({ error: "로그인이 필요해요" }, 401);
  }

  let photoId: string;
  let recheck = false;
  let only: string[] | null = null; // 직원이 A→B로 고친 뒤, A 폴더의 다른 사진을 A·B 둘 중에서만 다시 판단
  try {
    ({ photo_id: photoId, recheck = false, only = null } = await req.json());
    if (!Array.isArray(only) || !only.length) only = null;
  } catch {
    return json({ error: "bad request" }, 400);
  }

  const { data: photo, error: pErr } = await supa
    .from("photos").select("id, day, thumb_path, vec, practice, dog_ids, find_dogs, not_dogs").eq("id", photoId).single();
  if (pErr || !photo) return json({ error: "사진을 찾을 수 없어요" }, 404);

  // 특정 아이만 찾기: 올릴 때 고른 아이(들)만 후보. 그 아이가 없으면 'skip'
  const find: string[] = Array.isArray(photo.find_dogs) && photo.find_dogs.length && !only ? photo.find_dogs : [];
  if (find.length) only = find;
  // 후보: 그날 담당이 지정된 강아지 + 이름 안 붙은 자동 그룹. 담당 지정이 없으면 활성 강아지 전체
  // 연습 모드(관리 탭에서 켬): 출석 명단을 무시하고 전체 아이 중 지문으로 추려서 분류
  // 학습 모드로 올린 사진은 출석 명단을 무시하고 전체 아이 중 지문으로 추려서 분류
  const practiceOn = photo.practice === true;
  const { data: assignedRaw } = await supa.from("assignments").select("dog_id").eq("day", photo.day);
  const assigned = practiceOn ? [] : assignedRaw;
  let q = supa.from("dogs").select("id, name, auto, note, tips, tips_ai, features, ref_path, dog_refs(path, created_at)")
    .eq("active", true).order("created_at");
  // recheck: '새 강아지' 그룹 사진을 이름 있는 아이들과만 다시 비교
  if (only) {
    q = q.in("id", only);
  } else if (assigned && assigned.length) {
    q = recheck ? q.in("id", assigned.map((a) => a.dog_id)).eq("auto", false)
      : q.or(`id.in.(${assigned.map((a) => a.dog_id).join(",")}),auto.eq.true`);
  } else if (recheck) {
    q = q.eq("auto", false);
  }
  let { data: dogs } = await q;
  // 직원이 '이 아이 아님'으로 뺀 아이는 이 사진의 후보에서 제외
  const notDogs: string[] = Array.isArray(photo.not_dogs) ? photo.not_dogs : [];
  if (notDogs.length) dogs = (dogs ?? []).filter((d) => !notDogs.includes(d.id));
  // 학습 모드(명단 없음): 지문으로 전체 중 가장 닮은 16마리만 후보로 (흰 아이들처럼 서로 닮은 무리가 많아 넉넉히) → 아이당 대표 사진을 많이 볼 수 있어 정확해짐
  let practice = false;
  if (!only && !(assigned && assigned.length) && !recheck && photo.vec && (dogs ?? []).length > 12) {
    const { data: top } = await supa.rpc("fp_top", { q: photo.vec, dogs: (dogs ?? []).map((d) => d.id), k: 16 });
    if (top?.length) {
      const keep = new Set(top.map((t: { dog_id: string }) => t.dog_id));
      dogs = (dogs ?? []).filter((d) => keep.has(d.id));
      practice = true;
    }
  }
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
  const perDog = Math.max(1, Math.min(find.length ? 12 : 6, Math.floor(MAX_REF_IMAGES / Math.max(1, withRefs.length))));
  const spread = (arr: string[], k: number) =>
    arr.length <= k ? arr : Array.from({ length: k }, (_, i) => arr[Math.floor((i * arr.length) / k)]);
  // 직원이 고쳐 준 최근 사진(-learn-)은 꼭 포함: 가장 최근 2장 + 나머지에서 고르게
  const pickRefs = (arr: string[], k: number) => {
    if (arr.length <= k || k < 3) return spread(arr, k);
    return [...spread(arr.slice(0, -2), k - 2), ...arr.slice(-2)];
  };
  const refs = withRefs.map((d) => ({ ...d, paths: pickRefs(d.paths, perDog) }));

  // ---- 지문(이미지 특징값) 먼저: 확실하면 AI 없이 바로 분류, 애매하면 후보를 AI에게 힌트로
  let fpHint = "";
  if (photo.vec && !recheck && !only && !find.length) {
    const { data: st } = await supa.from("app_settings").select("value").eq("name", "fp").maybeSingle();
    const cfg = { enabled: true, twin: 0.95, dog: 0.86, margin: 0.07, min_n: 2, ...(st?.value ?? {}) };
    if (cfg.enabled) {
      const named = refs.filter((d) => !d.auto);
      const finish = async (ids: string[], note: string) => {
        await supa.from("photos").update({ dog_ids: ids, status: "done", confidence: "high", ai_note: note, claimed_at: null }).eq("id", photoId);
        return json({ status: "done", dog_ids: ids, by: "fingerprint" });
      };
      // 1) 오늘 이미 분류된 거의 같은 장면 사진
      const { data: tw } = await supa.rpc("fp_twin", { q: photo.vec, p_day: photo.day, p_photo: photoId });
      const t = tw?.[0];
      if (t && t.sim >= cfg.twin && t.dog_ids.every((id: string) => refs.some((d) => d.id === id))) {
        return await finish(t.dog_ids, `지문: 같은 장면 사진과 일치 (${t.sim.toFixed(2)})`);
      }
      // 2) 아이별 지문
      if (named.length) {
        const { data: m } = await supa.rpc("fp_match", { q: photo.vec, dogs: named.map((d) => d.id), p_day: photo.day, p_photo: photoId });
        const top = m?.[0], second = m?.[1];
        const nameOf = (id: string) => named.find((d) => d.id === id)?.name ?? "?";
        if (top && top.sim >= cfg.dog && top.n >= cfg.min_n && (!second || top.sim - second.sim >= cfg.margin)) {
          return await finish([top.dog_id], `지문: ${nameOf(top.dog_id)} (${top.sim.toFixed(2)})`);
        }
        if (m?.length) fpHint = `Visual fingerprint similarity (a hint only; check with your own eyes): ` +
          m.slice(0, 3).map((x: { dog_id: string; sim: number }) => `[${refs.findIndex((d) => d.id === x.dog_id) + 1}] ${nameOf(x.dog_id)} ${x.sim.toFixed(2)}`).join(", ");
      }
    }
  }

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
        content.push({ type: "text", text: `[${i + 1}] ${d.name}${d.note ? ` — ${d.note}` : ""}${tips ? ` | 구분: ${tips}` : ""}${d.paths.length > 1 ? ` (${d.paths.length} photos)` : ""}${d.features ? `\n  부위별 특징:\n  ${d.features.replace(/\n/g, "\n  ")}` : ""}` });
        for (const path of d.paths) {
          const b64 = refCache.get(path);
          if (b64) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
        }
      }
      content[content.length - 1].cache_control = { type: "ephemeral" };
    } else {
      content.push({ type: "text", text: "Reference dogs: none yet." });
    }
    // 지난 실수 (직원이 고쳐 준 사진): 오늘 후보와 관련된 것만 최근 순 10장
    if (refs.length) {
      const idx = new Map(refs.map((d, i) => [d.id, i + 1]));
      const ids = refs.map((d) => d.id);
      const { data: les } = await supa.from("lessons").select("wrong_dog, right_dog, path, note")
        .or(`wrong_dog.in.(${ids.join(",")}),right_dog.in.(${ids.join(",")})`)
        .order("created_at", { ascending: false }).limit(16);
      const usable = (les ?? []).filter((l) => idx.has(l.wrong_dog) || idx.has(l.right_dog));
      if (usable.length) {
        await Promise.all(usable.filter((l) => !refCache.has(l.path)).map(async (l) => {
          try { refCache.set(l.path, encodeBase64(await download(supa, "refs", l.path))); } catch { /* 건너뜀 */ }
        }));
        content.push({ type: "text", text: "Past mistakes (learn from these):" });
        const nm = (id: string | null) => {
          if (!id) return "none of them";
          const n = idx.get(id);
          return n ? `[${n}] ${refs[n - 1].name}` : "another dog (not here today)";
        };
        for (const l of usable) {
          const b64 = refCache.get(l.path);
          if (!b64) continue;
          const what = l.wrong_dog
            ? `Was wrongly matched to ${nm(l.wrong_dog)}; it is actually ${nm(l.right_dog)}.`
            : `Was missed before: this photo shows ${nm(l.right_dog)}.`;
          content.push({ type: "text", text: `${what}${l.note ? ` ${l.note}` : ""}` });
          content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
        }
      }
    }
    if (find.length) {
      content.push({ type: "text", text: `Note: staff only want photos of ${refs.map((d) => d.name).join(", ")} from this batch. ` +
        "Answer only whether these dog(s) are properly shown in the new photo. Most photos will show other dogs: then reply \"dogs\": []. " +
        "Here, IGNORE the rule to always give a best guess: list a dog only when its coat, body and distinguishing points really fit; " +
        "if unsure, leave it out. Do not use new_dog." });
    } else if (only) {
      content.push({ type: "text", text: "Note: staff just found that one photo filed under one of these two dogs was actually the other. " +
        "These two dogs are easy to confuse. Look very carefully at the distinguishing points and today's look, and decide which of the two is in the new photo." });
    }
    if (practice) {
      content.push({ type: "text", text: "Note: no attendance list today. These candidates were pre-selected by visual similarity " +
        "from ALL registered dogs, so the right dog is usually among them, but not always: if none truly matches, use new_dog / unknown_main." });
    }
    if (faceless) {
      content.push({ type: "text", text: `Note: ${faceless} dog(s) here today have NO reference photos yet (e.g. hotel guests). ` +
        "So unfamiliar dogs are expected: if a dog does not clearly match a known dog, treat it as unknown " +
        "(new_dog / unknown_main) instead of forcing it onto a similar-looking known dog." });
    }

    // 오늘 모습: 오늘 이미 분류된 사진 중 강아지별 가장 최근 1장 (옷·미용 상태가 그날 그대로라 큰 단서)
    if (refs.length) {
      const { data: today } = await supa.from("photos")
        .select("id, thumb_path, dog_ids").eq("day", photo.day).eq("status", "done").eq("practice", photo.practice === true)
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
    if (fpHint) content.push({ type: "text", text: fpHint });
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
      await supa.from("photos").update({ status: "pending", claimed_at: null }).eq("id", photoId).eq("status", "working");
      return json({ error: "busy", retryable: true }, 503);
    }
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);

    const out = await res.json();
    const text: string = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    const parsed = parseReply(text);
    const note = typeof parsed.note === "string" ? parsed.note.slice(0, 200) : null;

    const nums: number[] = Array.isArray(parsed.dogs) ? parsed.dogs.map(Number) : [];
    const ids = [...new Set(nums.filter((n) => n >= 1 && n <= refs.length).map((n) => refs[n - 1].id))];
    // 아이별로 판단: 확신한 아이가 다 맞으면 끝. 다른 아이가 애매해도 확신한 아이 사진은 보냄
    const sureNums: number[] = Array.isArray(parsed.sure) ? parsed.sure.map(Number) : (parsed.confidence === "high" ? nums : []);
    const sureIds = new Set(sureNums.filter((n) => n >= 1 && n <= refs.length).map((n) => refs[n - 1].id));
    // 애매해도 가장 닮은 아이에게 우선 넣음 (확신 못 한 사진은 confidence low → 화면에 '확인' 표시)
    const status = ids.length ? "done" : "review";
    const allSure = ids.length > 0 && ids.every((id) => sureIds.has(id));
    if (recheck && !ids.length) return json({ unchanged: true });
    if (find.length) {
      const rotation = [0, 90, 180, 270].includes(Number(parsed.rotate)) ? Number(parsed.rotate) : 0;
      await supa.from("photos").update({
        rotation, dog_ids: ids, status: ids.length ? "done" : "skip",
        confidence: ids.length ? (allSure ? "high" : "low") : "high",
        ai_note: ids.length ? note : `찾는 아이 아님${note ? `: ${note}` : ""}`.slice(0, 200), claimed_at: null,
      }).eq("id", photoId);
      return json({ status: ids.length ? "done" : "skip", dog_ids: ids });
    }
    if (only) {
      // 이 사진의 다른 아이들은 그대로 두고, A/B 자리만 다시 정함
      if (!ids.length) return json({ unchanged: true });
      const keepOthers = (photo.dog_ids ?? []).filter((x: string) => !only!.includes(x));
      const finalIds = [...new Set([...keepOthers, ...ids])];
      await supa.from("photos").update({
        dog_ids: finalIds, status: "done", confidence: allSure ? "high" : "low",
        ai_note: `직원 수정 후 다시 확인: ${note ?? ""}`.slice(0, 200), claimed_at: null,
      }).eq("id", photoId);
      return json({ status: "done", dog_ids: finalIds, changed: finalIds.join() !== (photo.dog_ids ?? []).join() });
    }

    // 처음 보는 강아지: 새 그룹을 만들지 않고 '모르는 아이' 사진으로 둠 (화면에서 비슷한 사진끼리 묶어 보여줌)
    const isNew = !recheck && !ids.length && parsed.new_dog === true;

    const rotation = [0, 90, 180, 270].includes(Number(parsed.rotate)) ? Number(parsed.rotate) : 0;
    await supa.from("photos").update({
      rotation,
      dog_ids: ids,
      confidence: allSure ? "high" : "low",
      ai_note: isNew ? `처음 보는 아이${note ? `: ${note}` : ""}`.slice(0, 200) : note,
      status,
      claimed_at: null,
    }).eq("id", photoId);

    return json({ status, dog_ids: ids });
  } catch (e) {
    if (!recheck && (!only || find.length)) await supa.from("photos").update({ status: "error", ai_note: String(e).slice(0, 200) }).eq("id", photoId);
    return json({ error: String(e) }, 500);
  }
});
