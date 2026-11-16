// 픽드랍 (보호자가 pd.html?k=열쇠 링크로 요일을 고르면, 선생님은 요일별 목록을 봄)
// app.js 가 픽드랍 탭을 열 때 renderPickup(ctx) 로 부름
// 주가 시작된 뒤(그 주 월요일 0시 이후)에 추가·취소·메모 변경된 것은 노란색으로 강조

let C = null; // { sb, toast, esc, owner, root }
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DOW = ["", "월", "화", "수", "목", "금", "토", "일"];
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const isoDow = (d) => ((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7) + 1; // 1 월 ~ 7 일
const mondayOf = (d) => addDays(d, -(isoDow(d) - 1));
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
const digits = (s) => String(s || "").replace(/\D/g, "");
const when = (ts) => { if (!ts) return ""; const k = new Date(Date.parse(ts) + 9 * 3600e3); const d = k.toISOString().slice(0, 10); return `${DOW[isoDow(d)]} ${k.toISOString().slice(11, 16)}`; };
const linkOf = (t) => `${location.origin}${location.pathname.replace(/[^/]*$/, "")}pd.html?k=${t}`;
const SEEN_KEY = "pd-seen";
function toast(m, ms) { C?.toast?.(m, ms); }

const ps = { week: null, day: null, dogs: [], reqs: [], grid: false };

/* ================= 탭 빨간 점 ================= */
// 주가 시작된 뒤 바뀐 것 중, 이 기기에서 아직 픽드랍 탭을 안 본 것의 수
export async function pickupUnseen(sb) {
  let seen = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { /* 저장 안 되는 브라우저 */ }
  let q = sb.from("pd_log").select("id", { count: "exact", head: true }).gte("week_start", mondayOf(kstToday()));
  if (seen) q = q.gt("created_at", seen);
  const { count } = await q;
  return count || 0;
}
function markSeen() { try { localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* 괜찮음 */ } }

/* ================= 데이터 ================= */
// 유치원 명단에서 휴면·그만 다님인 아이는 픽드랍에서 뺌 (보호자 전화번호가 같고 이름이 맞는 아이로 찾음)
const nkey = (s) => String(s || "").replace(/\(.*?\)/g, "").replace(/[\s·/]/g, "").toLowerCase();
const pnum = (s) => String(s || "").replace(/\D/g, "");
function restingIds(dogs, members) {
  const byPhone = new Map();
  for (const m of members) for (const ph of new Set([m.phone, ...(m.owners || []).map((o) => o.phone)].map(pnum).filter((x) => x.length >= 10))) {
    if (!byPhone.has(ph)) byPhone.set(ph, []);
    byPhone.get(ph).push(m);
  }
  const out = new Set();
  for (const d of dogs) {
    if (d.dormant) { out.add(d.id); continue; }
    let ms = byPhone.get(pnum(d.phone)) || [];
    if (ms.length > 1) { const k = nkey(d.name); ms = ms.filter((m) => { const n = nkey(m.name); return k.startsWith(n) || n.startsWith(k); }); }
    if (ms.length && ms.every((m) => !m.active || m.dormant)) out.add(d.id);
  }
  return out;
}
async function load() {
  const [{ data: dogs }, { data: reqs }, { data: mem }] = await Promise.all([
    C.sb.from("pd_dogs").select("*").order("name"),
    C.sb.from("pd_requests").select("*").eq("week_start", ps.week),
    C.sb.from("kinder_members").select("name, phone, owners, active, dormant"),
  ]);
  const rest = restingIds(dogs || [], mem || []);
  ps.dogs = (dogs || []).filter((d) => !rest.has(d.id)); // 휴면·그만 다님은 안 보임
  ps.reqs = reqs || [];
  // 고정 요일 아이: 이번 주부터, 신청서가 없으면 고정 요일로 간 것으로 봄
  if (ps.week >= mondayOf(kstToday())) {
    const has = new Set(ps.reqs.map((r) => r.dog_id));
    for (const d of ps.dogs) {
      if (d.active && (d.fixed_days || []).length && !has.has(d.id))
        ps.reqs.push({ dog_id: d.id, days: [...d.fixed_days].sort(), memo: null, day_added: {}, day_removed: {}, fixed: true });
    }
  }
}
const fixedText = (dog) => ((dog?.fixed_days || []).length ? [...dog.fixed_days].sort().map((d) => DOW[d]).join("·") : "");
// 픽드랍 동선 순서 (아이 관리 → 동선 순서에서 바꿈). 순서가 없는 아이는 맨 뒤 가나다순
const byRoute = (a, b) => (a.dog.route_order ?? 9999) - (b.dog.route_order ?? 9999) || a.dog.name.localeCompare(b.dog.name, "ko");
const dogById = (id) => ps.dogs.find((d) => d.id === id);
const reqOf = (id) => ps.reqs.find((r) => r.dog_id === id);

/* ================= 화면 ================= */
export async function renderPickup(ctx) {
  C = ctx;
  const today = kstToday();
  if (!ps.week) {
    ps.week = isoDow(today) >= 6 ? addDays(mondayOf(today), 7) : mondayOf(today); // 토·일엔 다음 주부터 (링크 보내는 날)
    ps.day = ps.week === mondayOf(today) ? isoDow(today) : 1;
  }
  await load();
  draw();
  markSeen();
  ctx.onSeen?.();
}

function draw() {
  const root = C.root;
  const today = kstToday();
  const thisWeek = mondayOf(today);
  const wLabel = ps.week === thisWeek ? "이번 주" : ps.week === addDays(thisWeek, 7) ? "다음 주" : ps.week === addDays(thisWeek, -7) ? "지난주" : `${md(ps.week)} 주`;
  const dates = [1, 2, 3, 4, 5, 6, 7].map((d) => addDays(ps.week, d - 1));

  // 요일별: 가는 아이, 주중 추가(강조), 주중 취소
  const by = {};
  for (let d = 1; d <= 7; d++) {
    const on = [], cancelled = [];
    for (const r of ps.reqs) {
      const dog = dogById(r.dog_id);
      if (!dog) continue;
      if ((r.days || []).includes(d)) on.push({ r, dog, added: (r.day_added || {})[d] });
      else if ((r.day_removed || {})[d]) cancelled.push({ r, dog, at: r.day_removed[d] });
    }
    on.sort(byRoute);
    by[d] = { on, cancelled };
  }
  const answered = new Set(ps.reqs.map((r) => r.dog_id));
  const missing = ps.dogs.filter((d) => d.active && d.kind !== "occasional" && !answered.has(d.id)); // 가끔 오는 아이는 신청 안 해도 안 띄움
  const occ = ps.dogs.filter((d) => d.active && d.kind === "occasional"); // 가끔(1회성) 아이는 모두 아래에 따로 (이번 주 오는 아이는 요일 표시)
  const occDays = (d) => (reqOf(d.id)?.days || []).map((x) => DOW[x]).join("·");

  root.innerHTML = `
    <div class="pk-head card">
      <div class="pk-week">
        <button class="icon" data-wk="-7" aria-label="전 주">‹</button>
        <div class="grow"><b>${wLabel}</b><small>${md(ps.week)} ~ ${md(addDays(ps.week, 6))}</small></div>
        <button class="icon" data-wk="7" aria-label="다음 주">›</button>
      </div>
    </div>

    <div class="pk-tools">
      <span id="pk-push"></span>
      <span class="grow"></span>
      <button class="btn ghost sm" id="pk-quick">+ 아이 바로 추가</button>
      ${C.owner ? `<button class="btn primary sm" id="pk-group">📢 단체 링크 복사</button><button class="btn ghost sm" id="pk-manage">아이 관리</button>` : ""}
    </div>

    <section class="card pk-board-wrap"><div class="pk-board">${dates.map((dt, i) => {
      const d = i + 1, x = by[d];
      return `<div class="pk-col ${dt === today ? "today" : ""} ${d >= 6 ? "we" : ""}" ${dt === today ? 'id="pk-today"' : ""}>
        <div class="pk-col-h"><b>${DOW[d]}</b><small>${md(dt)}</small><em>${x.on.length}</em></div>
        <div class="pk-col-b">
          ${x.on.map(({ r, dog, added }, j) => `<button class="pk-n ${added ? "add" : ""} ${r.memo_changed_at ? "memo" : ""}" data-dog="${dog.id}" title="${added ? `${when(added)} 추가` : ""}">
            <span>${esc(dog.name)}</span>${modeTag((r.day_mode || {})[d])}${r.fixed ? `<i class="pk-fx" title="고정">📌</i>` : ""}${r.memo ? `<i class="pk-mi ${r.memo_changed_at ? "new" : ""}" data-memo="${dog.id}" aria-label="메모 보기">📝</i>` : ""}</button>`).join("")}
          ${x.cancelled.map(({ dog, at }) => `<button class="pk-n x" data-dog="${dog.id}" title="${when(at)} 취소"><span>${esc(dog.name)}</span></button>`).join("")}
        </div>
      </div>`;
    }).join("")}</div></section>

    <section class="card pk-miss">
      <h2>${wLabel} 아직 신청 안 한 정기 아이 <small class="muted">${missing.length}마리</small></h2>
      ${C.owner && missing.length ? `<button class="btn primary sm pk-send-btn" id="pk-send-miss">📨 신청 안 한 ${missing.length}마리에게 링크 보내기</button>` : ""}
      ${!ps.dogs.length ? `<p class="muted small">${C.owner ? "‘아이 관리’에서 픽드랍 이용하는 아이를 먼저 등록해 주세요." : "아직 등록된 아이가 없어요."}</p>`
        : missing.length ? `<div class="pk-chips">${missing.map((d) => `<button data-dog="${d.id}">${esc(d.name)}</button>`).join("")}</div>`
        : `<p class="muted small">모두 신청했어요 👍</p>`}
      ${occ.length ? `<div class="pk-occ"><h3>가끔(1회성) 왔던 아이 <small class="muted">${occ.length}마리 · 이번 주에 오면 눌러서 요일을 넣어 주세요</small></h3>
        <div class="pk-chips">${occ.map((d) => `<button data-dog="${d.id}" class="${occDays(d) ? "on" : ""}">${esc(d.name)}${occDays(d) ? ` <small>${occDays(d)}</small>` : ""}</button>`).join("")}</div></div>` : ""}
    </section>
    <p class="small pk-legend"><b>월요일부터 바뀐 것</b> &nbsp;<em class="pk-tag add">초록 = 추가</em> <em class="pk-tag x">빨강 = 취소</em> <em class="pk-tag memo">보라 = 메모 바뀜</em> &nbsp;· 📝 메모 있음(누르면 보여요)</p>`;

  $$("[data-wk]", root).forEach((b) => b.addEventListener("click", async () => { ps.week = addDays(ps.week, +b.dataset.wk); ps.day = ps.week === mondayOf(kstToday()) ? isoDow(kstToday()) : 1; await load(); draw(); }));
  $$("[data-dog]", root).forEach((b) => b.addEventListener("click", () => openDog(b.dataset.dog)));
  $$("[data-memo]", root).forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openMemo(b.dataset.memo); }));
  $$(".pk-col-b", root).forEach((col) => makeSortable(col, ".pk-n:not(.x)", { onDrop: dropOnBoard }));
  $("#pk-manage", root)?.addEventListener("click", openManage);
  $("#pk-quick", root)?.addEventListener("click", openQuick);
  $("#pk-group", root)?.addEventListener("click", copyGroup);
  $("#pk-send-miss", root)?.addEventListener("click", () => openSender(missing, `${wLabel} 신청 링크 보내기`));
  drawPushBtn();
  // 폰에서는 오늘 칸이 보이게
  const tc = $("#pk-today", root), wrap = $(".pk-board-wrap", root);
  if (tc && wrap && wrap.scrollWidth > wrap.clientWidth) wrap.scrollLeft = Math.max(0, tc.offsetLeft - 8);
}

