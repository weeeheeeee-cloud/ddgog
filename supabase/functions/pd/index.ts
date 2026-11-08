// 픽드랍 신청 (보호자 링크 pd.html?k=열쇠 + 직원 화면)
//  action "get"   { token }                                → { dog, today, weeks: [{ start, days, memo }] }  (이번 주·다음 주)
//  action "save"  { token | dog_id(직원 로그인), week_start, days: [1..7], memo } → { ok, days }
//  action "vapid" {}                                       → { key }  폰 알림 공개 열쇠
//  action "test"  {} (직원 로그인)                          → 내 폰들로 시험 알림
// 주가 시작된 뒤(그 주 월요일 0시 이후)에 바뀐 요일·메모는 표시해 두고, 선생님들 폰으로 알림을 보냄

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const DOW = ["", "월", "화", "수", "목", "금", "토", "일"];
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const mondayOf = (d: string) => { const w = new Date(d + "T00:00:00Z").getUTCDay(); return addDays(d, -((w + 6) % 7)); };
const weekStartMs = (w: string) => Date.parse(w + "T00:00:00+09:00");
const SITE = "https://weeeheeeee-cloud.github.io/ddgog/";

type Admin = ReturnType<typeof createClient>;

async function vapidKeys(admin: Admin) {
  const read = async () => {
    const { data } = await admin.from("server_secrets").select("name, value").in("name", ["vapid_public", "vapid_private"]);
    const m = new Map((data ?? []).map((x: { name: string; value: string }) => [x.name, x.value]));
    return m.get("vapid_public") && m.get("vapid_private") ? { pub: m.get("vapid_public")!, priv: m.get("vapid_private")! } : null;
  };
  let k = await read();
  if (k) return k;
  const g = webpush.generateVAPIDKeys();
  await admin.from("server_secrets").upsert([{ name: "vapid_public", value: g.publicKey }, { name: "vapid_private", value: g.privateKey }], { onConflict: "name", ignoreDuplicates: true });
  k = await read();
  return k!;
}

