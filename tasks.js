// 오늘 할 일 보드 (알림장 탭 맨 위 — 모든 직원이 처음 보는 화면)
//  · 자동 할 일: 그날 호텔링 퇴실(금액), 결제 받기(선결제 안 된 예약), 목욕·미용
//  · 직접 넣는 할 일: 누구나 추가 / 체크 / 삭제 → 다른 직원 화면에도 바로 반영
// 체크 상태는 daily_tasks 에 저장 (자동 할 일은 ref 로, 직접 넣은 할 일은 행 하나씩)

let C = null; // { sb, toast, root }
let boardDay = null;   // 보드에서 보고 있는 날 (앱을 열면 항상 오늘)
let openedOn = null;   // 이 날짜에 앱을 열었음 → 날이 바뀌면 다시 오늘로
let myName = null;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const won = (n) => `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}(${DOW[new Date(d + "T00:00:00Z").getUTCDay()]})`;
const hm = (ts) => new Date(Date.parse(ts) + 9 * 3600e3).toISOString().slice(11, 16);
const CARE = [["bath", "🛁", "목욕"], ["hygiene", "🧼", "위생미용"], ["grooming", "✂️", "미용"]];

async function whoAmI() {
  if (myName) return myName;
  const { data: { user } } = await C.sb.auth.getUser();
  if (!user) return "";
  const { data } = await C.sb.from("staff_roles").select("name").eq("user_id", user.id).maybeSingle();
  myName = data?.name || user.user_metadata?.name || (user.email || "").split("@")[0];
  return myName;
}

// 그날 자동 할 일
function autoItems(bookings) {
  // 호텔링: 퇴실하는 날, 아이 이름 + 결제 금액만
  return bookings.filter((b) => b.status !== "cancelled")
    .sort((a, b) => a.label.localeCompare(b.label, "ko"))
    .map((b) => ({ ref: `out:${b.id}`, icon: "🏨", title: `퇴실 · ${b.label}`, sub: "", money: won(b.total), cls: "out" }));
}