function rowHtml(dog, r, added) {
  const memoNew = !!r.memo_changed_at;
  return `<div class="pk-row ${added ? "added" : ""}" data-dog="${dog.id}" role="button" tabindex="0">
    <span class="grow"><b>${esc(dog.name)}</b>${added ? ` <em class="pk-tag add">추가 ${when(added)}</em>` : ""}
      <small>${esc([dog.owner_name, dog.address].filter(Boolean).join(" · ")) || "&nbsp;"}</small></span>
    ${r.memo ? `<button class="pk-memo ${memoNew ? "new" : ""}" data-memo="${dog.id}" aria-label="메모 보기">📝</button>` : ""}
  </div>`;
}

function gridHtml(dates) {
  const rows = ps.reqs
    .map((r) => ({ r, dog: dogById(r.dog_id) }))
    .filter((x) => x.dog && ((x.r.days || []).length || Object.keys(x.r.day_removed || {}).length))
    .sort((a, b) => a.dog.name.localeCompare(b.dog.name, "ko"));
  const total = (d) => ps.reqs.filter((r) => (r.days || []).includes(d)).length;
  return `<section class="card pk-grid-wrap"><table class="pk-grid">
    <thead><tr><th></th>${dates.map((dt, i) => `<th class="${i >= 5 ? "we" : ""}">${DOW[i + 1]}<small>${md(dt)}</small></th>`).join("")}</tr></thead>
    <tbody>${rows.length ? rows.map(({ r, dog }) => `<tr>
      <th><button data-dog="${dog.id}">${esc(dog.name)}</button>${r.memo ? `<button class="pk-memo sm ${r.memo_changed_at ? "new" : ""}" data-memo="${dog.id}" aria-label="메모 보기">📝</button>` : ""}</th>
      ${[1, 2, 3, 4, 5, 6, 7].map((d) => (r.days || []).includes(d)
        ? `<td class="${(r.day_added || {})[d] ? "add" : "on"}">●</td>`
        : (r.day_removed || {})[d] ? `<td class="x">✕</td>` : `<td></td>`).join("")}
    </tr>`).join("") : `<tr><td colspan="8" class="muted small">신청이 없어요</td></tr>`}</tbody>
    <tfoot><tr><th>합계</th>${[1, 2, 3, 4, 5, 6, 7].map((d) => `<td>${total(d) || ""}</td>`).join("")}</tr></tfoot>
  </table></section>`;
}

