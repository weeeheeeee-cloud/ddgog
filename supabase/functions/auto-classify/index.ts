// 서버 자동 분류 작업자: 1분마다(pg_cron) 불려서 오늘 대기 중인 사진을 분류
// 원장님 컴퓨터가 꺼져 있어도 선생님이 올린 사진이 알아서 분류됨
// 출석 명단이 확정된 날만 동작 (명단 없이 전체와 비교하면 느리고 부정확)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
// 방향 확인 (비용 아끼기):
//  1단계: 가벼운 모델(Haiku)에게 작은 사진 한 장만 보여 주고 '똑바로 서 있나?'만 물음 → 대부분 여기서 끝
//  2단계: 돌려야 한다고 나온 사진만, 같은 사진을 4방향으로 보여 주고 '바로 선 것'을 고르게 함. 1단계와 답이 같을 때만 돌림
const QUICK_MODEL = Deno.env.get("ROTATE_QUICK_MODEL") ?? "claude-haiku-5-5";
const ROT_MODEL = Deno.env.get("ROTATE_MODEL") ?? "claude-sonnet-5-5"; // 2단계는 몇 장 안 되니 정확한 모델로
const QUICK_SYSTEM = `You check whether a photo from a dog daycare is upright.
Look at the floor/grass/ground, walls, furniture, people and gravity (not the dog's pose: dogs lie on their side or back).
Reply with JSON only: {"rotate":0|90|180|270,"sure":true|false}
"rotate" = degrees to turn the photo CLOCKWISE so it stands upright (0 if it is already upright). Most phone photos are upright.`;
async function quickRotate(b64: string): Promise<number | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: QUICK_MODEL, max_tokens: 200, system: QUICK_SYSTEM, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }, { type: "text", text: "Upright?" },
    ] }] }),
  });
  if (!res.ok) throw new Error(`quick ${res.status}`);
  const out = await res.json();
  const text: string = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  const j = m ? JSON.parse(m[0]) : {};
  const r = Number(j.rotate);
  if (![0, 90, 180, 270].includes(r)) return null;
  return r === 0 ? 0 : j.sure === false ? null : r;
}
const ROT_SYSTEM = `You see the SAME photo from a dog daycare shown in 4 orientations, labeled A, B, C, D.
Pick the one that is upright, the way the photographer saw the scene: floor/grass/ground at the bottom,
sky or ceiling at the top, walls, doors and furniture vertical, people standing or sitting upright, any text readable.
Dogs can lie on their side, roll on their back or be shot from above, so judge mainly by the floor, furniture,
people, light from windows and gravity (leashes, hanging things, water). Phone photos are usually already upright.
If the scene gives no clear clue (e.g. a close-up of fur, a dog on a rug from straight above), set "sure": false.
Reply with JSON only: {"pick":"A"|"B"|"C"|"D","sure":true|false}`;

// 정확히 90도 단위로 시계 방향 회전 (보간 없이 픽셀 그대로)
function rotCW(img: Image, deg: number) {
  let cur = img;
  for (let k = 0; k < ((deg / 90) | 0) % 4; k++) {
    const W = cur.width, H = cur.height, out = new Image(H, W), s = cur.bitmap, d = out.bitmap;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4, di = (x * H + (H - 1 - y)) * 4;
      d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = s[si + 3];
    }
    cur = out;
  }
  return cur;
}

