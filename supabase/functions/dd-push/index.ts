// 다이얼독 알림장 임시저장: 다이얼독 화면에서 실행되는 스크립트(dd-push.js)가 호출
//  action "list": { token, day? } → 그날 분류된 사진을 다이얼독 반려견(petId)별로 { day, dogs: [{ petId, name, photos: [{ id, url, rotation, pushed }] }] }
//  action "mark": { token, items: [{ photo_id, pet_id }] } → 다이얼독에 넣은 사진 기록 (다음에 같은 사진을 또 넣지 않게)
//  action "note": { token, text } → 알림장에 모든 아이 똑같이 붙일 글 저장
//  action "members": { token, pets } → 다이얼독 회원 명단을 유치원 탭(kinder_members)에 넣기/갱신
//  action "tickets": { token, types, tickets, pet_ids } → 이용권 가격표·아이별 이용권
//  action "usage": { token, ticket_ids, rows } → 이용권별 차감(예약·출석·취소) 내역
//  list 응답에는 note(저장된 글), 아이별 hotel(그날 H 표시), others(다이얼독에 연결 안 된 아이)도 들어 있음
// 관리 탭에서 만든 dd_push_links 열쇠가 켜져 있어야만 동작

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "https://dialodog.com",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = String(body.token ?? "");
  const { data: link } = token
    ? await admin.from("dd_push_links").select("token, active").eq("token", token).maybeSingle()
    : { data: null };
  if (!link?.active) return json({ error: "버튼 열쇠가 맞지 않아요. 사진함 관리 탭에서 북마크를 다시 만들어 주세요." }, 403);
  await admin.from("dd_push_links").update({ last_used: new Date().toISOString() }).eq("token", token);

  try {
    if (body.action === "list") {
      const day = typeof body.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : kstToday();
      const { data: dogs } = await admin.from("dogs").select("id, name, dd_pet_id, auto").eq("auto", false);
      const byDog = new Map((dogs ?? []).filter((d) => d.dd_pet_id).map((d) => [d.id, d]));
      const nameOf = new Map((dogs ?? []).map((d) => [d.id, d.name]));
      // 그날 H(호텔링) 표시된 아이
      const { data: asg } = await admin.from("assignments").select("dog_id, hotel").eq("day", day);
      const hotelIds = new Set((asg ?? []).filter((a) => a.hotel).map((a) => a.dog_id));
      const { data: noteRow } = await admin.from("app_settings").select("value").eq("name", "dd_note").maybeSingle();
      const photos: { id: string; path: string; rotation: number | null; dog_ids: string[]; taken_at: string | null; created_at: string }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data } = await admin.from("photos").select("id, path, rotation, dog_ids, taken_at, created_at")
          .eq("day", day).eq("status", "done").eq("practice", false).range(from, from + 999);
        photos.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      const { data: done } = await admin.from("dd_pushed").select("photo_id, pet_id").in("photo_id", photos.map((p) => p.id).slice(0, 5000));
      const pushed = new Set((done ?? []).map((x) => `${x.photo_id}|${x.pet_id}`));
      // 사진함에서 정한 순서(맨 앞 = 대표 사진)
      const { data: orders } = await admin.from("photo_order").select("dog_id, ids").eq("day", day);
      const orderOf = new Map((orders ?? []).map((o: { dog_id: string; ids: string[] }) => [o.dog_id, new Map((o.ids ?? []).map((id, i) => [id, i]))]));
      const out = new Map<string, { petId: string; name: string; dogId: string; photos: { id: string; path: string; rotation: number; pushed: boolean; t: string }[] }>();
      const others = new Map<string, { name: string; hotel: boolean; n: number }>(); // 사진은 있는데 다이얼독에 연결 안 된 아이
      for (const p of photos) {
        for (const id of p.dog_ids ?? []) {
          const d = byDog.get(id);
          if (!d) {
            if (!nameOf.has(id)) continue;
            const o = others.get(id) ?? { name: nameOf.get(id)!, hotel: hotelIds.has(id), n: 0 };
            o.n++; others.set(id, o);
            continue;
          }
          if (!out.has(d.dd_pet_id)) out.set(d.dd_pet_id, { petId: d.dd_pet_id, name: d.name, dogId: d.id, photos: [] });
          out.get(d.dd_pet_id)!.photos.push({ id: p.id, path: p.path, rotation: p.rotation ?? 0, pushed: pushed.has(`${p.id}|${d.dd_pet_id}`), t: p.taken_at ?? p.created_at });
        }
      }
      // 정한 순서(없으면 찍은 순서)대로, 주소는 1시간짜리
      const all = [...out.values()];
      const paths = [...new Set(all.flatMap((d) => d.photos.map((p) => p.path)))];
      const urls = new Map<string, string>();
      for (let i = 0; i < paths.length; i += 500) {
        const { data } = await admin.storage.from("photos").createSignedUrls(paths.slice(i, i + 500), 3600);
        (data ?? []).forEach((x) => x.signedUrl && x.path && urls.set(x.path, x.signedUrl));
      }
      return json({
        day,
        note: String((noteRow?.value as { text?: string } | null)?.text ?? ""),
        others: [...others.values()],
        dogs: all.map((d) => ({
          petId: d.petId, name: d.name, hotel: hotelIds.has(d.dogId),
          photos: d.photos.sort((a, b) => {
            const r = orderOf.get(d.dogId);
            const ra = r?.get(a.id) ?? 1e9, rb = r?.get(b.id) ?? 1e9;
            return ra - rb || a.t.localeCompare(b.t);
          }).map((p) => ({ id: p.id, url: urls.get(p.path), rotation: p.rotation, pushed: p.pushed })).filter((p) => p.url),
        })),
      });
    }
    if (body.action === "members") {
      // 다이얼독 회원(반려견) 명단 → 유치원 탭 (kinder_members). 우리 메모(notes)는 그대로 둠
      const pets = (Array.isArray(body.pets) ? body.pets : []).slice(0, 3000) as Record<string, unknown>[];
      if (!pets.length) return json({ error: "명단이 비어 있어요" }, 400);
      const fmtPhone = (v: unknown) => {
        const d = String(v ?? "").replace(/\D/g, "");
        return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : String(v ?? "").trim();
      };
      const clean = (v: unknown) => { const t = String(v ?? "").replace(/\s+/g, " ").trim(); return t || null; };
      const { data: dogs } = await admin.from("dogs").select("id, dd_pet_id").not("dd_pet_id", "is", null);
      const dogOf = new Map((dogs ?? []).map((d) => [String(d.dd_pet_id), d.id]));
      const now = new Date().toISOString();
      const rows = pets.filter((p) => p.id && p.name).map((p) => {
        const owners = (Array.isArray(p.owners) ? p.owners : []) as Record<string, unknown>[];
        const main = owners.find((o) => o.primaryProfile) ?? owners[0] ?? {};
        const addrOf = (o: Record<string, unknown>) => { const a = (o.address ?? {}) as Record<string, unknown>; return clean([a.address, a.addressDetail].filter(Boolean).join(" ")); };
        const w = Number(p.weight);
        return {
          dd_pet_id: String(p.id), name: String(p.name).trim(), breed: clean(p.breed),
          birthday: /^\d{4}-\d{2}-\d{2}$/.test(String(p.birthday ?? "")) ? p.birthday : null,
          gender: clean(p.gender), neutered: clean(p.neutered), weight: Number.isFinite(w) && w > 0 ? w : null,
          owner_name: clean(main.name), phone: main.phone ? fmtPhone(main.phone) : null, address: addrOf(main),
          owners: owners.map((o) => ({ name: clean(o.name), phone: o.phone ? fmtPhone(o.phone) : null, address: addrOf(o), main: o === main })),
          dd_memo: clean(p.memo), active: !p.removed, dog_id: dogOf.get(String(p.id)) ?? null, synced_at: now, updated_at: now,
        };
      });
      const { data: before } = await admin.from("kinder_members").select("dd_pet_id");
      const had = new Set((before ?? []).map((r) => r.dd_pet_id));
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await admin.from("kinder_members").upsert(rows.slice(i, i + 200), { onConflict: "dd_pet_id" });
        if (error) return json({ error: `저장 실패: ${error.message}` }, 500);
      }
      // 다이얼독에서 지워진 아이는 '그만 다님'으로
      const ids = new Set(rows.map((r) => r.dd_pet_id));
      const gone = [...had].filter((x) => x && !ids.has(x));
      if (gone.length) await admin.from("kinder_members").update({ active: false, updated_at: now }).in("dd_pet_id", gone);
      return json({ ok: true, total: rows.length, added: rows.filter((r) => !had.has(r.dd_pet_id)).length, updated: rows.filter((r) => had.has(r.dd_pet_id)).length, gone: gone.length });
    }
    if (body.action === "tickets") {
      // 다이얼독 이용권 종류(가격표) + 아이별 이용권 → 유치원 탭
      const now = new Date().toISOString();
      const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? "")) ? String(v).slice(0, 10) : null);
      const ts = (v: unknown) => (v ? `${String(v).replace(" ", "T")}${/[zZ+]/.test(String(v).slice(10)) ? "" : "+09:00"}` : null);
      const types = (Array.isArray(body.types) ? body.types : []) as Record<string, unknown>[];
      if (types.length) {
        const { error } = await admin.from("kinder_ticket_types").upsert(types.map((t) => ({
          id: Number(t.id), title: String(t.title ?? ""), quantity: Number(t.quantity) || 0, price: Number(t.price) || 0,
          validity_period: Number(t.validityPeriod) || null, validity_unit: String(t.validityPeriodUnit ?? ""),
          deleted: !!t.deleted, dd_created: ts(t.created), synced_at: now,
        })), { onConflict: "id" });
        if (error) return json({ error: `이용권 종류 저장 실패: ${error.message}` }, 500);
      }
      const tickets = (Array.isArray(body.tickets) ? body.tickets : []) as Record<string, unknown>[];
      const rows = tickets.filter((t) => t.id && t.pawcardId).map((t) => ({
        id: Number(t.id), dd_pet_id: String(t.pawcardId), ticket_type_id: Number(t.ticketTypeId) || null,
        title: String(t.title ?? ""), quantity: Number(t.quantity) || 0, price: Number(t.price) || 0,
        start_date: day(t.startDate), end_date: day(t.endDate), remain: Number(t.remain ?? 0),
        status: t.cancelled || t.canceled ? "cancel" : String(t.ticketStatus ?? ""), depleted: !!t.depleted, expired_by_date: !!t.expiredByDate,
        canceled_at: ts(t.canceled), dd_created: ts(t.created), synced_at: now,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await admin.from("kinder_tickets").upsert(rows.slice(i, i + 500), { onConflict: "id" });
        if (error) return json({ error: `이용권 저장 실패: ${error.message}` }, 500);
      }
      // 이번에 받은 아이들 중 다이얼독에서 지워진 이용권은 지움
      const pets = Array.isArray(body.pet_ids) ? (body.pet_ids as string[]).map(String) : [];
      let removed = 0;
      if (pets.length) {
        const keep = new Set(rows.map((r) => r.id));
        for (let i = 0; i < pets.length; i += 100) {
          const { data: old } = await admin.from("kinder_tickets").select("id").in("dd_pet_id", pets.slice(i, i + 100));
          const del = (old ?? []).map((o) => Number(o.id)).filter((id) => !keep.has(id));
          if (del.length) { await admin.from("kinder_tickets").delete().in("id", del); removed += del.length; }
        }
      }
      // 차감 내역을 새로 받아야 하는 이용권: 사용 전·사용 중, 최근 60일 안에 끝난 것, 아직 내역을 한 번도 안 받은 것
      // (오래전에 끝난 이용권은 내역이 더 바뀌지 않으니 매번 다시 받지 않음 → 두 번째부터 빨라짐)
      const cut = new Date(Date.now() + 9 * 3600e3 - 60 * 86400e3).toISOString().slice(0, 10);
      const liveRows = rows.filter((r) => r.status !== "cancel");
      const have = new Set<number>();
      const liveIds = liveRows.map((r) => r.id);
      for (let i = 0; i < liveIds.length; i += 300) {
        const { data } = await admin.from("kinder_ticket_usage").select("ticket_id").in("ticket_id", liveIds.slice(i, i + 300));
        (data ?? []).forEach((u) => have.add(Number(u.ticket_id)));
      }
      const need_usage = liveRows.filter((r) => r.status === "inUse" || r.status === "beforeUse" || !r.end_date || r.end_date >= cut || !have.has(r.id)).map((r) => r.id);
      return json({ ok: true, types: types.length, tickets: rows.length, removed, need_usage });
    }
    if (body.action === "usage") {
      // 이용권별 차감 내역 (그 이용권의 예전 내역은 지우고 새로)
      const ids = (Array.isArray(body.ticket_ids) ? body.ticket_ids : []).map(Number).filter(Boolean);
      const list = (Array.isArray(body.rows) ? body.rows : []) as Record<string, unknown>[];
      const ts = (v: unknown) => (v ? `${String(v).replace(" ", "T")}${/[zZ+]/.test(String(v).slice(10)) ? "" : "+09:00"}` : null);
      for (let i = 0; i < ids.length; i += 300) await admin.from("kinder_ticket_usage").delete().in("ticket_id", ids.slice(i, i + 300));
      const rows = list.filter((u) => u.ticketId && u.bookingTime).map((u) => ({
        ticket_id: Number(u.ticketId), booking_day: String(u.bookingTime).slice(0, 10), status: String(u.status ?? ""),
        service: String(u.serviceName ?? ""), booked_at: ts(u.bookingCreated), canceled_at: ts(u.bookingCanceled),
      }));
      for (let i = 0; i < rows.length; i += 1000) {
        const { error } = await admin.from("kinder_ticket_usage").upsert(rows.slice(i, i + 1000), { onConflict: "ticket_id,booking_day,status", ignoreDuplicates: true });
        if (error) return json({ error: `차감 내역 저장 실패: ${error.message}` }, 500);
      }
      return json({ ok: true, rows: rows.length });
    }
    if (body.action === "note") {
      const text = String(body.text ?? "").slice(0, 1000);
      await admin.from("app_settings").upsert({ name: "dd_note", value: { text } }, { onConflict: "name" });
      return json({ ok: true });
    }
    if (body.action === "mark") {
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 2000) as { photo_id: string; pet_id: string }[];
      if (items.length) await admin.from("dd_pushed").upsert(items.map((x) => ({ photo_id: x.photo_id, pet_id: String(x.pet_id) })), { ignoreDuplicates: true });
      // 임시저장까지 끝난 아이 = 검수 끝 → 그 아이들 학습 (기다리지 않고 뒤에서)
      if (items.length) {
        const pets = [...new Set(items.map((x) => String(x.pet_id)))];
        const { data: ds } = await admin.from("dogs").select("id").in("dd_pet_id", pets);
        const { data: ph } = await admin.from("photos").select("day").eq("id", items[0].photo_id).maybeSingle();
        const { data: k } = await admin.from("internal_keys").select("key").eq("name", "worker").single();
        if (ds?.length && ph?.day && k?.key) {
          const learn = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/learn-verified`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-worker-key": k.key, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
            body: JSON.stringify({ day: ph.day, dog_ids: ds.map((d) => d.id) }),
          }).catch(() => {});
          // @ts-ignore EdgeRuntime 은 Supabase 런타임에 있음
          if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(learn); else await learn;
        }
      }
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
  return json({ error: "unknown action" }, 400);
});