/* ================= 창 ================= */
function modal(html, cls = "") {
  const ov = document.createElement("div");
  ov.className = "rc-overlay";
  ov.innerHTML = `<div class="rc-box pk-box ${cls}">${html}</div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  $$("[data-close]", ov).forEach((b) => b.addEventListener("click", close));
  return { ov, close };
}
const kv = (k, v) => (v ? `<div class="ho-kv"><span>${k}</span><b>${v}</b></div>` : "");

function openMemo(id) {
  const dog = dogById(id), r = reqOf(id);
  if (!dog || !r) return;
  modal(`<div class="rc-head"><b class="grow">📝 ${esc(dog.name)} 메모</b><button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body"><p class="pk-memo-text">${esc(r.memo)}</p>
    ${r.memo_changed_at ? `<p class="small"><em class="pk-tag memo">메모 바뀜 ${when(r.memo_changed_at)}</em></p>` : ""}</div>`);
}

function openDog(id) {
  const dog = dogById(id);
  if (!dog) return;
  const r = reqOf(id);
  const days = r?.days || [];
  const { ov, close } = modal(`
    <div class="rc-head"><div class="grow"><b class="ho-title">${esc(dog.name)}</b><small class="muted">${md(ps.week)} ~ ${md(addDays(ps.week, 6))} 픽드랍</small></div>
      <button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">
      <div class="pk-kindrow"><span>구분</span><div class="pk-seg" id="pk-kind">${kindBtns(dog.kind === "occasional" ? "occasional" : "regular")}</div><small class="muted pk-kind-msg"></small></div>
      <h3 class="pk-h3">요일 ${r?.fixed ? `<small class="muted">📌 고정 요일 (${fixedText(dog)})</small>` : r ? "" : `<small class="muted">아직 신청 안 함</small>`}</h3>
      <div class="pk-pick">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<button data-p="${d}" class="${days.includes(d) ? "on" : ""} ${(r?.day_added || {})[d] ? "add" : ""}">${DOW[d]}</button>`).join("")}</div>
      <div class="pk-modes" id="pk-modes"></div>
      <h3 class="pk-h3">메모</h3>
      <textarea id="pk-memo" maxlength="300" rows="3" placeholder="예) 9시 전에 와 주세요">${esc(r?.memo || "")}</textarea>
      ${r?.memo_changed_at ? `<p class="small"><em class="pk-tag memo">메모 바뀜 ${when(r.memo_changed_at)}</em></p>` : ""}
      <h3 class="pk-h3">보호자</h3>
      ${kv("이름", esc(dog.owner_name))}
      ${kv("전화", dog.phone ? `<a href="tel:${esc(digits(dog.phone))}">${esc(dog.phone)}</a>` : "")}
      ${kv("주소", esc(dog.address))}
      ${kv("선생님 메모", esc(dog.note))}
      ${!dog.owner_name && !dog.phone && !dog.address && !dog.note ? `<p class="muted small">정보가 없어요${C.owner ? " (아이 관리에서 넣을 수 있어요)" : ""}</p>` : ""}
      ${r && !r.fixed ? `<p class="muted small">${r.by_staff ? "직원이 마지막으로 수정" : "보호자가 신청"} · ${when(r.updated_at)}</p>` : ""}
    </div>
    <div class="rc-foot">
      ${C.owner ? `${sendBtns(dog)}<button class="btn ghost mini" data-copy>복사</button><span class="grow"></span>` : ""}
      <button class="btn primary sm" data-save>요일·메모 저장</button>
    </div>`);
  const pick = new Set(days);
  const mode = { ...(r?.day_mode || {}) };
  const drawModes = () => drawModeRows($("#pk-modes", ov), pick, mode);
  drawModes();
  $$("[data-p]", ov).forEach((b) => b.addEventListener("click", () => { const d = +b.dataset.p; pick.has(d) ? pick.delete(d) : pick.add(d); b.classList.toggle("on", pick.has(d)); drawModes(); }));
  $("[data-copy]", ov)?.addEventListener("click", () => copyInvite(dog));
  // 정기 / 가끔: 누르면 바로 저장
  $$("#pk-kind [data-kind]", ov).forEach((b) => b.addEventListener("click", async () => {
    const kind = b.dataset.kind;
    if (kind === (dog.kind === "occasional" ? "occasional" : "regular")) return;
    $$("#pk-kind [data-kind]", ov).forEach((x) => x.classList.toggle("on", x === b));
    const { error } = await C.sb.from("pd_dogs").update({ kind }).eq("id", dog.id);
    if (error) { toast("바꾸지 못했어요"); return; }
    dog.kind = kind;
    $(".pk-kind-msg", ov).textContent = kind === "occasional" ? "가끔(1회성)으로 바꿨어요" : "정기로 바꿨어요";
    draw();
  }));
  bindSend(ov);
  $("[data-save]", ov).addEventListener("click", async (e) => {
    e.target.disabled = true;
    const { data, error } = await C.sb.functions.invoke("pd", { body: { action: "save", dog_id: dog.id, week_start: ps.week, days: [...pick], memo: $("#pk-memo", ov).value, day_mode: Object.fromEntries([...pick].filter((d) => mode[d]).map((d) => [d, mode[d]])) } });
    if (error || data?.error) { toast(data?.error || "저장하지 못했어요"); e.target.disabled = false; return; }
    toast("저장했어요");
    close();
    await load(); draw();
  });
}

