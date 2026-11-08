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
async function load() {
  const [{ data: dogs }, { data: reqs }] = await Promise.all([
    C.sb.from("pd_dogs").select("*").order("name"),
    C.sb.from("pd_requests").select("*").eq("week_start", ps.week),
  ]);
  ps.dogs = dogs || [];
  ps.reqs = reqs || [];
}
const dogById = (id) => ps.dogs.find((d) => d.id === id);
const reqOf = (id) => ps.reqs.find((r) => r.dog_id === id);

/* ================= 화면 ================= */
export async function renderPickup(ctx) {
  C = ctx;
  const today = kstToday();
  if (!ps.week) {
    ps.week = isoDow(today) === 7 ? addDays(mondayOf(today), 7) : mondayOf(today); // 일요일엔 다음 주부터
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
    on.sort((a, b) => a.dog.name.localeCompare(b.dog.name, "ko"));
    by[d] = { on, cancelled };
  }
  const answered = new Set(ps.reqs.map((r) => r.dog_id));
  const missing = ps.dogs.filter((d) => d.active && !answered.has(d.id));

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
      ${C.owner ? `<button class="btn primary sm" id="pk-group">📢 단체 링크 복사</button><button class="btn ghost sm" id="pk-manage">아이 관리</button>` : ""}
    </div>

    <section class="card pk-board-wrap"><div class="pk-board">${dates.map((dt, i) => {
      const d = i + 1, x = by[d];
      return `<div class="pk-col ${dt === today ? "today" : ""} ${d >= 6 ? "we" : ""}" ${dt === today ? 'id="pk-today"' : ""}>
        <div class="pk-col-h"><b>${DOW[d]}</b><small>${md(dt)}</small><em>${x.on.length}</em></div>
        <div class="pk-col-b">
          ${x.on.map(({ r, dog, added }) => `<button class="pk-n ${added ? "add" : ""}" data-dog="${dog.id}" title="${added ? `${when(added)} 추가` : ""}">
            <span>${esc(dog.name)}</span>${r.memo ? `<i class="pk-mi ${r.memo_changed_at ? "new" : ""}" data-memo="${dog.id}" aria-label="메모 보기">📝</i>` : ""}</button>`).join("")}
          ${x.cancelled.map(({ dog, at }) => `<button class="pk-n x" data-dog="${dog.id}" title="${when(at)} 취소"><span>${esc(dog.name)}</span></button>`).join("")}
        </div>
      </div>`;
    }).join("")}</div></section>

    <section class="card pk-miss">
      <h2>${wLabel} 아직 신청 안 한 아이 <small class="muted">${missing.length}마리</small></h2>
      ${C.owner && missing.length ? `<button class="btn primary sm pk-send-btn" id="pk-send-miss">📨 신청 안 한 ${missing.length}마리에게 링크 보내기</button>` : ""}
      ${!ps.dogs.length ? `<p class="muted small">${C.owner ? "‘아이 관리’에서 픽드랍 이용하는 아이를 먼저 등록해 주세요." : "아직 등록된 아이가 없어요."}</p>`
        : missing.length ? `<div class="pk-chips">${missing.map((d) => `<button data-dog="${d.id}">${esc(d.name)}</button>`).join("")}</div>`
        : `<p class="muted small">모두 신청했어요 👍</p>`}
    </section>
    <p class="muted small pk-legend"><em class="pk-tag add">노란색</em> 주중에 추가 · <em class="pk-tag x">줄 그음</em> 주중에 취소 · 📝 메모 있음(누르면 보여요, <i class="pk-legend-dot"></i> 메모 바뀜)</p>`;

  $$("[data-wk]", root).forEach((b) => b.addEventListener("click", async () => { ps.week = addDays(ps.week, +b.dataset.wk); ps.day = ps.week === mondayOf(kstToday()) ? isoDow(kstToday()) : 1; await load(); draw(); }));
  $$("[data-dog]", root).forEach((b) => b.addEventListener("click", () => openDog(b.dataset.dog)));
  $$("[data-memo]", root).forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openMemo(b.dataset.memo); }));
  $("#pk-manage", root)?.addEventListener("click", openManage);
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
      <h3 class="pk-h3">요일 ${r ? "" : `<small class="muted">아직 신청 안 함</small>`}</h3>
      <div class="pk-pick">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<button data-p="${d}" class="${days.includes(d) ? "on" : ""} ${(r?.day_added || {})[d] ? "add" : ""}">${DOW[d]}</button>`).join("")}</div>
      <h3 class="pk-h3">메모</h3>
      <textarea id="pk-memo" maxlength="300" rows="3" placeholder="예) 9시 전에 와 주세요">${esc(r?.memo || "")}</textarea>
      ${r?.memo_changed_at ? `<p class="small"><em class="pk-tag memo">메모 바뀜 ${when(r.memo_changed_at)}</em></p>` : ""}
      <h3 class="pk-h3">보호자</h3>
      ${kv("이름", esc(dog.owner_name))}
      ${kv("전화", dog.phone ? `<a href="tel:${esc(digits(dog.phone))}">${esc(dog.phone)}</a>` : "")}
      ${kv("주소", esc(dog.address))}
      ${kv("선생님 메모", esc(dog.note))}
      ${!dog.owner_name && !dog.phone && !dog.address && !dog.note ? `<p class="muted small">정보가 없어요${C.owner ? " (아이 관리에서 넣을 수 있어요)" : ""}</p>` : ""}
      ${r ? `<p class="muted small">${r.by_staff ? "직원이 마지막으로 수정" : "보호자가 신청"} · ${when(r.updated_at)}</p>` : ""}
    </div>
    <div class="rc-foot">
      ${C.owner ? `${sendBtns(dog)}<button class="btn ghost mini" data-copy>복사</button><span class="grow"></span>` : ""}
      <button class="btn primary sm" data-save>요일·메모 저장</button>
    </div>`);
  const pick = new Set(days);
  $$("[data-p]", ov).forEach((b) => b.addEventListener("click", () => { const d = +b.dataset.p; pick.has(d) ? pick.delete(d) : pick.add(d); b.classList.toggle("on", pick.has(d)); }));
  $("[data-copy]", ov)?.addEventListener("click", () => copyInvite(dog));
  bindSend(ov);
  $("[data-save]", ov).addEventListener("click", async (e) => {
    e.target.disabled = true;
    const { data, error } = await C.sb.functions.invoke("pd", { body: { action: "save", dog_id: dog.id, week_start: ps.week, days: [...pick], memo: $("#pk-memo", ov).value } });
    if (error || data?.error) { toast(data?.error || "저장하지 못했어요"); e.target.disabled = false; return; }
    toast("저장했어요");
    close();
    await load(); draw();
  });
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
  copyText(`[댕겨올개] 다음 주 픽드랍 요일을 확정해 주세요 🚗\n아래 링크에서 우리 아이를 고르고 필요한 요일을 눌러 확정하면 돼요. (처음 한 번만 보호자 전화번호 뒷자리 확인)\n매주 일요일까지 확정해 주시고, 주중에 바꾸시면 카톡으로도 꼭 알려 주세요!\n${url}`,
    "단체 안내문과 링크를 복사했어요. 단톡방이나 공지에 붙여 넣으세요");
}
const inviteText = (dog) => `[댕겨올개] ${dog.name} 픽드랍 신청 링크예요 🚗\n매주 일요일까지 다음 주 필요한 요일을 골라 확정해 주세요. 매주 같은 링크예요!\n(주중에 바꾸시면 카톡으로도 꼭 알려 주세요)\n${linkOf(dog.token)}`;
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

// 한 명씩 차례로 보내기 (보낸 아이는 ✓)
function openSender(list, title) {
  const draw = (ov) => {
    const sent = sentSet();
    $(".pk-send", ov).innerHTML = list.map((d) => `<div class="pk-mrow ${sent.has(d.id) ? "sent" : ""}">
      <span class="grow"><b>${sent.has(d.id) ? "✓ " : ""}${esc(d.name)}</b><small class="muted">${esc([d.owner_name, d.phone].filter(Boolean).join(" · ")) || "연락처 없음"}</small></span>
      ${sendBtns(d)}</div>`).join("") || `<p class="muted small">보낼 아이가 없어요.</p>`;
    $(".pk-send-count", ov).textContent = `${list.filter((d) => sent.has(d.id)).length} / ${list.length} 보냄`;
    bindSend(ov, () => setTimeout(() => draw(ov), 400));
  };
  const { ov } = modal(`
    <div class="rc-head"><div class="grow"><b>${title}</b><small class="muted pk-send-count"></small></div><button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">
      <p class="muted small">‘카톡 보내기’를 누르면 공유 창이 떠요 → 카카오톡 → 보호자를 골라 보내면 돼요. ‘문자’는 받는 사람과 내용이 채워진 채로 문자 앱이 열려요. 보낸 아이는 ✓ 표시돼요.</p>
      <div class="pk-send"></div>
    </div>`, "wide");
  draw(ov);
}

/* ================= 아이 관리 (최고 관리자) ================= */
function openManage() {
  const { ov, close } = modal(`
    <div class="rc-head"><b class="grow">픽드랍 아이 관리</b><button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">
      <div class="pk-tools"><button class="btn primary sm" data-new>+ 아이 추가</button><button class="btn ghost sm" data-sendall>📨 전체 보내기</button><button class="btn ghost sm" data-all>링크 전체 복사</button></div>
      <p class="muted small">아이마다 보호자 전용 링크가 있어요. ‘카톡 보내기’나 ‘문자’로 보호자에게 보내 주세요. 매주 같은 링크라 한 번 받은 보호자는 그 링크로 계속 들어오면 돼요.</p>
      <div class="pk-manage">${ps.dogs.map((d) => `<div class="pk-mrow ${d.active ? "" : "off"}">
        <span class="grow"><b>${esc(d.name)}</b>${d.active ? "" : ` <span class="tag off">꺼짐</span>`}<small class="muted">${esc([d.owner_name, d.phone].filter(Boolean).join(" · "))}</small></span>
        ${d.active ? sendBtns(d) : ""}
        <button class="btn ghost mini" data-ed="${d.id}">수정</button>
      </div>`).join("") || `<p class="muted small">아직 없어요.</p>`}</div>
    </div>`, "wide");
  $("[data-new]", ov).addEventListener("click", () => { close(); openDogForm(null); });
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
      ${f("owner_name", "보호자")}
      ${f("phone", "전화", "010-0000-0000")}
      ${f("address", "주소", "픽드랍 주소")}
      ${f("note", "선생님 메모", "공동현관 비번, 주차 위치 등 (보호자에겐 안 보여요)")}
      ${dog ? `<label class="pk-check"><input type="checkbox" data-active ${dog.active ? "checked" : ""}> 링크 켜기 (끄면 보호자 링크가 막히고 목록에서 빠져요)</label>` : ""}
    </div>
    <div class="rc-foot">
      ${dog ? `<button class="btn ghost sm danger" data-del>삭제</button><span class="grow"></span>` : ""}
      <button class="btn primary sm" data-save>저장</button>
    </div>`);
  $("[data-save]", ov).addEventListener("click", async () => {
    const row = {};
    $$("[data-f]", ov).forEach((i) => (row[i.dataset.f] = i.value.trim() || null));
    if (!row.name) { toast("이름을 넣어 주세요"); return; }
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