async function pushAll(admin: Admin, payload: Record<string, unknown>, opts: { onlyUser?: string; exceptUser?: string } = {}) {
  let q = admin.from("push_subs").select("endpoint, user_id, p256dh, auth");
  if (opts.onlyUser) q = q.eq("user_id", opts.onlyUser);
  const { data: subs } = await q;
  const list = (subs ?? []).filter((s: { user_id: string }) => !opts.exceptUser || s.user_id !== opts.exceptUser);
  if (!list.length) return 0;
  const k = await vapidKeys(admin);
  webpush.setVapidDetails(SITE, k.pub, k.priv);
  let sent = 0;
  await Promise.all(list.map(async (s: { endpoint: string; p256dh: string; auth: string }) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 86400, urgency: "high" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subs").delete().eq("endpoint", s.endpoint); // 알림을 끈 기기
      else console.error("push", code, String(e));
    }
  }));
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 직원 로그인 확인 (보호자는 열쇠로)
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  let staff: { id: string } | null = null;
  if (jwt && jwt.split(".").length === 3) {
    const { data } = await admin.auth.getUser(jwt);
    staff = data?.user ? { id: data.user.id } : null;
  }

  try {
    if (body.action === "vapid") return json({ key: (await vapidKeys(admin)).pub });

    if (body.action === "test") {
      if (!staff) return json({ error: "로그인이 필요해요" }, 401);
      const n = await pushAll(admin, { title: "🔔 알림이 켜졌어요", body: "픽드랍이 바뀌면 이렇게 알려 드릴게요.", url: SITE + "#pickup", tag: "pd-test" }, { onlyUser: staff.id });
      return json({ ok: true, sent: n });
    }

    // 어떤 아이인지
    let dog: { id: string; name: string; active: boolean } | null = null;
    const token = String(body.token ?? "");
    if (token) {
      const { data } = await admin.from("pd_dogs").select("id, name, active").eq("token", token).maybeSingle();
      dog = data;
      if (!dog?.active) return json({ error: "링크가 맞지 않아요. 댕겨올개에 새 링크를 요청해 주세요." }, 403);
    } else if (staff && body.dog_id) {
      const { data } = await admin.from("pd_dogs").select("id, name, active").eq("id", String(body.dog_id)).maybeSingle();
      dog = data;
    }
    if (!dog) return json({ error: "링크가 맞지 않아요. 댕겨올개에 새 링크를 요청해 주세요." }, 403);

    const today = kstToday();
    const thisWeek = mondayOf(today);
    const weeks = [thisWeek, addDays(thisWeek, 7)];

    if (body.action === "get") {
      const { data } = await admin.from("pd_requests").select("week_start, days, memo, updated_at").eq("dog_id", dog.id).in("week_start", weeks);
      const byW = new Map((data ?? []).map((r: { week_start: string }) => [r.week_start, r]));
      return json({
        dog: { name: dog.name },
        today,
        weeks: weeks.map((w) => {
          const r = byW.get(w) as { days: number[]; memo: string | null; updated_at: string } | undefined;
          return { start: w, saved: !!r, days: r?.days ?? [], memo: r?.memo ?? "", updated_at: r?.updated_at ?? null };
        }),
      });
    }

    if (body.action === "save") {
      const w = String(body.week_start ?? "");
      if (!(staff ? /^\d{4}-\d{2}-\d{2}$/.test(w) && mondayOf(w) === w : weeks.includes(w))) return json({ error: "고를 수 없는 주예요. 화면을 새로 열어 주세요." }, 400);
      const memo = String(body.memo ?? "").trim().slice(0, 300) || null;
      let days = [...new Set((Array.isArray(body.days) ? body.days : []).map(Number).filter((d) => d >= 1 && d <= 7))];

      const { data: old } = await admin.from("pd_requests").select("*").eq("dog_id", dog.id).eq("week_start", w).maybeSingle();
      const oldDays = new Set<number>((old?.days ?? []) as number[]);
      // 보호자는 지난 요일을 바꿀 수 없음 (오늘은 바꿀 수 있음)
      if (!staff) {
        const past = (d: number) => addDays(w, d - 1) < today;
        days = [...days.filter((d) => !past(d)), ...[...oldDays].filter((d) => past(d))];
      }
      days = [...new Set(days)].sort((a, b) => a - b);
      const now = new Date().toISOString();
      const added = days.filter((d) => !oldDays.has(d));
      const removed = [...oldDays].filter((d) => !days.includes(d)).sort((a, b) => a - b);
      const memoChanged = (old?.memo ?? "") !== (memo ?? "");
      const mid = Date.now() >= weekStartMs(w); // 주가 이미 시작됨 → 중간 변경

      const dayAdded: Record<string, string> = { ...(old?.day_added ?? {}) };
      const dayRemoved: Record<string, string> = { ...(old?.day_removed ?? {}) };
      if (mid) {
        for (const d of added) { dayAdded[d] = now; delete dayRemoved[d]; }
        for (const d of removed) { if (dayAdded[d]) delete dayAdded[d]; else dayRemoved[d] = now; }
      }
      const row = {
        dog_id: dog.id, week_start: w, days, memo,
        day_added: dayAdded, day_removed: dayRemoved,
        memo_changed_at: mid && memoChanged ? now : (old?.memo_changed_at ?? null),
        by_staff: !!staff,
        updated_at: now,
        ...(old ? {} : { first_at: now }),
      };
      const { error } = await admin.from("pd_requests").upsert(row, { onConflict: "dog_id,week_start" });
      if (error) throw error;

      if (mid && (added.length || removed.length || memoChanged)) {
        await admin.from("pd_log").insert({ dog_id: dog.id, week_start: w, added, removed, memo_changed: memoChanged, by_staff: !!staff });
        const parts = [
          added.length ? `${added.map((d) => DOW[d]).join("·")} 추가` : "",
          removed.length ? `${removed.map((d) => DOW[d]).join("·")} 취소` : "",
          memoChanged ? (memo ? `메모: ${memo.slice(0, 60)}` : "메모 지움") : "",
        ].filter(Boolean);
        const whenLabel = w === thisWeek ? "이번 주" : `${+w.slice(5, 7)}/${+w.slice(8, 10)} 주`;
        await pushAll(admin, {
          title: `🚗 픽드랍 변경 · ${dog.name}`,
          body: `${whenLabel} ${parts.join(" · ")}${staff ? " (직원이 수정)" : ""}`,
          url: SITE + "#pickup",
          tag: `pd-${dog.id}-${w}`,
        }, { exceptUser: staff?.id });
      }
      return json({ ok: true, days, memo });
    }
  } catch (e) {
    console.error(e);
    return json({ error: "저장하지 못했어요. 잠시 후 다시 해 주세요." }, 500);
  }
  return json({ error: "unknown action" }, 400);
});