/* ================= 정기 / 가끔 ================= */
// 요일별 픽업만(p) / 드랍만(d) — 없으면 픽업·드랍 둘 다
const MODE = { p: "픽업만", d: "드랍만" };
const modeTag = (m) => (m ? `<i class="pk-md ${m}">${MODE[m]}</i>` : "");
function drawModeRows(box, pick, mode) {
  const ds = [...pick].sort((a, b) => a - b);
  box.innerHTML = ds.length ? ds.map((d) => `<div class="pk-mode"><b>${DOW[d]}</b>${[["", "픽업·드랍"], ["p", "픽업만"], ["d", "드랍만"]].map(([v, l]) => `<button type="button" data-md="${d}" data-v="${v}" class="${(mode[d] || "") === v ? "on" : ""}">${l}</button>`).join("")}</div>`).join("") : "";
  $$("[data-md]", box).forEach((b) => b.addEventListener("click", () => { const d = b.dataset.md; if (b.dataset.v) mode[d] = b.dataset.v; else delete mode[d]; drawModeRows(box, pick, mode); }));
}
const kindBtns = (k) => [["regular", "정기"], ["occasional", "가끔 (1회성)"]].map(([v, l]) => `<button type="button" data-kind="${v}" class="${k === v ? "on" : ""}">${l}</button>`).join("");
const bindKind = (ov) => $$("[data-kind]", ov).forEach((b) => b.addEventListener("click", () => { $$("[data-kind]", ov).forEach((x) => x.classList.toggle("on", x === b)); }));