export async function renderTasks(ctx) {
  C = ctx;
  const root = C.root;
  if (!root) return;
  const t0 = kstToday();
  if (!boardDay || openedOn !== t0) { boardDay = t0; openedOn = t0; } // 날이 바뀌면 그날 보드가 메인으로
  const day = boardDay;
  C.day = day;
  const ws = addDays(day, -3), we = addDays(day, 3);
  const [{ data: rows }, { data: bks }, { data: wRows }, { data: wBks }] = await Promise.all([
    C.sb.from("daily_tasks").select("*").eq("day", day).order("created_at"),
    C.sb.from("hotel_bookings").select("id, label, kind, check_out, out_time, total, prepaid, status, services").eq("check_out", day),
    C.sb.from("daily_tasks").select("day, ref, done").gte("day", ws).lte("day", we),
    C.sb.from("hotel_bookings").select("id, check_out, prepaid, status, services").gte("check_out", ws).lte("check_out", we),
  ]);
  // 날짜 줄: 그날 남은 할 일 수 (미리 써 둔 것 포함)
  const leftOn = (d) => {
    const doneRefs = new Set((wRows || []).filter((r) => r.day === d && r.ref && r.done).map((r) => r.ref));
    let n = (wRows || []).filter((r) => r.day === d && !r.ref && !r.done).length;
    for (const b of (wBks || []).filter((b) => b.check_out === d && b.status !== "cancelled")) {
      const refs = [`out:${b.id}`];
      n += refs.filter((r) => !doneRefs.has(r)).length;
    }
    return n;
  };
  const strip = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const byRef = new Map((rows || []).filter((r) => r.ref).map((r) => [r.ref, r]));
  const items = [
    ...autoItems(bks || []).map((a) => ({ ...a, auto: true, row: byRef.get(a.ref) })),
    ...(rows || []).filter((r) => !r.ref).map((r) => ({ id: r.id, icon: "📌", title: r.title, sub: r.created_by ? `${r.created_by}` : "", row: r, cls: "manual" })),
  ];
  const isDone = (it) => !!it.row?.done;
  const isToday = day === kstToday();
  const left = items.filter((it) => !isDone(it)).length;
  const groups = [
    { key: "out", title: "호텔링 퇴실 · 결제", icon: "🏨", list: items.filter((it) => it.cls === "out") },
    { key: "pay", title: "결제 받기", icon: "💳", list: items.filter((it) => it.cls === "pay") },
    { key: "care", title: "목욕 · 미용", icon: "🛁", list: items.filter((it) => it.cls === "care") },
    { key: "manual", title: "할 일", icon: "📌", list: items.filter((it) => it.cls === "manual"), add: true },
  ];
  const sum = (list) => list.filter((it) => !isDone(it)).length;

  const isPast = day < t0;
  root.innerHTML = `
    <div class="tk-nav">
      <button class="icon" data-mv="-7" aria-label="일주일 전">«</button>
      <div class="tk-strip">${strip.map((d) => { const n = leftOn(d); return `<button data-go="${d}" class="${d === day ? "on" : ""} ${d === t0 ? "today" : ""} ${d < t0 ? "past" : ""}">
        <small>${d === t0 ? "오늘" : DOW[new Date(d + "T00:00:00Z").getUTCDay()]}</small><b>${+d.slice(8)}</b>${n ? `<i>${n}</i>` : `<i class="z"></i>`}</button>`; }).join("")}</div>
      <button class="icon" data-mv="7" aria-label="일주일 뒤">»</button>
      <label class="icon tk-pick" aria-label="날짜 고르기">📅<input type="date" id="tk-date" value="${day}"></label>
    </div>
    ${!isToday ? `<div class="tk-note ${isPast ? "past" : "future"}"><span>${isPast ? `지난 날 보드예요. 빠진 기록을 적거나 체크할 수 있어요.` : `미리 써 두는 보드예요. <b>${md(day)}</b>이 되면 첫 화면에 떠요.`}</span><button data-go="${t0}">오늘로 ›</button></div>` : ""}
    <div class="tk-top">
      <div><h2>${isToday ? "오늘 할 일" : `${md(day)} 할 일`}</h2><small class="muted">${md(day)}${isToday ? " · 오늘" : ""}</small></div>
      <div class="tk-ring ${items.length && !left ? "all" : ""}">${items.length ? (left ? `<b>${left}</b><small>남음</small>` : `<b>🎉</b><small>모두 끝</small>`) : `<b>0</b><small>할 일</small>`}</div>
    </div>
    ${groups.map((g) => {
      // 완료한 것도 지우지 않고 그 자리(맨 아래)에 체크된 채로 보여 줌
      const open = [...g.list.filter((it) => !isDone(it)), ...g.list.filter(isDone)];
      if (!open.length && !g.add) return "";
      return `<section class="tk-group ${g.key}">
        <h3><span>${g.icon} ${g.title}</span>${g.list.length ? `<em>${sum(g.list)}</em>` : ""}</h3>
        <ul class="tk-list">${open.map(itemHtml).join("") || (g.add ? "" : "")}</ul>
        ${g.add ? `<form class="tk-add" autocomplete="off"><input id="tk-new" maxlength="120" placeholder="${isToday ? "+ 할 일 추가 (예: 콩이 약 먹이기)" : `+ ${md(day)} 할 일 추가`}"><button class="btn primary sm">추가</button></form>` : ""}
      </section>`;
    }).join("")}
    `;

  $$("[data-go]", root).forEach((b) => b.addEventListener("click", () => { boardDay = b.dataset.go; renderTasks(C); }));
  $$("[data-mv]", root).forEach((b) => b.addEventListener("click", () => { boardDay = addDays(boardDay, +b.dataset.mv); renderTasks(C); }));
  $("#tk-date", root)?.addEventListener("change", (e) => { if (e.target.value) { boardDay = e.target.value; renderTasks(C); } });
  $$("[data-tk]", root).forEach((el) => el.addEventListener("change", () => toggle(items[+el.dataset.tk], el.checked)));
  $$("[data-del]", root).forEach((el) => el.addEventListener("click", async () => {
    const it = items[+el.dataset.del];
    if (!confirm(`'${it.title}' 할 일을 지울까요?`)) return;
    await C.sb.from("daily_tasks").delete().eq("id", it.id);
    renderTasks(C);
  }));
  $(".tk-add", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = $("#tk-new", root).value.trim();
    if (!v) return;
    $("#tk-new", root).value = "";
    const { error } = await C.sb.from("daily_tasks").insert({ day, title: v, created_by: await whoAmI() });
    if (error) { C.toast?.("추가하지 못했어요"); return; }
    renderTasks(C);
  });

  function itemHtml(it) {
    const i = items.indexOf(it);
    const d = isDone(it);
    const name = it.auto ? it.title.split(" · ").slice(1).join(" · ") : it.title;
    const kind = it.cls === "care" ? it.title.split(" · ")[0] : "";
    const meta = [kind && `${it.icon} ${kind}`, it.sub, d && `✓ ${it.row.done_by || ""} ${it.row.done_at ? hm(it.row.done_at) : ""}`.trim()].filter(Boolean).join(" · ");
    return `<li class="tk-item ${it.cls} ${d ? "done" : ""}">
      <label class="tk-check"><input type="checkbox" data-tk="${i}" ${d ? "checked" : ""}><span class="tk-box"></span></label>
      <div class="tk-main"><b class="tk-name">${esc(name)}</b>${meta ? `<small class="tk-sub">${esc(meta)}</small>` : ""}</div>
      ${it.money ? `<div class="tk-right"><b class="tk-money">${it.money}</b></div>` : ""}
      ${it.cls === "manual" ? `<button class="tk-del" data-del="${i}" aria-label="지우기">×</button>` : ""}
    </li>`;
  }
}

async function toggle(it, on) {
  const who = await whoAmI();
  const patch = { done: on, done_by: on ? who : null, done_at: on ? new Date().toISOString() : null };
  const q = it.auto
    ? C.sb.from("daily_tasks").upsert({ day: C.day, ref: it.ref, ...patch }, { onConflict: "day,ref" })
    : C.sb.from("daily_tasks").update(patch).eq("id", it.id);
  const { error } = await q;
  if (error) C.toast?.("저장하지 못했어요");
  renderTasks(C);
}