// 4방향 중 바로 선 것 고르기 → 돌려야 할 각도(시계 방향) 또는 null(모름)
async function pickUpright(views: Map<number, string>, order: number[]): Promise<number | null> {
  const L = ["A", "B", "C", "D"];
  const content: unknown[] = [];
  order.forEach((deg, i) => {
    content.push({ type: "text", text: `${L[i]}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: views.get(deg)! } });
  });
  content.push({ type: "text", text: "Which one is upright?" });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ROT_MODEL, max_tokens: 300, system: ROT_SYSTEM, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`rot ${res.status}`);
  const out = await res.json();
  const text: string = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  const j = m ? JSON.parse(m[0]) : {};
  const i = L.indexOf(String(j.pick ?? "").toUpperCase());
  if (i < 0 || j.sure === false) return null;
  return order[i];
}
const shuffle = <T>(a: T[]) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

const URL = Deno.env.get("SUPABASE_URL")!;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

function hamming(a: string | null, b: string | null) {
  if (!a || !b || a.length !== b.length) return 99;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

Deno.serve(async (req) => {
  const admin = createClient(URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: k } = await admin.from("internal_keys").select("key").eq("name", "worker").single();
  if (!k || req.headers.get("x-worker-key") !== k.key) return json({ error: "forbidden" }, 403);

  const day = kstToday();
  // 언제 돌지는 DB(kick_auto_classify)가 정함: 명단 있는 날 사진 또는 학습 모드 사진

  const started = Date.now();
  let done = 0, copied = 0, failed = 0;
  // 약 100초 동안 8장씩 가져와서 처리
  while (Date.now() - started < 100_000) {
    const { data: batch } = await admin.rpc("claim_pending", { p_day: day, p_n: 8 });
    if (!batch?.length) break;
    // 연속으로 찍은 거의 같은 사진은 가장 선명한 1장만 판단하고 결과를 나머지에 적용
    const sorted = [...batch].sort((a, b) => String(a.taken_at ?? "").localeCompare(String(b.taken_at ?? "")));
    const groups: (typeof batch)[] = [];
    for (const p of sorted) {
      const g = groups[groups.length - 1];
      const last = g?.[g.length - 1];
      if (g && p.taken_at && last?.taken_at && Math.abs(+new Date(p.taken_at) - +new Date(last.taken_at)) <= 5000 &&
        hamming(g[0].phash, p.phash) <= 12) g.push(p);
      else groups.push([p]);
    }
    await Promise.all(groups.map(async (g) => {
      const rep = g.reduce((m, x) => ((x.sharp ?? 0) > (m.sharp ?? 0) ? x : m), g[0]);
      let ok = false;
      for (let t = 0; t < 3 && !ok; t++) {
        const r = await fetch(`${URL}/functions/v1/classify`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-worker-key": k.key, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
          body: JSON.stringify({ photo_id: rep.id }),
        });
        ok = r.ok;
        if (!ok) await new Promise((s) => setTimeout(s, 3000 * (t + 1)));
      }
      if (!ok) { failed++; await admin.from("photos").update({ status: "pending", claimed_at: null }).eq("id", rep.id).eq("status", "working"); }
      else done++;
      const sibs = g.filter((x) => x.id !== rep.id).map((x) => x.id);
      if (!sibs.length) return;
      if (ok) {
        // 방향은 사진마다 따로 확인하므로 분류만 복사. 직원이 고친 사진은 건드리지 않음
        const { data: r } = await admin.from("photos").select("dog_ids, status, confidence").eq("id", rep.id).single();
        if (r) {
          await admin.from("photos").update({ ...r, ai_note: "연속 사진: 바로 앞 사진과 같은 분류", claimed_at: null }).in("id", sibs).or("confidence.is.null,confidence.neq.manual");
          copied += sibs.length;
          return;
        }
      }
      await admin.from("photos").update({ status: "pending", claimed_at: null }).in("id", sibs);
    }));
  }
  // 방향 확인: 최근 3일 분류된 사진 중 아직 방향을 확인하지 않은 것 (직원이 직접 돌린 사진은 rotation_checked=true 라 제외)
  //  · 작은 사진 한 장을 가벼운 모델에게 보여 '똑바로인가'만 확인 → 돌려야 한다고 나온 사진만 4방향 비교로 한 번 더, 둘 다 같을 때만 돌림
  //  · 확실하지 않으면 지금 방향을 그대로 둠
  let rotated = 0, checked = 0;
  if (ANTHROPIC_KEY && Date.now() - started < 100_000) {
    const since = new Date(Date.now() + 9 * 3600e3 - 2 * 86400e3).toISOString().slice(0, 10);
    const { data: rot } = await admin.from("photos").select("id, thumb_path, rotation")
      .gte("day", since).lte("day", day).eq("status", "done").eq("rotation_checked", false)
      .order("day", { ascending: false }).limit(60);
    const list = rot ?? [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(8, list.length) }, async () => {
      while (i < list.length && Date.now() - started < 130_000) {
        const p = list[i++];
        try {
          const { data: b } = await admin.storage.from("photos").download(p.thumb_path);
          if (!b) continue;
          const img = await Image.decode(new Uint8Array(await b.arrayBuffer()));
          // 작게 줄여서 보냄 (긴 변 384px) → 비용이 훨씬 적음
          const sc = 384 / Math.max(img.width, img.height);
          const small = sc < 1 ? img.resize(Math.round(img.width * sc), Math.round(img.height * sc)) : img;
          const first = await quickRotate(encodeBase64(await small.encodeJPEG(75)));
          let r: number | null = first;
          if (first !== null && first !== 0) {
            // 돌려야 한다고 나온 사진만 4방향 비교로 한 번 더 (1단계와 같을 때만 돌림)
            const views = new Map<number, string>();
            for (const deg of [0, 90, 180, 270]) views.set(deg, encodeBase64(await rotCW(small, deg).encodeJPEG(75)));
            const second = await pickUpright(views, shuffle([0, 90, 180, 270]));
            r = second === first ? first : null;
          }
          // 확실하지 않거나 두 번 답이 다르면 지금 방향 그대로 둠
          const finalRot = r ?? (p.rotation ?? 0);
          const upd: Record<string, unknown> = { rotation_checked: true };
          if (finalRot !== (p.rotation ?? 0)) { upd.rotation = finalRot; rotated++; }
          // 확인하는 사이 직원이 돌렸으면 덮어쓰지 않음
          await admin.from("photos").update(upd).eq("id", p.id).eq("rotation_checked", false);
          checked++;
        } catch (e) { console.error("rot", p.id, String(e)); }
      }
    }));
  }
  return json({ day, done, copied, failed, checked, rotated });
});