/* ================= 아이 바로 추가 (이름·요일만, 정보는 나중에) ================= */
function openQuick() {
  const { ov, close } = modal(`
    <div class="rc-head"><div class="grow"><b>+ 아이 바로 추가</b><small class="muted">${md(ps.week)} ~ ${md(addDays(ps.week, 6))} · 이름과 요일만 넣고 나머지 정보는 나중에 채워도 돼요</small></div>
      <button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">
      <label class="pk-f"><span>이름 *</span><input id="pk-q-name" placeholder="예) 콩이  /  같은 이름이 있으면 견종도: 콩이 푸들"></label>
      <p class="small pk-q-dup" hidden></p>
      <div class="pk-f"><span>구분</span><div class="pk-seg" id="pk-kind">${kindBtns("occasional")}</div></div>
      <div class="pk-f"><span>이번 주 요일</span><div class="pk-pick" id="pk-q-days">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<button type="button" data-p="${d}">${DOW[d]}</button>`).join("")}</div></div>
      <label class="pk-f"><span>메모 <small class="muted">(선택)</small></span><input id="pk-q-memo" maxlength="300" placeholder="예) 오전 픽업만"></label>
    </div>
    <div class="rc-foot"><span class="grow"></span><button class="btn primary sm" data-save>추가</button></div>`);
  bindKind(ov);
  $$("[data-p]", ov).forEach((b) => b.addEventListener("click", () => b.classList.toggle("on")));
  const nameIn = $("#pk-q-name", ov), dup = $(".pk-q-dup", ov);
  nameIn.focus();
  nameIn.addEventListener("input", () => {
    const k = nkey(nameIn.value);
    const same = k ? ps.dogs.filter((d) => nkey(d.name) === k || nkey(d.name).startsWith(k)) : [];
    dup.hidden = !same.length;
    dup.innerHTML = same.length ? `이미 있는 아이: ${same.map((d) => `<button type="button" class="btn ghost mini" data-pickdog="${d.id}">${esc(d.name)}</button>`).join(" ")} <span class="muted">같은 아이면 눌러서 요일만 넣으세요</span>` : "";
    $$("[data-pickdog]", dup).forEach((b) => b.addEventListener("click", () => { close(); openDog(b.dataset.pickdog); }));
  });
  $("[data-save]", ov).addEventListener("click", async (e) => {
    const name = nameIn.value.trim();
    if (!name) { toast("이름을 넣어 주세요"); nameIn.focus(); return; }
    const days = $$("#pk-q-days .on", ov).map((b) => +b.dataset.p);
    e.target.disabled = true;
    const kind = $("#pk-kind .on", ov)?.dataset.kind || "occasional";
    const { data: dog, error } = await C.sb.from("pd_dogs").insert({ name, kind }).select().single();
    if (error) { toast("추가하지 못했어요"); e.target.disabled = false; return; }
    if (days.length) {
      const { data, error: e2 } = await C.sb.functions.invoke("pd", { body: { action: "save", dog_id: dog.id, week_start: ps.week, days, memo: $("#pk-q-memo", ov).value } });
      if (e2 || data?.error) toast("아이는 추가했는데 요일을 저장하지 못했어요");
    }
    close();
    toast(`${name} 추가했어요 · 보호자 정보는 아이 관리 → 수정에서 채워 주세요`, 4000);
    await load(); draw();
  });
}

/* ================= 동선 순서 ================= */
// 유치원(동백죽전대로 217)에서 출발해 도는 순서. ▲▼로 옮김
function openRoute() {
  const list = ps.dogs.filter((d) => d.active).map((d) => ({ ...d })).sort((a, b) => byRoute({ dog: a }, { dog: b }));
  const { ov, close } = modal(`
    <div class="rc-head"><div class="grow"><b>🚗 픽드랍 동선 순서</b><small class="muted">유치원(동백죽전대로 217)에서 출발하는 순서 · 요일별 목록이 이 순서로 나와요</small></div>
      <button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body" id="pk-route-body"><div class="pk-route" id="pk-route"></div></div>
    <div class="rc-foot"><span class="grow small muted">아이를 꾹 눌러서 위아래로 끌어 옮긴 뒤 저장하세요</span><button class="btn primary sm" data-save>저장</button></div>`, "wide");
  const box = $("#pk-route", ov), body = $("#pk-route-body", ov);
  box.innerHTML = list.map((d) => `<div class="pk-rt" data-id="${d.id}"><em></em><span class="grow"><b>${esc(d.name)}</b><small class="muted">${esc(d.address || "주소 없음")}</small></span><i class="pk-rt-h" aria-hidden="true">≡</i></div>`).join("");
  const renum = () => $$(".pk-rt", box).forEach((r, k) => (r.querySelector("em").textContent = k + 1));
  renum();

  makeSortable(box, ".pk-rt", { scroller: body, handle: ".pk-rt-h", onMove: renum });

  $("[data-save]", ov).addEventListener("click", async (e) => {
    e.target.disabled = true;
    const ids = $$(".pk-rt", box).map((r) => r.dataset.id);
    const res = await Promise.all(ids.map((id, k) => C.sb.from("pd_dogs").update({ route_order: k + 1 }).eq("id", id)));
    if (res.some((r) => r.error)) { toast("저장하지 못했어요"); e.target.disabled = false; return; }
    toast("동선 순서를 저장했어요"); close(); await load(); draw();
  });
}

/* ================= 꾹 눌러 끌어서 순서 바꾸기 (손가락·마우스) ================= */
// box 안의 itemSel 들을 0.3초 꾹 누르면 집어서 위아래로 옮김. handle 은 바로 집힘. 끈 뒤에는 click 이 안 눌리게 막음
function makeSortable(box, itemSel, { scroller = null, handle = null, onMove = null, onDrop = null } = {}) {
  let row = null, timer = null, dragging = false, moved = false, sx = 0, sy = 0, lastY = 0, raf = null;
  const items = () => $$(itemSel, box);
  const start = (r) => { dragging = true; moved = false; row = r; r.classList.add("drag"); box.classList.add("dragging"); navigator.vibrate?.(15); edgeScroll(); };
  const moveTo = (y) => {
    lastY = y;
    let target = null;
    for (const x of items()) { if (x === row) continue; const b = x.getBoundingClientRect(); if (y < b.top + b.height / 2) { target = x; break; } }
    const before = row.nextElementSibling;
    if (target) { if (row.nextElementSibling !== target) box.insertBefore(row, target); }
    else { const last = items().filter((x) => x !== row).pop(); if (last && last.nextElementSibling !== row) last.after(row); }
    if (row.nextElementSibling !== before) { moved = true; onMove?.(); }
  };
  const edgeScroll = () => {
    if (!dragging) return;
    const sc = scroller || document.scrollingElement;
    const b = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    const dy = lastY < b.top + 50 ? -10 : lastY > b.bottom - 50 ? 10 : 0;
    if (dy) { sc.scrollTop += dy; moveTo(lastY); }
    raf = requestAnimationFrame(edgeScroll);
  };
  const end = () => {
    clearTimeout(timer); timer = null;
    cancelAnimationFrame(raf);
    if (!dragging) return;
    const r = row; dragging = false; row = null;
    r.classList.remove("drag"); box.classList.remove("dragging");
    // 끈 직후 click(아이 열기)이 같이 눌리지 않게
    const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
    r.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => r.removeEventListener("click", stop, { capture: true }), 400);
    if (moved) onDrop?.(r);
  };
  const down = (x, y, target) => {
    const r = target.closest(itemSel); if (!r || !box.contains(r)) return;
    sx = x; sy = y; lastY = y;
    if (handle && target.closest(handle)) { start(r); return; }
    timer = setTimeout(() => start(r), 300);
  };
  const move = (x, y, e) => {
    if (dragging) { e.preventDefault(); moveTo(y); return; }
    if (timer && (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8)) { clearTimeout(timer); timer = null; } // 그냥 스크롤
  };
  box.addEventListener("touchstart", (e) => { const t = e.touches[0]; down(t.clientX, t.clientY, e.target); }, { passive: true });
  box.addEventListener("touchmove", (e) => { const t = e.touches[0]; move(t.clientX, t.clientY, e); }, { passive: false });
  box.addEventListener("touchend", end); box.addEventListener("touchcancel", end);
  box.addEventListener("contextmenu", (e) => { if (e.target.closest(itemSel)) e.preventDefault(); });
  box.addEventListener("mousedown", (e) => {
    if (e.button || !e.target.closest(itemSel)) return;
    down(e.clientX, e.clientY, e.target);
    const mm = (ev) => { if (dragging) ev.preventDefault(); move(ev.clientX, ev.clientY, ev); };
    const mu = () => { end(); removeEventListener("mousemove", mm); removeEventListener("mouseup", mu); };
    addEventListener("mousemove", mm); addEventListener("mouseup", mu);
  });
}

// 요일 칸에서 옮기면 전체 동선 순서에 반영: 바로 위 아이 다음(맨 위면 바로 아래 아이 앞)으로
async function dropOnBoard(el) {
  const id = el.dataset.dog;
  const prev = el.previousElementSibling?.closest?.(".pk-n:not(.x)") ? el.previousElementSibling.dataset.dog : null;
  let next = null; for (let n = el.nextElementSibling; n; n = n.nextElementSibling) if (n.matches(".pk-n:not(.x)")) { next = n.dataset.dog; break; }
  const order = ps.dogs.filter((d) => d.active).sort((a, b) => byRoute({ dog: a }, { dog: b })).map((d) => d.id).filter((x) => x !== id);
  let at = prev ? order.indexOf(prev) + 1 : next ? order.indexOf(next) : order.length;
  if (at < 0) at = order.length;
  order.splice(at, 0, id);
  const changed = order.map((d, k) => [d, k + 1]).filter(([d, k]) => dogById(d)?.route_order !== k);
  changed.forEach(([d, k]) => (dogById(d).route_order = k));
  draw();
  const res = await Promise.all(changed.map(([d, k]) => C.sb.from("pd_dogs").update({ route_order: k }).eq("id", d)));
  toast(res.some((r) => r.error) ? "순서를 저장하지 못했어요" : "동선 순서를 바꿨어요");
}

async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { prompt("복사해 주세요", text); }
}
// 모두에게 같은 링크 하나 (보호자가 아이를 고르고 전화번호 뒷자리로 확인)
async function copyGroup() {
  const { data, error } = await C.sb.functions.invoke("pd", { body: { action: "group" } });
  if (error || !data?.key) { toast("링크를 만들지 못했어요"); return; }
  const url = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}pd.html?g=${data.key}`;
  copyText(`[댕겨올개] 다음 주 픽드랍 요일을 확정해 주세요 🚗\n아래 링크에서 보호자 전화번호를 넣으면 우리 아이가 나와요. 필요한 요일을 눌러 확정하면 돼요.\n확정한 뒤에도 같은 링크에서 언제든 예약·수정할 수 있어요.\n일요일 오후 6시까지 확정해 주시고, 주중에 바꾸시면 카톡으로도 꼭 알려 주세요!\n${url}`,
    "단체 안내문과 링크를 복사했어요. 단톡방이나 공지에 붙여 넣으세요");
}
const inviteText = (dog) => `[댕겨올개] ${dog.name} 픽드랍 신청 링크예요 🚗\n매주 일요일 오후 6시까지 다음 주 요일을 골라 확정해 주세요. 같은 링크에서 언제든 예약·수정할 수 있어요!\n(주중에 바꾸시면 카톡으로도 꼭 알려 주세요)\n${linkOf(dog.token)}`;
function copyInvite(dog) {
  copyText(inviteText(dog), `${dog.name.split("/")[0].trim()} 보호자 안내문과 링크를 복사했어요`);
}
const SENT_KEY = () => `pd-sent-${ps.week}`;
const sentSet = () => { try { return new Set(JSON.parse(localStorage.getItem(SENT_KEY()) || "[]")); } catch { return new Set(); } };
function markSent(id) { const s = sentSet(); s.add(id); try { localStorage.setItem(SENT_KEY(), JSON.stringify([...s])); } catch { /* 괜찮음 */ } }
// 카톡 등 앱 고르기 (폰 공유 창) → 안 되면 복사
async function shareInvite(dog) {
  if (navigator.share) {
    try { await navigator.share({ text: inviteText(dog) }); markSent(dog.id); return true; }
    catch (e) { if (e?.name === "AbortError") return false; }
  }
  copyInvite(dog); markSent(dog.id); return true;
}
// 문자 앱을 받는 사람·내용 채워서 열기
function smsInvite(dog) {
  const num = digits(dog.phone);
  if (!num) { toast("전화번호가 없어요"); return; }
  const body = encodeURIComponent(inviteText(dog));
  markSent(dog.id);
  location.href = isIOS() ? `sms:${num}&body=${body}` : `sms:${num}?body=${body}`;
}
const sendBtns = (d) => `<button class="btn primary mini" data-share="${d.id}">카톡 보내기</button>${digits(d.phone) ? `<button class="btn ghost mini" data-sms="${d.id}">문자</button>` : ""}`;
function bindSend(ov, after) {
  $$("[data-share]", ov).forEach((b) => b.addEventListener("click", async () => { if (await shareInvite(dogById(b.dataset.share))) after?.(b.dataset.share); }));
  $$("[data-sms]", ov).forEach((b) => b.addEventListener("click", () => { smsInvite(dogById(b.dataset.sms)); after?.(b.dataset.sms); }));
}

// 아이 검색: 이름·보호자·전화번호(숫자만 쳐도 됨)로 목록 거르기
const qOf = (d) => `${d.name} ${d.owner_name || ""} ${digits(d.phone)}`.toLowerCase().replace(/\s+/g, "");
const searchBox = () => `<input class="pk-search" type="search" placeholder="🔍 아이 이름·보호자·전화번호 검색" autocomplete="off">`;
function applySearch(ov) {
  const inp = $(".pk-search", ov);
  const q = (inp?.value || "").toLowerCase().replace(/[\s-]+/g, "");
  let n = 0;
  $$(".pk-mrow[data-q]", ov).forEach((r) => { const hit = !q || r.dataset.q.includes(q); r.style.display = hit ? "" : "none"; if (hit) n++; });
  const none = $(".pk-none", ov);
  if (none) none.hidden = !q || n > 0;
}
function bindSearch(ov) {
  const inp = $(".pk-search", ov);
  inp?.addEventListener("input", () => applySearch(ov));
}

// 한 명씩 차례로 보내기 (보낸 아이는 ✓)
function openSender(list, title) {
  const draw = (ov) => {
    const sent = sentSet();
    $(".pk-send", ov).innerHTML = list.map((d) => `<div class="pk-mrow ${sent.has(d.id) ? "sent" : ""}" data-q="${esc(qOf(d))}">
      <span class="grow"><b>${sent.has(d.id) ? "✓ " : ""}${esc(d.name)}</b><small class="muted">${esc([d.owner_name, d.phone].filter(Boolean).join(" · ")) || "연락처 없음"}</small></span>
      ${sendBtns(d)}</div>`).join("") + (list.length ? `<p class="muted small pk-none" hidden>찾는 아이가 없어요.</p>` : `<p class="muted small">보낼 아이가 없어요.</p>`);
    applySearch(ov);
    $(".pk-send-count", ov).textContent = `${list.filter((d) => sent.has(d.id)).length} / ${list.length} 보냄`;
    bindSend(ov, () => setTimeout(() => draw(ov), 400));
  };
  const { ov } = modal(`
    <div class="rc-head"><div class="grow"><b>${title}</b><small class="muted pk-send-count"></small></div><button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">
      <p class="muted small">‘카톡 보내기’를 누르면 공유 창이 떠요 → 카카오톡 → 보호자를 골라 보내면 돼요. ‘문자’는 받는 사람과 내용이 채워진 채로 문자 앱이 열려요. 보낸 아이는 ✓ 표시돼요.</p>
      ${list.length > 5 ? searchBox() : ""}
      <div class="pk-send"></div>
    </div>`, "wide");
  bindSearch(ov);
  draw(ov);
}

/* ================= 아이 관리 (최고 관리자) ================= */
function openManage() {
  const { ov, close } = modal(`
    <div class="rc-head"><b class="grow">픽드랍 아이 관리</b><button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">
      <div class="pk-tools"><button class="btn primary sm" data-new>+ 아이 추가</button><button class="btn ghost sm" data-route>🚗 동선 순서</button><button class="btn ghost sm" data-sendall>📨 전체 보내기</button><button class="btn ghost sm" data-all>링크 전체 복사</button></div>
      <p class="muted small">아이마다 보호자 전용 링크가 있어요. ‘카톡 보내기’나 ‘문자’로 보호자에게 보내 주세요. 매주 같은 링크라 한 번 받은 보호자는 그 링크로 계속 들어오면 돼요.</p>
      ${searchBox()}
      <div class="pk-manage">${[["occasional", "가끔 오는 아이"], ["regular", "정기로 오는 아이"]].map(([k, label]) => {
        const g = ps.dogs.filter((d) => (d.kind === "occasional" ? "occasional" : "regular") === k);
        return g.length ? `<h3 class="pk-mh">${label} <small class="muted">${g.length}</small></h3>` + g.map((d) => `<div class="pk-mrow ${d.active ? "" : "off"}" data-q="${esc(qOf(d))}">
        <span class="grow"><b>${esc(d.name)}</b>${fixedText(d) ? ` <span class="pk-fxtag">📌 ${fixedText(d)}</span>` : ""}${d.active ? "" : ` <span class="tag off">꺼짐</span>`}<small class="muted">${esc([d.owner_name, d.phone].filter(Boolean).join(" · "))}</small></span>
        ${d.active ? sendBtns(d) : ""}
        <button class="btn ghost mini" data-ed="${d.id}">수정</button>
      </div>`).join("") : "";
      }).join("") || `<p class="muted small">아직 없어요.</p>`}<p class="muted small pk-none" hidden>찾는 아이가 없어요.</p></div>
    </div>`, "wide");
  bindSearch(ov);
  $("[data-new]", ov).addEventListener("click", () => { close(); openDogForm(null); });
  $("[data-route]", ov).addEventListener("click", () => { close(); openRoute(); });
  $("[data-all]", ov).addEventListener("click", () => {
    const list = ps.dogs.filter((d) => d.active);
    copyText(list.map((d) => `${d.name}\n${linkOf(d.token)}`).join("\n\n"), `${list.length}마리 링크를 복사했어요. 메모장 등에 붙여 두고 쓰세요`);
  });
  bindSend(ov);
  $("[data-sendall]", ov).addEventListener("click", () => { close(); openSender(ps.dogs.filter((d) => d.active), "전체 보호자에게 링크 보내기"); });
  $$("[data-ed]", ov).forEach((b) => b.addEventListener("click", () => { close(); openDogForm(dogById(b.dataset.ed)); }));
}

function openDogForm(dog) {
  const f = (k, label, ph = "") => `<label class="pk-f"><span>${label}</span><input data-f="${k}" value="${esc(dog?.[k] || "")}" placeholder="${ph}"></label>`;
  const { ov, close } = modal(`
    <div class="rc-head"><b class="grow">${dog ? "아이 정보 수정" : "픽드랍 아이 추가"}</b><button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">
      ${f("name", "이름 *", "예) 콩이  /  다견은 비비/모모")}
      <div class="pk-f"><span>구분</span><div class="pk-seg" id="pk-kind">${kindBtns(dog?.kind || "regular")}</div></div>
      ${f("owner_name", "보호자")}
      ${f("phone", "전화", "010-0000-0000")}
      ${f("address", "주소", "픽드랍 주소")}
      ${f("note", "선생님 메모", "공동현관 비번, 주차 위치 등 (보호자에겐 안 보여요)")}
      <div class="pk-f"><span>고정 요일 <small class="muted">매주 같은 요일이면 골라 두세요. 신청 안 해도 이 요일로 들어가요 (그 주만 바꾸면 그 주만 바뀜)</small></span>
        <div class="pk-pick" id="pk-fixed">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<button type="button" data-fx="${d}" class="${(dog?.fixed_days || []).includes(d) ? "on" : ""}">${DOW[d]}</button>`).join("")}</div></div>
      ${dog ? `<label class="pk-check"><input type="checkbox" data-active ${dog.active ? "checked" : ""}> 링크 켜기 (끄면 보호자 링크가 막히고 목록에서 빠져요)</label>` : ""}
    </div>
    <div class="rc-foot">
      ${dog ? `<button class="btn ghost sm danger" data-del>삭제</button><span class="grow"></span>` : ""}
      <button class="btn primary sm" data-save>저장</button>
    </div>`);
  $$("[data-fx]", ov).forEach((b) => b.addEventListener("click", () => b.classList.toggle("on")));
  bindKind(ov);
  $("[data-save]", ov).addEventListener("click", async () => {
    const row = {};
    row.kind = $("#pk-kind .on", ov)?.dataset.kind || "regular";
    $$("[data-f]", ov).forEach((i) => (row[i.dataset.f] = i.value.trim() || null));
    if (!row.name) { toast("이름을 넣어 주세요"); return; }
    row.fixed_days = $$("[data-fx].on", ov).map((b) => +b.dataset.fx).sort();
    if (dog) row.active = $("[data-active]", ov).checked;
    const q = dog ? C.sb.from("pd_dogs").update(row).eq("id", dog.id).select().single() : C.sb.from("pd_dogs").insert(row).select().single();
    const { data, error } = await q;
    if (error) { toast("저장하지 못했어요"); return; }
    close();
    await load(); draw();
    if (!dog) { toast("추가했어요"); openSender([data], `${data.name} 링크 보내기`); }
    else openManage();
  });
  $("[data-del]", ov)?.addEventListener("click", async () => {
    if (!confirm(`'${dog.name}'을(를) 픽드랍 목록에서 삭제할까요?\n지금까지 신청 기록도 지워지고, 보호자 링크도 막혀요. 되돌릴 수 없어요.\n(잠깐 쉬는 거면 ‘링크 켜기’만 끄세요)`)) return;
    const { error } = await C.sb.from("pd_dogs").delete().eq("id", dog.id);
    if (error) { toast("삭제하지 못했어요"); return; }
    close(); await load(); draw(); openManage();
  });
}

/* ================= 폰 알림 ================= */
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const b64u = (s) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };

async function pushState() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return isIOS() && !standalone() ? "ios-browser" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}
async function drawPushBtn() {
  const el = $("#pk-push", C.root);
  if (!el) return;
  const st = await pushState().catch(() => "unsupported");
  const label = { on: "🔔 알림 켜짐", off: "🔕 변경 알림 켜기", denied: "🔕 알림이 막혀 있어요", "ios-browser": "🔕 변경 알림 켜기", unsupported: "" }[st];
  el.innerHTML = label ? `<button class="btn ${st === "off" || st === "ios-browser" ? "primary" : "ghost"} sm">${label}</button>` : "";
  $("button", el)?.addEventListener("click", () => {
    if (st === "on") return testPush();
    if (st === "denied") return alert("이 폰에서 댕겨올개 알림이 꺼져 있어요.\n폰 설정 → 알림에서 댕겨올개(또는 브라우저) 알림을 허용한 뒤 다시 눌러 주세요.");
    if (st === "ios-browser") return alert("아이폰은 홈 화면에 추가한 댕겨올개 앱에서만 알림을 받을 수 있어요.\n\nSafari 공유 버튼 → ‘홈 화면에 추가’ 후, 홈 화면 아이콘으로 열어서 다시 눌러 주세요.");
    enablePush();
  });
}
async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("알림을 허용해야 받을 수 있어요"); drawPushBtn(); return; }
    const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register("sw.js", { type: "module" }));
    await navigator.serviceWorker.ready;
    const { data: v } = await C.sb.functions.invoke("pd", { body: { action: "vapid" } });
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(v.key) });
    const j = sub.toJSON();
    const { error } = await C.sb.from("push_subs").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" });
    if (error) { await sub.unsubscribe(); throw error; }
    await testPush();
  } catch (e) {
    console.error(e);
    toast("알림을 켜지 못했어요. 잠시 후 다시 눌러 주세요");
  }
  drawPushBtn();
}
async function testPush() {
  const { data, error } = await C.sb.functions.invoke("pd", { body: { action: "test" } });
  if (error || data?.error) toast("시험 알림을 보내지 못했어요");
  else toast(data.sent ? "시험 알림을 보냈어요. 폰 알림을 확인해 보세요" : "이 기기 알림 등록이 안 됐어요. 다시 눌러 주세요");
}
