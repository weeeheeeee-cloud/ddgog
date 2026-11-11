// 호텔링 관리 (고객 관리 + 일정 캘린더)
// 사진 분류용 명단(dogs)은 읽기만 하고, 호텔링 데이터는 hotel_* 테이블에 따로 저장
// app.js 가 호텔링 탭을 열 때 renderHotel(ctx) 로 부름

let C = null; // { sb, toast, signed, esc, dogs }
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const hs = {
  view: "calendar",    // 호텔링 탭은 캘린더부터
  cal: "month",        // month | week
  monthMode: "auto",   // auto | bars | sum  (auto: 겹치는 예약이 많으면 요약 칸으로)
  week: null,          // 주간 보기 시작일(일요일)
  q: "",
  month: null,       // "YYYY-MM"
  highlight: null,   // 강조할 예약 id
  customers: [], pets: [], bookings: [],
};

/* ================= 유틸 ================= */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const won = (n) => `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
const kstNow = () => new Date(Date.now() + 9 * 3600e3);
const today = () => kstNow().toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const dow = (d) => new Date(d + "T00:00:00Z").getUTCDay(); // 0 일 ~ 6 토
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const md = (d) => d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}(${DOW[dow(d)]})` : "";
const digits = (s) => String(s || "").replace(/\D/g, "");
const nightsOf = (ci, co) => { const out = []; for (let d = ci; d && co && d < co; d = addDays(d, 1)) out.push(d); return out; };
const dogsIn = (label) => Math.max(1, String(label || "").split("/").map((x) => x.trim()).filter(Boolean).length);
const baseName = (n) => String(n || "").replace(/\s*\(.*\)\s*$/, "").trim();
const breedOf = (n) => (String(n || "").match(/\(([^)]+)\)\s*$/) || [])[1] || "";
const STATUS = { booked: "예약 완료", in: "입실 · 투숙 중", out: "퇴실 완료", cancelled: "예약 취소" };
const VAX = [["antibody", "항체검사"], ["corona", "코로나장염"], ["rabies", "광견병"], ["combo", "종합접종"], ["kennel", "켄넬코프"], ["flu", "신종 인플루엔자"]];
const payTag = (b) => (b.prepaid ? `<em class="ho-paid">선결제</em>` : "");
const kindTag = (k) => `<b class="hk ${k === "K" ? "k" : "h"}">${k === "K" ? "K" : "H"}</b>`;
function toast(m, ms) { C?.toast?.(m, ms); }

/* ================= 추가 서비스 ================= */
// 기본 가격을 모르면 null → 예약할 때 금액을 적음 (가격이 정해지면 여기 숫자만 넣으면 자동 계산)
export const SERVICE_PRICE = { bath: null, hygiene: null, grooming: null, daycare_hour: null };
const SVC = [["bath", "🛁", "목욕"], ["hygiene", "🧼", "위생미용"], ["grooming", "✂️", "미용"], ["pickup", "🚗", "픽업"], ["drop", "🏠", "드랍"], ["daycare", "☀️", "추가데이케어"]];
const svcOn = (b, k) => (k === "pickup" ? !!b.pickup : k === "drop" ? !!b.drop_off : !!(b.services || {})[k]);
const svcText = (b) => SVC.filter(([k]) => svcOn(b, k)).map(([k, ic, n]) => `${ic}${n}${k === "daycare" && b.services?.daycare?.hours ? ` ${b.services.daycare.hours}시간` : ""}`).join(" ");

/* ================= 요금 계산 ================= */
// K 유치원생: 평일(월~금) 40,000 / 주말(토·일) 50,000, 추가 아이 1박 30,000, 픽업·드랍 편도 5,000
// H 일반: 1박 62,000 (3박 이상이면 전체 57,000), 추가 아이 1박 40,000, 픽업·드랍 편도 8,000
// 퇴실일은 숙박에 넣지 않음. 픽업·드랍은 마릿수와 상관없이 한 번
export function calcFee({ kind, check_in, check_out, label, pickup, drop_off, services = {} }) {
  const nights = nightsOf(check_in, check_out);
  const n = nights.length;
  const extraDogs = dogsIn(label) - 1;
  let base = 0, detail = "";
  if (kind === "K") {
    const wkend = nights.filter((d) => dow(d) === 0 || dow(d) === 6).length;
    const wk = n - wkend;
    base = wk * 40000 + wkend * 50000;
    detail = [wk ? `평일 ${wk}박 × 40,000` : "", wkend ? `주말 ${wkend}박 × 50,000` : ""].filter(Boolean).join(" + ");
  } else {
    const rate = n >= 3 ? 57000 : 62000;
    base = rate * n;
    detail = n ? `${n}박 × ${rate.toLocaleString("ko-KR")}${n >= 3 ? " (3박 이상 할인)" : ""}` : "";
  }
  const extraRate = kind === "K" ? 30000 : 40000;
  const extra = extraDogs * extraRate * n;
  const way = kind === "K" ? 5000 : 8000;
  return {
    nights: n, dogs: extraDogs + 1, base, base_detail: detail,
    extra, extra_detail: extraDogs && n ? `추가 ${extraDogs}마리 × ${n}박 × ${extraRate.toLocaleString("ko-KR")}` : "",
    pickup: pickup ? way : 0, drop: drop_off ? way : 0,
    ...svcFee(services),
  };
}
// 목욕·위생미용·미용·추가데이케어: 적은 금액 → 없으면 기본 가격 → 없으면 0
function svcFee(services = {}) {
  const svc = [];
  for (const k of ["bath", "hygiene", "grooming"]) {
    if (!services[k]) continue;
    const amt = services[k].price != null ? Number(services[k].price) : (SERVICE_PRICE[k] ?? null);
    svc.push({ key: k, amount: amt ?? 0, set: amt != null });
  }
  if (services.daycare) {
    const h = Number(services.daycare.hours) || 0;
    const amt = services.daycare.price != null ? Number(services.daycare.price) : (SERVICE_PRICE.daycare_hour != null ? SERVICE_PRICE.daycare_hour * h : null);
    svc.push({ key: "daycare", hours: h, amount: amt ?? 0, set: amt != null });
  }
  return { svc, services_total: svc.reduce((a, x) => a + x.amount, 0) };
}
// 직원이 고친 금액(manual)이 있으면 그걸 쓰고, 없으면 자동 계산 금액
export function settle(calc, manual = {}, extra_cost = 0, discount = 0) {
  const pick = (k) => (manual[k] != null ? Number(manual[k]) : Number(calc[k] || 0));
  const items = { base: pick("base"), extra: pick("extra"), pickup: pick("pickup"), drop: pick("drop") };
  const sum = items.base + items.extra + items.pickup + items.drop + Number(calc.services_total || 0) + Number(extra_cost || 0) - Number(discount || 0);
  return { ...items, auto_total: sum, total: manual.total != null ? Number(manual.total) : sum };
}

/* ================= 데이터 ================= */
async function load() {
  const [c, p, b] = await Promise.all([
    C.sb.from("hotel_customers").select("*").order("created_at", { ascending: false }),
    C.sb.from("hotel_pets").select("*").order("sort"),
    C.sb.from("hotel_bookings").select("*").order("check_in"),
  ]);
  if (c.error || p.error || b.error) throw c.error || p.error || b.error;
  hs.customers = c.data || []; hs.pets = p.data || []; hs.bookings = b.data || [];
}
const petsOf = (cid) => hs.pets.filter((p) => p.customer_id === cid);
const custById = (id) => hs.customers.find((c) => c.id === id);
const custLabel = (c) => petsOf(c.id).map((p) => p.name).join("/") || "(이름 없음)";
const bookingsOf = (cid) => hs.bookings.filter((b) => b.customer_id === cid);
const active = (b) => b.status !== "cancelled";
const dt = (d, t, end) => new Date(`${d}T${t || (end ? "23:59" : "00:00")}:00+09:00`);

/* ================= 화면 틀 ================= */
export async function renderHotel(ctx) {
  C = ctx;
  hs.month ??= today().slice(0, 7);
  const root = $("#tab-hotel");
  if (!root.dataset.ready) {
    root.innerHTML = `<div class="ho">
      <nav class="ho-nav">
        <button data-hv="calendar">📅 호텔링 일정 캘린더</button>
        <button data-hv="customers">🐶 호텔링 고객 관리</button>
      </nav>
      <div class="ho-main" id="ho-main"></div></div>`;
    $$("[data-hv]", root).forEach((b) => b.addEventListener("click", () => { hs.view = b.dataset.hv; draw(); }));
    root.dataset.ready = "1";
  }
  $("#ho-main").innerHTML = `<p class="muted">불러오는 중…</p>`;
  try { await load(); } catch (e) { console.error(e); $("#ho-main").innerHTML = `<p class="err">불러오지 못했어요. 새로고침해 주세요.</p>`; return; }
  draw();
}
function draw() {
  $$("[data-hv]").forEach((b) => b.classList.toggle("on", b.dataset.hv === hs.view));
  if (hs.view === "calendar") drawCalendar(); else drawCustomers();
}
async function refresh() { await load(); draw(); }

/* ================= 고객 관리 ================= */
// 이름 검색: 그대로 / 초성(ㅃㄱ) / 비슷한 소리(빼곰 = 빼꼼, 된소리·띄어쓰기 무시) 모두 찾음
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ", JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ", JONG = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";
const SOFT = { "ㄲ": "ㄱ", "ㄸ": "ㄷ", "ㅃ": "ㅂ", "ㅆ": "ㅅ", "ㅉ": "ㅈ", "ㅐ": "ㅔ", "ㅒ": "ㅖ" };
function jamo(str) {
  let o = "";
  for (const ch of String(str || "")) {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c >= 0 && c < 11172) o += CHO[Math.floor(c / 588)] + JUNG[Math.floor((c % 588) / 28)] + (c % 28 ? JONG[c % 28] : "");
    else o += ch;
  }
  return o;
}
const soft = (s) => [...jamo(String(s || "").toLowerCase().replace(/\s+/g, ""))].map((x) => SOFT[x] || x).join("");
const choOf = (s) => [...String(s || "")].map((ch) => { const c = ch.charCodeAt(0) - 0xac00; return c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch; }).join("");
function nameHit(name, q) {
  const t = String(q || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return true;
  const n = String(name || "").toLowerCase().replace(/\s+/g, "");
  if (n.includes(t)) return true;
  if (/^[ㄱ-ㅎ]+$/.test(t)) return choOf(n).includes(t);
  return t.length >= 2 && soft(n).includes(soft(t));
}
function matches(c, q) {
  if (!q) return true;
  const d = digits(q);
  if (d.length >= 2 && digits(c.phone).includes(d)) return true;
  return [c.owner_name, ...petsOf(c.id).map((p) => p.name)].some((n) => nameHit(n, q));
}
function drawCustomers() {
  const main = $("#ho-main");
  main.innerHTML = `
    <div class="ho-head">
      <h2>호텔링 고객 <small class="muted" id="ho-count"></small></h2>
      <div class="ho-actions">
        <button class="btn ghost sm" id="ho-import">유치원생 불러오기</button>
        <button class="btn primary sm" id="ho-new">+ 신규 고객 등록</button>
      </div>
    </div>
    <input id="ho-q" class="ho-search" type="search" placeholder="🔍 검색 — 강아지 이름 · 보호자 이름 · 전화번호 (초성도 돼요)" value="${esc(hs.q)}" autocomplete="off">
    <div id="ho-list"></div>`;
  $("#ho-new").addEventListener("click", () => openCustomerForm(null));
  $("#ho-import").addEventListener("click", openImport);
  $("#ho-q").addEventListener("input", (e) => { hs.q = e.target.value; drawList(); });
  drawList();
}
function drawList() {
  const t = today();
  const list = hs.customers.filter((c) => matches(c, hs.q));
  $("#ho-count").textContent = hs.q ? `${list.length} / ${hs.customers.length}명` : `${hs.customers.length}명`;
  if (!hs.customers.length) {
    $("#ho-list").innerHTML = `<div class="ho-empty"><b>아직 호텔링 고객이 없어요</b><p class="muted">상담지 사진으로 <b>신규 고객 등록</b>을 하거나, 유치원 아이라면 <b>유치원생 불러오기</b>로 시작해 주세요.</p></div>`;
    return;
  }
  if (!list.length) { $("#ho-list").innerHTML = `<p class="muted">‘${esc(hs.q)}’에 맞는 고객이 없어요.</p>`; return; }
  $("#ho-list").innerHTML = `<div class="ho-table">
    <div class="ho-tr ho-th"><span>구분</span><span>강아지</span><span>보호자</span><span>전화번호</span><span>최근 이용</span><span>예약</span></div>
    ${list.map((c) => {
      const bs = bookingsOf(c.id).filter(active);
      const past = bs.filter((b) => b.check_in < t).sort((a, b) => b.check_in.localeCompare(a.check_in))[0];
      const next = bs.filter((b) => b.check_out >= t && b.status !== "out").sort((a, b) => a.check_in.localeCompare(b.check_in))[0];
      return `<button class="ho-tr" data-cust="${c.id}">
        <span>${kindTag(c.kind)}</span>
        <span class="ho-pet">${esc(custLabel(c))}</span>
        <span>${esc(c.owner_name || "")}</span>
        <span class="ho-phone">${esc(c.phone || "")}</span>
        <span class="muted">${past ? `${md(past.check_in)} → ${md(past.check_out)}` : "-"}</span>
        <span>${next ? `<em class="ho-next">${next.check_in <= t ? "투숙 중 · " : ""}${md(next.check_in)} → ${md(next.check_out)}</em>` : `<span class="muted">-</span>`}</span>
      </button>`;
    }).join("")}</div>`;
  $$("[data-cust]", $("#ho-list")).forEach((b) => b.addEventListener("click", () => openCustomer(b.dataset.cust)));
}

/* ---------- 팝업 공통 ---------- */
function modal(html, cls = "") {
  const ov = document.createElement("div");
  ov.className = "rc-overlay ho-ov";
  ov.innerHTML = `<div class="rc-box ho-box ${cls}">${html}</div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  $$("[data-close]", ov).forEach((b) => b.addEventListener("click", close));
  return { ov, close };
}

/* ---------- 고객 상세 ---------- */
async function openCustomer(id) {
  const c = custById(id);
  if (!c) return;
  const pets = petsOf(id);
  const t = today();
  const bs = bookingsOf(id).sort((a, b) => b.check_in.localeCompare(a.check_in));
  const upcoming = bs.filter((b) => b.check_out >= t && b.status !== "out" && b.status !== "cancelled").reverse();
  const past = bs.filter((b) => !upcoming.includes(b));
  const { data: forms } = await C.sb.from("hotel_forms").select("*").eq("customer_id", id).order("created_at");
  const formUrl = await C.signed("hotel-forms", (forms || []).map((f) => f.path));
  const ref = await C.signed("refs", pets.map((p) => C.dogs.find((d) => d.id === p.dog_id)?.ref_path).filter(Boolean));
  const v = c.vaccines || {};
  const row = (k, val) => val ? `<div class="ho-kv"><span>${k}</span><b>${val}</b></div>` : "";
  const bRow = (b) => `<button class="ho-bk ${b.status}" data-bk="${b.id}">
      ${kindTag(b.kind)}<span class="grow"><b>${esc(b.label)}</b> <small class="muted">${md(b.check_in)}${b.in_time ? " " + b.in_time : ""} → ${md(b.check_out)}${b.out_time ? " " + b.out_time : ""}</small>
      <br><small class="muted">${STATUS[b.status]}${svcText(b) ? " · " + svcText(b) : ""}${b.notes ? " · " + esc(b.notes) : ""}</small></span>
      <b>${won(b.total)} ${payTag(b)}</b></button>`;
  const { ov, close } = modal(`
    <div class="rc-head"><div class="grow"><b class="ho-title">${kindTag(c.kind)} ${esc(custLabel(c))}</b>
      <small class="muted">${esc(c.owner_name || "보호자 이름 없음")}${c.consult_date ? ` · 상담 ${c.consult_date}` : ""}</small></div>
      <button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">
      <div class="ho-cols">
        <section><h3>보호자</h3>
          ${row("이름", esc(c.owner_name))}
          ${row("전화", c.phone ? `<a href="tel:${esc(digits(c.phone))}">${esc(c.phone)}</a>` : "")}
          ${row("주소", esc(c.address))}
          ${row("방문 경로", esc(c.visit_source))}
          ${!c.owner_name && !c.phone && !c.address ? `<p class="muted small">아직 없어요</p>` : ""}
        </section>
        <section><h3>강아지 ${pets.length > 1 ? `<small class="muted">${pets.length}마리</small>` : ""}</h3>
          ${pets.map((p) => {
            const dog = C.dogs.find((d) => d.id === p.dog_id);
            return `<div class="ho-pet-card">${dog?.ref_path ? `<img src="${ref(dog.ref_path)}" alt="">` : ""}<div>
              <b>${esc(p.name)}</b>${dog ? ` <small class="hk-link">명단 연결</small>` : ""}
              <br><small class="muted">${[p.breed, p.sex === "M" ? "남아" : p.sex === "F" ? "여아" : "", p.neutered === "yes" ? "중성화 완료" : p.neutered === "no" ? "중성화 미완료" : "", p.age, p.weight ? p.weight + "kg" : ""].filter(Boolean).map(esc).join(" · ") || "정보 없음"}</small></div></div>`;
          }).join("")}
        </section>
      </div>
      ${c.health || c.behavior || c.requests ? `<section><h3>상담 내용</h3>
        ${row("건강·특이", esc(c.health))}${row("행동 특이", esc(c.behavior))}${row("요청 사항", esc(c.requests))}</section>` : ""}
      ${VAX.some(([k]) => v[k]) || v.hospital ? `<section><h3>예방접종</h3><div class="ho-chips">${VAX.filter(([k]) => v[k]).map(([, n]) => `<span>✓ ${n}</span>`).join("")}</div>${v.hospital ? `<p class="small muted">접종병원·시기: ${esc(v.hospital)}</p>` : ""}</section>` : ""}
      ${c.notes ? `<section><h3>기타 메모</h3><p class="ho-pre">${esc(c.notes)}</p></section>` : ""}
      ${(forms || []).length ? `<section><h3>상담지 원본</h3><div class="ho-forms">${forms.map((f) => `<a href="${formUrl(f.path)}" target="_blank" rel="noopener"><img src="${formUrl(f.path)}" alt="상담지"></a>`).join("")}</div></section>` : ""}
      <section><h3>현재·향후 예약</h3>${upcoming.length ? upcoming.map(bRow).join("") : `<p class="muted small">없어요</p>`}</section>
      <section><h3>지난 이용 이력</h3>${past.length ? past.map(bRow).join("") : `<p class="muted small">없어요</p>`}</section>
    </div>
    <div class="rc-foot">
      <button class="btn ghost sm danger" data-del>고객 삭제</button>
      <span class="grow"></span>
      <button class="btn ghost sm" data-edit>정보 수정</button>
      <button class="btn primary sm" data-book>+ 예약 추가</button>
    </div>`, "wide");
  $$("[data-bk]", ov).forEach((b) => b.addEventListener("click", () => { close(); openBooking(hs.bookings.find((x) => x.id === b.dataset.bk)); }));
  $("[data-edit]", ov).addEventListener("click", () => { close(); openCustomerForm(c); });
  $("[data-book]", ov).addEventListener("click", () => { close(); openBooking(null, { customer: c }); });
  $("[data-del]", ov).addEventListener("click", async () => {
    if (!confirm(`'${custLabel(c)}' 고객을 삭제할까요?\n예약 ${bs.length}건과 상담지 사진도 함께 지워져요. 되돌릴 수 없어요.\n(사진 분류 명단은 그대로예요)`)) return;
    if ((forms || []).length) await C.sb.storage.from("hotel-forms").remove(forms.map((f) => f.path));
    const { error } = await C.sb.from("hotel_customers").delete().eq("id", c.id);
    if (error) { toast("삭제하지 못했어요"); return; }
    close(); toast("고객을 삭제했어요"); refresh();
  });
}

/* ---------- 유치원생 불러오기 ---------- */
async function openImport() {
  const linked = new Map(hs.pets.filter((p) => p.dog_id).map((p) => [p.dog_id, p.customer_id]));
  const dogs = C.dogs.filter((d) => !d.auto);
  const ref = await C.signed("refs", dogs.map((d) => d.ref_path));
  const { ov, close } = modal(`
    <div class="rc-head"><div class="grow"><b>유치원생 불러오기</b><small class="muted">아이를 고르면 입실·퇴실 날짜와 시간만 넣어서 바로 예약해요. 사진 분류 명단은 바뀌지 않아요.</small></div>
      <button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body"><input class="ho-search" id="imp-q" type="search" placeholder="강아지 이름 검색" autocomplete="off"><div id="imp-list" class="ho-imp"></div></div>`);
  const drawImp = () => {
    const q = $("#imp-q", ov).value.trim().toLowerCase();
    const list = dogs.filter((d) => !q || d.name.toLowerCase().includes(q)).slice(0, 60);
    $("#imp-list", ov).innerHTML = list.map((d) => `<button data-dog="${d.id}" class="${linked.has(d.id) ? "done" : ""}">
        ${d.ref_path ? `<img src="${ref(d.ref_path)}" alt="">` : `<span class="avatar"></span>`}
        <span class="grow"><b>${esc(d.name)}</b>${linked.has(d.id) ? `<br><small>호텔링 고객 · 바로 예약</small>` : ""}</span></button>`).join("")
      || `<p class="muted">명단에 없는 이름이에요. 신규 고객으로 등록해 주세요.</p>`;
    $$("[data-dog]", ov).forEach((b) => b.addEventListener("click", () => {
      const d = dogs.find((x) => x.id === b.dataset.dog);
      close();
      // 유치원생은 정보를 따로 넣지 않고 입실·퇴실 날짜와 시간만 넣어서 바로 예약
      if (linked.has(d.id)) return openBooking(null, { customer: custById(linked.get(d.id)), quick: true });
      openBooking(null, { quickDog: d, quick: true });
    }));
  };
  $("#imp-q", ov).addEventListener("input", drawImp);
  drawImp();
  $("#imp-q", ov).focus();
}

/* ---------- 고객 등록·수정 (상담지 AI 자동 입력) ---------- */
async function resizeToJpeg(file, max = 1800, q = 0.85) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return await new Promise((r) => c.toBlob(r, "image/jpeg", q));
}
const blobToB64 = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(",")[1]); fr.readAsDataURL(b); });

function openCustomerForm(cust, preset = {}) {
  const c = cust || { kind: preset.kind || "H", vaccines: {} };
  let pets = cust ? petsOf(cust.id).map((p) => ({ ...p })) : (preset.pets || [{ name: "" }]);
  const removedPets = [];
  const newForms = []; // { blob, url }
  let aiStay = null;   // 상담지에서 읽은 입실·퇴실
  const v = c.vaccines || {};
  const { ov, close } = modal(`
    <div class="rc-head"><div class="grow"><b>${cust ? "고객 정보 수정" : "신규 호텔링 고객"}</b>
      <small class="muted">비어 있는 칸은 그대로 두셔도 돼요.</small></div>
      <button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body ho-form">
      <section class="ho-ai">
        <div class="ho-ai-head"><b>📄 상담지 사진</b><small class="muted">찍거나 골라서 올리면 AI가 칸을 채워 줘요. 여러 장도 돼요.</small></div>
        <div class="ho-ai-row"><div id="cf-forms" class="ho-forms"></div>
          <label class="btn ghost sm">사진 추가<input id="cf-file" type="file" accept="image/*" multiple hidden></label>
          <button class="btn primary sm" id="cf-ai" type="button" disabled>AI로 채우기</button></div>
        <p id="cf-ai-msg" class="small muted"></p>
      </section>
      <div class="ho-grid">
        <label>고객 구분<div class="ho-seg" id="cf-kind"><button type="button" data-k="H">H 일반</button><button type="button" data-k="K">K 유치원생</button></div></label>
        <label>상담지 작성일<input id="cf-date" type="date" value="${esc(c.consult_date || "")}"></label>
        <label>보호자 이름<input id="cf-owner" value="${esc(c.owner_name || "")}"></label>
        <label>전화번호<input id="cf-phone" type="tel" value="${esc(c.phone || "")}"></label>
        <label class="full">주소<input id="cf-addr" value="${esc(c.address || "")}"></label>
        <label class="full">방문 경로<input id="cf-src" value="${esc(c.visit_source || "")}"></label>
      </div>
      <h3>강아지 <small class="muted">다견이면 아이를 더 추가해 주세요</small></h3>
      <div id="cf-pets"></div>
      <div class="row"><button class="btn ghost sm" id="cf-addpet" type="button">+ 아이 추가</button>
        <button class="btn ghost sm" id="cf-linkpet" type="button">+ 명단 아이 연결</button></div>
      <div class="ho-grid">
        <label class="full">건강, 특이 사항<textarea id="cf-health" rows="2">${esc(c.health || "")}</textarea></label>
        <label class="full">행동 특이 사항<textarea id="cf-behavior" rows="2">${esc(c.behavior || "")}</textarea></label>
        <label class="full">보호자 요청 사항<textarea id="cf-req" rows="2">${esc(c.requests || "")}</textarea></label>
      </div>
      <h3>예방접종</h3>
      <div class="ho-vax">${VAX.map(([k, n]) => `<label><input type="checkbox" data-vax="${k}" ${v[k] ? "checked" : ""}> ${n}</label>`).join("")}</div>
      <label class="ho-line">접종병원 / 접종시기<input id="cf-hosp" value="${esc(v.hospital || "")}"></label>
      <label class="ho-line">기타 메모<textarea id="cf-notes" rows="2">${esc(c.notes || "")}</textarea></label>
    </div>
    <div class="rc-foot"><button class="btn ghost sm" data-close>취소</button><button class="btn primary sm" id="cf-save">저장</button></div>`, "wide");

  let kind = c.kind || "H";
  const drawKind = () => $$("[data-k]", ov).forEach((b) => b.classList.toggle("on", b.dataset.k === kind));
  $$("[data-k]", ov).forEach((b) => b.addEventListener("click", () => { kind = b.dataset.k; drawKind(); }));
  drawKind();

  const drawPets = () => {
    $("#cf-pets", ov).innerHTML = pets.map((p, i) => `<div class="ho-petrow" data-i="${i}">
      <input data-f="name" placeholder="이름" value="${esc(p.name || "")}">
      <input data-f="breed" placeholder="견종" value="${esc(p.breed || "")}">
      <select data-f="sex"><option value="">성별</option><option value="M" ${p.sex === "M" ? "selected" : ""}>남아</option><option value="F" ${p.sex === "F" ? "selected" : ""}>여아</option></select>
      <select data-f="neutered" title="중성화"><option value="unknown">중성화 ?</option><option value="yes" ${p.neutered === "yes" ? "selected" : ""}>중성화 완료</option><option value="no" ${p.neutered === "no" ? "selected" : ""}>중성화 안 함</option></select>
      <input data-f="age" placeholder="나이 (예: 3살)" value="${esc(p.age || "")}">
      <input data-f="weight" placeholder="몸무게 kg" inputmode="decimal" value="${p.weight ?? ""}">
      ${p.dog_id ? `<small class="hk-link" title="사진 분류 명단과 연결됨">명단 연결</small>` : ""}
      <button type="button" class="btn ghost mini" data-rm="${i}" title="이 아이 빼기">×</button></div>`).join("");
    $$(".ho-petrow", ov).forEach((r) => $$("[data-f]", r).forEach((el) => el.addEventListener("input", () => { pets[+r.dataset.i][el.dataset.f] = el.value; })));
    $$("[data-rm]", ov).forEach((b) => b.addEventListener("click", () => {
      const [p] = pets.splice(+b.dataset.rm, 1);
      if (p?.id) removedPets.push(p.id);
      if (!pets.length) pets.push({ name: "" });
      drawPets();
    }));
  };
  drawPets();
  $("#cf-addpet", ov).addEventListener("click", () => { pets.push({ name: "" }); drawPets(); });
  $("#cf-linkpet", ov).addEventListener("click", () => {
    const name = prompt("연결할 명단 아이 이름");
    if (!name) return;
    const linked = new Set(hs.pets.filter((p) => p.dog_id && p.customer_id !== cust?.id).map((p) => p.dog_id));
    const hits = C.dogs.filter((d) => !d.auto && d.name.includes(name.trim()));
    if (!hits.length) { toast("명단에 없는 이름이에요"); return; }
    const d = hits.length === 1 ? hits[0] : hits[(+prompt(hits.map((h, i) => `${i + 1}. ${h.name}`).join("\n") + "\n\n번호를 골라 주세요", "1") || 1) - 1];
    if (!d) return;
    if (linked.has(d.id) || pets.some((p) => p.dog_id === d.id)) { toast(`${d.name}은(는) 이미 다른 호텔링 고객에 있어요`); return; }
    const empty = pets.find((p) => !p.name && !p.dog_id);
    const np = { name: baseName(d.name), breed: breedOf(d.name), dog_id: d.id };
    if (empty) Object.assign(empty, np); else pets.push(np);
    drawPets();
  });

  // 상담지 사진
  const drawForms = () => {
    $("#cf-forms", ov).innerHTML = newForms.map((f, i) => `<span class="ho-fthumb"><img src="${f.url}" alt=""><button type="button" data-frm="${i}">×</button></span>`).join("");
    $$("[data-frm]", ov).forEach((b) => b.addEventListener("click", () => { const [f] = newForms.splice(+b.dataset.frm, 1); URL.revokeObjectURL(f.url); drawForms(); }));
    $("#cf-ai", ov).disabled = !newForms.length;
  };
  $("#cf-file", ov).addEventListener("change", async (e) => {
    for (const file of [...e.target.files]) {
      try { const blob = await resizeToJpeg(file); newForms.push({ blob, url: URL.createObjectURL(blob) }); } catch { toast("사진을 열지 못했어요"); }
    }
    e.target.value = "";
    drawForms();
  });
  $("#cf-ai", ov).addEventListener("click", async () => {
    const btn = $("#cf-ai", ov), msg = $("#cf-ai-msg", ov);
    btn.disabled = true; btn.textContent = "읽는 중…"; msg.textContent = "AI가 상담지를 읽고 있어요. 10~30초 걸려요.";
    try {
      const images = await Promise.all(newForms.map((f) => blobToB64(f.blob)));
      const { data, error } = await C.sb.functions.invoke("hotel-form", { body: { images } });
      if (error) { let m = "읽지 못했어요"; try { m = (await error.context.json()).error || m; } catch { /* 무시 */ } throw new Error(m); }
      fillFromForm(data.form || {});
      msg.innerHTML = `✅ 다 읽었어요. <b>노란 칸</b>이 AI가 채운 곳이에요. 확인하고 고쳐 주세요.${(data.form?.unsure || []).length ? ` 확실하지 않은 칸: ${esc(data.form.unsure.join(", "))}` : ""}`;
    } catch (err) { msg.textContent = `⚠️ ${err.message}`; }
    btn.disabled = !newForms.length; btn.textContent = "AI로 채우기";
  });
  const setIf = (sel, val) => { const el = $(sel, ov); if (val != null && val !== "" && el && !el.value) { el.value = val; el.classList.add("ai-filled"); } };
  function fillFromForm(f) {
    setIf("#cf-owner", f.owner_name); setIf("#cf-phone", f.phone); setIf("#cf-addr", f.address);
    setIf("#cf-src", f.visit_source); setIf("#cf-date", f.consult_date);
    setIf("#cf-health", f.health); setIf("#cf-behavior", f.behavior); setIf("#cf-req", f.requests);
    setIf("#cf-hosp", f.vaccines?.hospital);
    VAX.forEach(([k]) => { if (f.vaccines?.[k] === true) { const el = $(`[data-vax="${k}"]`, ov); el.checked = true; el.parentElement.classList.add("ai-filled"); } });
    const read = (f.pets || []).filter((p) => p && p.name);
    read.forEach((p) => {
      // 같은 이름 칸 → 빈 칸 → 새 칸 순서로 채움
      let target = pets.find((x) => x.name && x.name === p.name) || pets.find((x) => !String(x.name || "").trim() && !x._ai);
      if (!target) { target = {}; pets.push(target); }
      for (const k of ["name", "breed", "sex", "neutered", "age", "weight"]) if (p[k] != null && p[k] !== "" && (target[k] == null || target[k] === "")) target[k] = p[k];
      target._ai = true;
    });
    drawPets();
    $$(".ho-petrow", ov).forEach((r) => { if (pets[+r.dataset.i]?._ai) r.classList.add("ai-filled"); });
    if (f.check_in) aiStay = { check_in: f.check_in, check_out: f.check_out || null, in_time: f.in_time || "", out_time: f.out_time || "" };
  }

  $("#cf-save", ov).addEventListener("click", async () => {
    const btn = $("#cf-save", ov);
    const val = (s) => $(s, ov).value.trim() || null;
    // 입력칸에 보이는 값을 그대로 다시 읽음 (한글 입력 중 바로 저장을 눌러도 마지막 글자까지 반영)
    $$(".ho-petrow", ov).forEach((r) => $$("[data-f]", r).forEach((el) => { if (pets[+r.dataset.i]) pets[+r.dataset.i][el.dataset.f] = el.value; }));
    const named = pets.filter((p) => String(p.name || "").trim());
    if (!named.length && !val("#cf-owner")) { toast("강아지 이름이나 보호자 이름 중 하나는 적어 주세요"); return; }
    btn.disabled = true; btn.textContent = "저장 중…";
    try {
      const vaccines = { hospital: val("#cf-hosp") };
      VAX.forEach(([k]) => (vaccines[k] = $(`[data-vax="${k}"]`, ov).checked));
      const row = {
        kind, owner_name: val("#cf-owner"), phone: val("#cf-phone"), address: val("#cf-addr"), visit_source: val("#cf-src"),
        consult_date: val("#cf-date"), health: val("#cf-health"), behavior: val("#cf-behavior"), requests: val("#cf-req"),
        notes: val("#cf-notes"), vaccines, updated_at: new Date().toISOString(),
      };
      let id = cust?.id;
      if (id) { const { error } = await C.sb.from("hotel_customers").update(row).eq("id", id); if (error) throw error; }
      else { const { data, error } = await C.sb.from("hotel_customers").insert(row).select().single(); if (error) throw error; id = data.id; }
      if (removedPets.length) await C.sb.from("hotel_pets").delete().in("id", removedPets);
      for (const [i, p] of named.entries()) {
        const w = parseFloat(String(p.weight ?? "").replace(/[^\d.]/g, ""));
        const pr = { customer_id: id, name: String(p.name).trim(), breed: p.breed || null, sex: p.sex || null,
          neutered: p.neutered && p.neutered !== "" ? p.neutered : null, age: p.age || null, weight: isFinite(w) ? w : null, dog_id: p.dog_id || null, sort: i };
        const r = p.id ? await C.sb.from("hotel_pets").update(pr).eq("id", p.id).select("id") : await C.sb.from("hotel_pets").insert(pr).select("id");
        if (r.error) throw r.error.code === "23505" ? new Error(`${pr.name}은(는) 이미 다른 호텔링 고객에 연결돼 있어요`) : r.error;
        if (p.id && !r.data?.length) throw new Error(`${pr.name} 이름을 저장하지 못했어요. 새로고침 후 다시 해 주세요`);
        // 이름을 바꿨으면 이 고객의 예약(캘린더)에 적힌 이름도 같이 바꿈: "빼곰" → "빼꼼", "비비/빼곰" → "비비/빼꼼"
        const old = p.id ? hs.pets.find((x) => x.id === p.id)?.name : null;
        if (old && old !== pr.name) {
          for (const b of bookingsOf(id)) {
            const parts = String(b.label || "").split("/").map((x) => x.trim());
            if (!parts.includes(old)) continue;
            const label = parts.map((x) => (x === old ? pr.name : x)).join("/");
            await C.sb.from("hotel_bookings").update({ label }).eq("id", b.id);
          }
        }
      }
      for (const f of newForms) {
        const path = `${id}/${crypto.randomUUID()}.jpg`;
        const up = await C.sb.storage.from("hotel-forms").upload(path, f.blob, { contentType: "image/jpeg" });
        if (!up.error) await C.sb.from("hotel_forms").insert({ customer_id: id, path });
      }
      close();
      toast(cust ? "고객 정보를 고쳤어요" : "호텔링 고객을 등록했어요");
      await load();
      draw();
      const saved = custById(id);
      if (aiStay && confirm(`상담지에 입실 ${md(aiStay.check_in)}${aiStay.check_out ? ` → 퇴실 ${md(aiStay.check_out)}` : ""}이(가) 적혀 있어요.\n이 날짜로 예약도 만들까요?`)) {
        openBooking(null, { customer: saved, ...aiStay });
      } else openCustomer(id);
    } catch (err) {
      console.error(err);
      toast(err.message || "저장하지 못했어요", 4000);
      btn.disabled = false; btn.textContent = "저장";
    }
  });
}

/* ================= 일정 캘린더 ================= */
function staysOn(d) { return hs.bookings.filter((b) => active(b) && b.check_in <= d && d <= b.check_out); }
function todayStats() {
  const t = today(), now = new Date();
  const live = hs.bookings.filter(active);
  return {
    in: live.filter((b) => b.check_in === t),
    stay: live.filter((b) => b.status !== "out" && dt(b.check_in, b.in_time) <= now && now < dt(b.check_out, b.out_time, true)),
    out: live.filter((b) => b.check_out === t),
  };
}
// 한 주(7일) 줄: 날짜 칸을 바탕으로 깔고, 예약은 입실~퇴실을 하나로 이어진 막대로 그 위에 올림
function drawWeek(wk, t, cls = "") {
  const ws = wk[0], we = wk[6];
  const list = hs.bookings.filter((b) => active(b) && b.check_in <= we && b.check_out >= ws)
    .sort((a, b) => a.check_in.localeCompare(b.check_in) || b.check_out.localeCompare(a.check_out) || a.label.localeCompare(b.label, "ko"));
  const lanes = []; // 줄마다 마지막으로 차지한 칸 번호
  const segs = list.map((b) => {
    const s0 = b.check_in < ws ? 0 : wk.indexOf(b.check_in);
    const s1 = b.check_out > we ? 6 : wk.indexOf(b.check_out);
    let lane = lanes.findIndex((end) => end < s0);
    if (lane < 0) { lane = lanes.length; lanes.push(s1); } else lanes[lane] = s1;
    return { b, s0, s1, lane, head: b.check_in >= ws, tail: b.check_out <= we };
  });
  const cells = wk.map((d, i) => `<div class="ho-day ${d.slice(0, 7) !== hs.month ? "other" : ""} ${d === t ? "today" : ""} ${dow(d) === 0 ? "sun" : dow(d) === 6 ? "sat" : ""}" data-day="${d}" style="grid-column:${i + 1}">
      <span class="ho-dn">${cls ? md(d) : +d.slice(8)}</span><span class="ho-add" data-add="${d}" title="이 날 입실로 예약 추가">+ 예약</span></div>`).join("");
  const bars = segs.map(({ b, s0, s1, lane, head, tail }) => {
    const svc = svcText(b);
    return `<button class="ho-chip ho-bar ${b.kind === "K" ? "k" : "h"} ${head ? "head" : ""} ${tail ? "tail" : ""} ${s0 === s1 ? "one" : ""} ${b.id === hs.highlight ? "hl" : ""} ${b.status}" data-bk="${b.id}"
      style="grid-column:${s0 + 1} / span ${s1 - s0 + 1};grid-row:${lane + 2}"
      title="${esc(b.label)} ${md(b.check_in)}~${md(b.check_out)}${svc ? ` · ${esc(svc)}` : ""}">
      <span class="ho-cl">${head ? "▸" : "…"}${b.kind} ${esc(b.label)}${svc ? `<i class="ho-bang">!</i>` : ""}</span>
      ${tail ? `<small class="ho-fee-s">${b.prepaid ? `<em class="ho-paid">선결제</em>` : ""}${won(b.total)}◂</small>` : ""}</button>`;
  }).join("");
  return `<div class="ho-week ${cls}" style="grid-template-rows:28px ${lanes.length ? `repeat(${lanes.length}, auto) ` : ""}minmax(10px, 1fr)">${cells}${bars}</div>`;
}
// 그날 숫자: 밤 투숙(입실~퇴실 전날) 마릿수 · 입실 · 퇴실
function dayInfo(d) {
  const live = hs.bookings.filter((b) => active(b) && b.check_in <= d && d <= b.check_out);
  const ins = live.filter((b) => b.check_in === d);
  const outs = live.filter((b) => b.check_out === d && b.check_in !== d);
  const stays = live.filter((b) => b.check_in < d && d < b.check_out);
  const night = live.filter((b) => d < b.check_out).reduce((n, b) => n + dogsIn(b.label), 0);
  return { live, ins, outs, stays, night };
}
const maxLanes = (wk) => {
  const ws = wk[0], we = wk[6];
  const list = hs.bookings.filter((b) => active(b) && b.check_in <= we && b.check_out >= ws)
    .sort((a, b) => a.check_in.localeCompare(b.check_in) || b.check_out.localeCompare(a.check_out));
  const lanes = [];
  for (const b of list) {
    const s0 = b.check_in < ws ? 0 : wk.indexOf(b.check_in), s1 = b.check_out > we ? 6 : wk.indexOf(b.check_out);
    const i = lanes.findIndex((e) => e < s0);
    if (i < 0) lanes.push(s1); else lanes[i] = s1;
  }
  return lanes.length;
};
// 요약 칸: 하루에 여러 마리여도 칸 크기가 그대로 — 숫자 + 이름 몇 개 + 더보기
const SUM_NAMES = 4;
function drawSumWeek(wk, t) {
  return `<div class="ho-week sum">${wk.map((d, i) => {
    const x = dayInfo(d);
    const order = [...x.ins.map((b) => [b, "in"]), ...x.stays.map((b) => [b, "stay"]), ...x.outs.map((b) => [b, "out"])];
    const shown = order.slice(0, SUM_NAMES), more = order.length - shown.length;
    return `<div class="ho-day ${d.slice(0, 7) !== hs.month ? "other" : ""} ${d === t ? "today" : ""} ${dow(d) === 0 ? "sun" : dow(d) === 6 ? "sat" : ""}" data-day="${d}" style="grid-column:${i + 1}">
      <div class="ho-sum-top"><span class="ho-dn">${+d.slice(8)}</span>${x.night ? `<em class="ho-occ" title="이날 밤 투숙 ${x.night}마리"><i>🏨 </i>${x.night}</em>` : ""}</div>
      ${x.ins.length || x.outs.length ? `<div class="ho-io">${x.ins.length ? `<span class="in">입실 ${x.ins.length}</span>` : ""}${x.outs.length ? `<span class="out">퇴실 ${x.outs.length}</span>` : ""}</div>` : ""}
      <div class="ho-names">${shown.map(([b, k]) => `<button class="ho-nm ${b.kind === "K" ? "k" : "h"} ${k} ${b.id === hs.highlight ? "hl" : ""}" data-bk="${b.id}">${k === "in" ? "▸" : k === "out" ? "◂" : ""}${esc(b.label)}${svcText(b) ? `<i class="ho-bang">!</i>` : ""}</button>`).join("")}
        ${more > 0 ? `<span class="ho-more d">+${more}건 더</span>` : ""}${order.length > 2 ? `<span class="ho-more m">+${order.length - 2}</span>` : ""}</div>
      <span class="ho-add" data-add="${d}" title="이 날 입실로 예약 추가">+ 예약</span></div>`;
  }).join("")}</div>`;
}
// 날짜를 누르면: 그날 입실·투숙·퇴실 전체 목록
function openDay(d) {
  const x = dayInfo(d);
  const sec = (title, list, cls) => list.length ? `<h3 class="ho-sub">${title} <small class="muted">${list.length}건</small></h3>${list.map((b) => {
    const c = custById(b.customer_id);
    return `<button class="ho-bk ${b.status} ${cls}" data-bk="${b.id}">${kindTag(b.kind)}<span class="grow"><b>${esc(b.label)}</b> <small class="muted">${esc(c?.owner_name || "")}</small>
      <br><small class="muted">${md(b.check_in)}${b.in_time ? " " + b.in_time : ""} → ${md(b.check_out)}${b.out_time ? " " + b.out_time : ""}${svcText(b) ? " · " + esc(svcText(b)) : ""}</small></span></button>`;
  }).join("")}` : "";
  const { ov, close } = modal(`
    <div class="rc-head"><div class="grow"><b>${md(d)} 호텔링</b><small class="muted">이날 밤 투숙 ${x.night}마리</small></div><button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">
      ${sec("▸ 입실", x.ins, "in")}${sec("투숙 중", x.stays, "")}${sec("◂ 퇴실", x.outs, "out")}
      ${x.live.length ? "" : `<p class="muted">이날 예약이 없어요.</p>`}
    </div>
    <div class="rc-foot"><span class="grow"></span><button class="btn primary sm" data-new>+ ${md(d)} 입실 예약</button></div>`);
  $$("[data-bk]", ov).forEach((b) => b.addEventListener("click", () => { close(); openBooking(hs.bookings.find((k) => k.id === b.dataset.bk)); }));
  $("[data-new]", ov).addEventListener("click", () => { close(); openBooking(null, { check_in: d, check_out: addDays(d, 1) }); });
}

function drawCalendar() {
  const main = $("#ho-main");
  const [y, m] = hs.month.split("-").map(Number);
  const first = `${hs.month}-01`;
  const start = addDays(first, -dow(first));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const weeks = days[35].slice(0, 7) === hs.month ? 6 : 5;
  const st = todayStats();
  const t = today();
  main.innerHTML = `
    <div class="ho-stats">
      <button data-st="in"><small>오늘 입실</small><b>${st.in.length}</b></button>
      <button data-st="stay"><small>지금 투숙 중</small><b>${st.stay.length}</b></button>
      <button data-st="out"><small>오늘 퇴실</small><b>${st.out.length}</b></button>
    </div>
    <div class="ho-head">
      <div class="ho-month">${hs.cal === "week"
        ? `<button class="btn ghost sm" data-wv="-7">‹</button><h2 class="ho-wk-title">${md(hs.week)} ~ ${md(addDays(hs.week, 6))}</h2><button class="btn ghost sm" data-wv="7">›</button><button class="btn ghost sm" data-wv="0">이번 주</button>`
        : `<button class="btn ghost sm" data-mv="-1">‹</button><h2>${y}년 ${m}월</h2><button class="btn ghost sm" data-mv="1">›</button><button class="btn ghost sm" data-mv="0">오늘</button>`}</div>
      <div class="ho-seg ho-calmode"><button data-cm="month" class="${hs.cal === "month" ? "on" : ""}">월간</button><button data-cm="week" class="${hs.cal === "week" ? "on" : ""}">주간</button></div>
      <div class="ho-actions"><div class="ho-csearch"><input id="cal-q" type="search" placeholder="강아지 이름으로 예약 찾기" autocomplete="off"><div id="cal-res"></div></div>
</div>
    </div>
    ${(() => {
      if (hs.cal === "week") {
        const wk = Array.from({ length: 7 }, (_, i) => addDays(hs.week, i));
        return `<div class="ho-cal ho-cal-week">
          ${wk.map((d, i) => { const x = dayInfo(d); return `<div class="ho-dow ${i === 0 ? "sun" : i === 6 ? "sat" : ""} ${d === t ? "today" : ""}">${DOW[i]} <small>${+d.slice(5, 7)}/${+d.slice(8)}</small>${x.night ? `<em class="ho-occ">🏨 ${x.night}</em>` : ""}</div>`; }).join("")}
          ${drawWeek(wk, t, "big")}
        </div>
        <p class="small muted">한 주를 크게 봐요 · 막대 하나가 입실(▸)부터 퇴실(◂)까지 · 🏨 그날 밤 투숙 마릿수 · 날짜 칸을 누르면 그날 목록</p>`;
      }
      const wks = Array.from({ length: weeks }, (_, w) => days.slice(w * 7, w * 7 + 7));
      const dense = Math.max(0, ...wks.map(maxLanes)) > 3;
      const sum = hs.monthMode === "sum" || (hs.monthMode === "auto" && dense);
      return `<div class="ho-viewbar"><span class="muted small">${sum ? "하루에 여러 마리라 <b>요약</b>으로 보여요" : "입실~퇴실을 막대로 보여요"}</span>
          <div class="ho-seg ho-mm"><button data-mm="bars" class="${!sum ? "on" : ""}">막대</button><button data-mm="sum" class="${sum ? "on" : ""}">요약</button></div></div>
        <div class="ho-cal ${sum ? "ho-cal-sum" : ""}">
          ${DOW.map((d, i) => `<div class="ho-dow ${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${d}</div>`).join("")}
          ${wks.map((wk) => (sum ? drawSumWeek(wk, t) : drawWeek(wk, t))).join("")}
        </div>
        <p class="small muted">${sum
          ? "🏨 그날 밤 투숙 마릿수 · ▸입실 ◂퇴실 · <b>날짜를 누르면 그날 전체 목록</b>이 떠요 · 한 주를 크게 보려면 ‘주간’"
          : "<b>날짜를 누르면 그날 목록</b> · 막대 하나가 입실(▸)부터 퇴실(◂)까지 · 요금은 퇴실하는 날 끝에 표시"} · <i class="ho-bang">!</i> 미용·픽드랍 등 추가 서비스</p>`;
    })()}
    ${(() => {
      const end = addDays(days[weeks * 7 - 1], 0);
      const list = hs.bookings.filter((b) => b.check_in.slice(0, 7) <= hs.month && b.check_out.slice(0, 7) >= hs.month)
        .sort((a, b) => a.check_in.localeCompare(b.check_in) || a.label.localeCompare(b.label, "ko"));
      return `<h3 class="ho-sub">${m}월 호텔링 예약 <small class="muted">${list.filter(active).length}건</small></h3>` + (list.length ? `<div class="ho-table ho-mlist">
        <div class="ho-tr ho-th"><span>구분</span><span>강아지</span><span>입실</span><span>퇴실</span><span>숙박</span><span>정산</span><span>상태</span></div>
        ${list.map((b) => `<button class="ho-tr ${b.status} ${b.id === hs.highlight ? "hl" : ""}" data-bk="${b.id}">
          <span>${kindTag(b.kind)}</span><span class="ho-pet">${esc(b.label)}</span>
          <span>${md(b.check_in)}${b.in_time ? ` ${b.in_time}` : ""}</span>
          <span>${md(b.check_out)}${b.out_time ? ` ${b.out_time}` : ""}</span>
          <span class="muted">${nightsOf(b.check_in, b.check_out).length}박</span>
          <span class="ho-money">${won(b.total)} ${payTag(b)}</span>
          <span class="muted">${STATUS[b.status]}</span></button>`).join("")}</div>` : `<p class="muted small">이번 달 예약이 없어요.</p>`);
    })()}`;
  $$("[data-mv]", main).forEach((b) => b.addEventListener("click", () => {
    const k = +b.dataset.mv;
    if (!k) hs.month = today().slice(0, 7);
    else { const d = new Date(Date.UTC(y, m - 1 + k, 1)); hs.month = d.toISOString().slice(0, 7); }
    hs.highlight = null; drawCalendar();
  }));
  $$("[data-st]", main).forEach((b) => b.addEventListener("click", () => openStatList(b.dataset.st, st[b.dataset.st])));
  $$("[data-bk]", main).forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openBooking(hs.bookings.find((x) => x.id === b.dataset.bk)); }));
  $$("[data-day]", main).forEach((c) => c.addEventListener("click", () => openDay(c.dataset.day)));
  $$("[data-add]", main).forEach((c) => c.addEventListener("click", (e) => { e.stopPropagation(); openBooking(null, { check_in: c.dataset.add, check_out: addDays(c.dataset.add, 1) }); }));
  $$("[data-cm]", main).forEach((b) => b.addEventListener("click", () => {
    hs.cal = b.dataset.cm;
    if (hs.cal === "week" && !hs.week) { const tt = today(); hs.week = hs.month === tt.slice(0, 7) ? addDays(tt, -dow(tt)) : addDays(`${hs.month}-01`, -dow(`${hs.month}-01`)); }
    drawCalendar();
  }));
  $$("[data-mm]", main).forEach((b) => b.addEventListener("click", () => { hs.monthMode = b.dataset.mm; drawCalendar(); }));
  $$("[data-wv]", main).forEach((b) => b.addEventListener("click", () => {
    const k = +b.dataset.wv, tt = today();
    hs.week = k ? addDays(hs.week, k) : addDays(tt, -dow(tt));
    hs.month = addDays(hs.week, 3).slice(0, 7);
    drawCalendar();
  }));
  const q = $("#cal-q");
  q.addEventListener("input", () => {
    const s = q.value.trim().toLowerCase();
    const res = s ? hs.bookings.filter((b) => nameHit(b.label, s) || petsOf(b.customer_id).some((p) => nameHit(p.name, s)))
      .sort((a, b) => b.check_in.localeCompare(a.check_in)).slice(0, 12) : [];
    $("#cal-res").innerHTML = res.length ? res.map((b) => `<button data-go="${b.id}">${kindTag(b.kind)} ${esc(b.label)} <small>${md(b.check_in)} → ${md(b.check_out)}${b.status === "cancelled" ? " · 취소" : ""}</small></button>`).join("")
      : s ? `<p class="muted small">없어요</p>` : "";
    $$("[data-go]", $("#cal-res")).forEach((x) => x.addEventListener("click", () => {
      const b = hs.bookings.find((k) => k.id === x.dataset.go);
      hs.month = b.check_in.slice(0, 7); hs.highlight = b.id;
      if (hs.cal === "week") hs.week = addDays(b.check_in, -dow(b.check_in));
      drawCalendar();
      $(`.ho-chip[data-bk="${b.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }));
  });
}
function openStatList(kind, list) {
  const title = { in: "오늘 입실", stay: "지금 투숙 중", out: "오늘 퇴실" }[kind];
  const { ov, close } = modal(`
    <div class="rc-head"><b class="grow">${title} ${list.length}건</b><button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">${list.length ? list.map((b) => {
      const c = custById(b.customer_id);
      return `<button class="ho-bk ${b.status}" data-bk="${b.id}">${kindTag(b.kind)}<span class="grow"><b>${esc(b.label)}</b> <small class="muted">${esc(c?.owner_name || "")} ${esc(c?.phone || "")}</small>
        <br><small class="muted">${md(b.check_in)}${b.in_time ? " " + b.in_time : ""} → ${md(b.check_out)}${b.out_time ? " " + b.out_time : ""} · ${STATUS[b.status]}${svcText(b) ? " · " + svcText(b) : ""}</small></span></button>`;
    }).join("") : `<p class="muted">없어요</p>`}</div>`);
  $$("[data-bk]", ov).forEach((b) => b.addEventListener("click", () => { close(); openBooking(hs.bookings.find((x) => x.id === b.dataset.bk)); }));
}

/* ---------- 예약 등록·수정 ---------- */
function openBooking(bk, preset = {}) {
  const qd = preset.quickDog || null; // 유치원 명단에서 처음 불러온 아이 (저장할 때 K 고객으로 등록)
  const quick = !!preset.quick && !bk;
  const b = bk ? { ...bk, manual: { ...(bk.manual || {}) }, services: JSON.parse(JSON.stringify(bk.services || {})) } : {
    customer_id: preset.customer?.id || null, kind: qd ? "K" : preset.customer?.kind || "H",
    label: qd ? baseName(qd.name) : preset.customer ? custLabel(preset.customer) : "", services: {},
    check_in: preset.check_in || today(), check_out: preset.check_out || addDays(preset.check_in || today(), 1),
    in_time: preset.in_time || "", out_time: preset.out_time || "",
    pickup: false, drop_off: false, status: "booked", notes: "", manual: {}, extra_cost: 0, discount: 0,
  };
  const { ov, close } = modal(`
    <div class="rc-head"><div class="grow"><b>${bk ? "예약 상세" : quick ? "유치원생 호텔링 예약" : "호텔링 예약 등록"}</b><small class="muted" id="bk-sub"></small></div>
      <button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body ho-form ${quick ? "quick" : ""}">
      <label class="ho-line">고객<div id="bk-cust"></div></label>
      <div class="ho-grid">
        <label class="q-hide">구분<div class="ho-seg" id="bk-kind"><button type="button" data-k="H">H 일반</button><button type="button" data-k="K">K 유치원생</button></div></label>
        <label class="q-hide">예약 상태<select id="bk-status">${Object.entries(STATUS).map(([k, n]) => `<option value="${k}" ${b.status === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="full q-hide">강아지 이름 <small class="muted">다견은 슬래시로: 비비/모모</small><input id="bk-label" value="${esc(b.label)}"><small id="bk-dogs" class="muted"></small></label>
        <label>입실 날짜<input id="bk-in" type="date" value="${b.check_in}"></label>
        <label>입실 시간<input id="bk-intime" type="time" value="${esc(b.in_time || "")}"></label>
        <label>퇴실 날짜<input id="bk-out" type="date" value="${b.check_out}"></label>
        <label>퇴실 시간<input id="bk-outtime" type="time" value="${esc(b.out_time || "")}"></label>
      </div>
      <h3>추가 서비스 <small class="muted">눌러서 켜고 꺼요</small></h3>
      <div class="ho-svc">${SVC.map(([k, ic, n]) => `<button type="button" data-svc="${k}"><span>${ic}</span>${n}</button>`).join("")}</div>
      <div id="bk-dc" class="ho-dc"></div>
      <label class="ho-line q-hide">메모<textarea id="bk-notes" rows="2">${esc(b.notes || "")}</textarea></label>
      <h3>요금 내역</h3>
      <div id="bk-fee" class="ho-fee"></div>
      <label class="ho-prepaid"><input type="checkbox" id="bk-prepaid" ${b.prepaid ? "checked" : ""}> 💳 선결제 완료</label>
    </div>
    <div class="rc-foot">
      ${bk ? `<button class="btn ghost sm danger" id="bk-del">삭제</button>${b.status !== "cancelled" ? `<button class="btn ghost sm" id="bk-cancel">예약 취소</button>` : ""}` : ""}
      <span class="grow"></span>
      <button class="btn ghost sm" data-close>닫기</button><button class="btn primary sm" id="bk-save">저장</button></div>`, "wide");

  // 고객 고르기
  const drawCust = () => {
    if (qd) {
      $("#bk-cust", ov).innerHTML = `<div class="ho-picked">${kindTag("K")} <b>${esc(baseName(qd.name))}</b> <small class="muted">유치원 명단에서 불러옴 · 저장하면 호텔링 고객으로도 등록돼요</small></div>`;
      return;
    }
    const c = custById(b.customer_id);
    $("#bk-sub", ov).textContent = c ? `${c.owner_name || ""} ${c.phone || ""}` : "";
    $("#bk-cust", ov).innerHTML = c
      ? `<div class="ho-picked">${kindTag(c.kind)} <b>${esc(custLabel(c))}</b> <small class="muted">${esc(c.owner_name || "")} ${esc(c.phone || "")}</small><button type="button" class="btn ghost mini" id="bk-chg">바꾸기</button></div>`
      : `<div class="ho-csearch"><input id="bk-cq" type="search" placeholder="강아지·보호자 이름, 전화번호" autocomplete="off"><div id="bk-cres"></div></div>
         <button type="button" class="btn ghost mini" id="bk-newc">+ 새 고객 등록</button>`;
    $("#bk-chg", ov)?.addEventListener("click", () => { b.customer_id = null; drawCust(); });
    $("#bk-newc", ov)?.addEventListener("click", () => { close(); openCustomerForm(null); });
    const q = $("#bk-cq", ov);
    q?.addEventListener("input", () => {
      const s = q.value.trim();
      const res = s ? hs.customers.filter((c) => matches(c, s)).slice(0, 8) : [];
      const linkedIds = new Set(hs.pets.map((p) => p.dog_id).filter(Boolean));
      const roster = s ? C.dogs.filter((d) => !d.auto && !linkedIds.has(d.id) && nameHit(d.name, s)).slice(0, 6) : [];
      $("#bk-cres", ov).innerHTML = res.map((c) => `<button type="button" data-pc="${c.id}">${kindTag(c.kind)} ${esc(custLabel(c))} <small>${esc(c.owner_name || "")} ${esc(c.phone || "")}</small></button>`).join("")
        + roster.map((d) => `<button type="button" data-pd="${d.id}">${kindTag("K")} ${esc(d.name)} <small>유치원 명단</small></button>`).join("")
        || (s ? `<p class="muted small">없어요. ‘새 고객 등록’을 눌러 주세요.</p>` : "");
      $$("[data-pd]", ov).forEach((x) => x.addEventListener("click", () => { close(); openBooking(null, { ...preset, quickDog: C.dogs.find((d) => d.id === x.dataset.pd), quick: true, check_in: b.check_in, check_out: b.check_out }); }));
      $$("[data-pc]", ov).forEach((x) => x.addEventListener("click", () => {
        const c = custById(x.dataset.pc);
        b.customer_id = c.id; b.kind = c.kind;
        if (!$("#bk-label", ov).value.trim()) $("#bk-label", ov).value = custLabel(c);
        drawKind(); drawCust(); drawFee();
      }));
    });
    q?.focus();
  };
  const drawKind = () => $$("#bk-kind [data-k]", ov).forEach((x) => x.classList.toggle("on", x.dataset.k === b.kind));
  $$("#bk-kind [data-k]", ov).forEach((x) => x.addEventListener("click", () => { b.kind = x.dataset.k; drawKind(); drawFee(); }));

  // 요금
  const read = () => {
    b.label = $("#bk-label", ov).value.trim();
    b.check_in = $("#bk-in", ov).value; b.check_out = $("#bk-out", ov).value;
    b.in_time = $("#bk-intime", ov).value; b.out_time = $("#bk-outtime", ov).value;
    b.status = $("#bk-status", ov).value; b.notes = $("#bk-notes", ov).value.trim();
    b.prepaid = $("#bk-prepaid", ov).checked;
  };
  const fee = () => calcFee(b);
  // 목욕·미용 금액은 몸무게마다 달라서 직접 적음 → 참고용으로 몸무게 보여 줌
  const weights = () => petsOf(b.customer_id).filter((p) => p.weight).map((p) => `${p.name} ${p.weight}kg`).join(", ");
  const drawSvc = () => {
    $$("[data-svc]", ov).forEach((x) => x.classList.toggle("on", svcOn(b, x.dataset.svc)));
    const dc = b.services.daycare;
    $("#bk-dc", ov).innerHTML = dc ? `<label>☀️ 추가데이케어 <input id="bk-dch" type="number" min="0" step="0.5" inputmode="decimal" value="${dc.hours ?? ""}" placeholder="0"> 시간</label>` : "";
    $("#bk-dch", ov)?.addEventListener("input", (e) => { b.services.daycare.hours = Number(e.target.value) || 0; drawFee(); });
  };
  $$("[data-svc]", ov).forEach((x) => x.addEventListener("click", () => {
    const k = x.dataset.svc;
    if (k === "pickup") b.pickup = !b.pickup;
    else if (k === "drop") b.drop_off = !b.drop_off;
    else if (b.services[k]) delete b.services[k];
    else b.services[k] = k === "daycare" ? { hours: null } : {};
    drawSvc(); drawFee();
    if (k === "daycare" && b.services.daycare) $("#bk-dch", ov)?.focus();
  }));
  function drawFee() {
    read();
    const calc = fee();
    const s = settle(calc, b.manual, b.extra_cost, b.discount);
    $("#bk-dogs", ov).textContent = b.label ? `${calc.dogs}마리${calc.dogs > 1 ? ` (추가 ${calc.dogs - 1}마리)` : ""}` : "";
    const line = (key, name, detail) => {
      const man = b.manual[key] != null;
      return `<div class="ho-fr ${man ? "man" : ""}"><span>${name}${detail ? `<small>${esc(detail)}</small>` : ""}</span>
        <span class="ho-amt">${man ? `<em>직접 입력</em>` : ""}<input type="number" step="1000" data-man="${key}" value="${s[key]}">${man ? `<button type="button" class="btn ghost mini" data-reset="${key}" title="자동 계산으로">↺ ${won(calc[key])}</button>` : ""}</span></div>`;
    };
    const bad = b.check_in && b.check_out && b.check_out < b.check_in;
    $("#bk-fee", ov).innerHTML = bad ? `<p class="err">퇴실 날짜가 입실 날짜보다 빨라요.</p>` : `
      <div class="ho-fr head"><span>${kindTag(b.kind)} ${esc(b.label || "")}</span><span>${md(b.check_in)} → ${md(b.check_out)} · <b>${calc.nights}박</b></span></div>
      ${line("base", "호텔링 기본 요금", calc.base_detail)}
      ${line("extra", "다견 추가 요금", calc.extra_detail)}
      ${b.pickup || s.pickup ? line("pickup", "🚗 픽업", b.pickup ? `편도 ${b.kind === "K" ? "5,000" : "8,000"}` : "") : ""}
      ${b.drop_off || s.drop ? line("drop", "🏠 드랍", b.drop_off ? `편도 ${b.kind === "K" ? "5,000" : "8,000"}` : "") : ""}
      ${calc.svc.length && weights() ? `<div class="ho-fr"><small>참고 몸무게 · ${esc(weights())}</small></div>` : ""}
      ${calc.svc.map((x) => {
        const [, ic, n] = SVC.find(([k]) => k === x.key);
        return `<div class="ho-fr ${x.set ? "" : "need"}"><span>${ic} ${n}${x.key === "daycare" ? `<small>${x.hours || 0}시간</small>` : ""}${x.set ? "" : `<small class="warn">금액을 적어 주세요</small>`}</span>
          <span class="ho-amt"><input type="number" step="1000" data-svcp="${x.key}" value="${x.set ? x.amount : ""}" placeholder="금액"></span></div>`;
      }).join("")}
      <div class="ho-fr"><span>기타 추가 비용</span><span class="ho-amt"><input type="number" step="1000" id="bk-xtra" value="${b.extra_cost || 0}"></span></div>
      <div class="ho-fr"><span>할인</span><span class="ho-amt">−<input type="number" step="1000" id="bk-disc" value="${b.discount || 0}"></span></div>
      <div class="ho-fr total ${b.manual.total != null ? "man" : ""}"><span>최종 합계</span><span class="ho-amt">${b.manual.total != null ? `<em>직접 입력</em>` : ""}<input type="number" step="1000" data-man="total" value="${s.total}">${b.manual.total != null ? `<button type="button" class="btn ghost mini" data-reset="total" title="자동 합계로">↺ ${won(s.auto_total)}</button>` : ""}</span></div>
      <p class="small muted">금액 칸을 고치면 ‘직접 입력’으로 저장돼요. 날짜를 바꿔도 직접 입력한 금액은 그대로예요. ↺를 누르면 자동 계산으로 돌아가요.</p>`;
    $$("[data-man]", ov).forEach((el) => el.addEventListener("change", () => {
      const k = el.dataset.man, nv = Math.round(Number(el.value) || 0);
      const autoV = k === "total" ? settle(fee(), { ...b.manual, total: undefined }, b.extra_cost, b.discount).auto_total : fee()[k];
      if (nv === autoV) delete b.manual[k]; else b.manual[k] = nv;
      drawFee();
    }));
    $$("[data-reset]", ov).forEach((el) => el.addEventListener("click", () => { delete b.manual[el.dataset.reset]; drawFee(); }));
    $$("[data-svcp]", ov).forEach((el) => el.addEventListener("change", () => {
      const k = el.dataset.svcp;
      if (el.value === "") delete b.services[k].price; else b.services[k].price = Math.round(Number(el.value) || 0);
      drawFee();
    }));
    $("#bk-xtra", ov)?.addEventListener("change", (e) => { b.extra_cost = Math.round(Number(e.target.value) || 0); drawFee(); });
    $("#bk-disc", ov)?.addEventListener("change", (e) => { b.discount = Math.round(Number(e.target.value) || 0); drawFee(); });
  }
  ["#bk-label", "#bk-in", "#bk-out", "#bk-intime", "#bk-outtime"].forEach((s) => $(s, ov).addEventListener(s === "#bk-label" ? "input" : "change", () => {
    if (s === "#bk-in" && $("#bk-out", ov).value < $("#bk-in", ov).value) $("#bk-out", ov).value = addDays($("#bk-in", ov).value, 1);
    drawFee();
  }));
  drawKind(); drawCust(); drawSvc(); drawFee();

  $("#bk-save", ov).addEventListener("click", async () => {
    read();
    if (b.services.daycare && !(Number(b.services.daycare.hours) > 0)) { toast("추가데이케어가 몇 시간인지 적어 주세요"); $("#bk-dch", ov)?.focus(); return; }
    if (qd && !b.customer_id) {
      if (!b.check_in || !b.check_out || b.check_out < b.check_in) { toast("입실·퇴실 날짜를 확인해 주세요"); return; }
      const dup = hs.pets.find((p) => p.dog_id === qd.id);
      if (dup) b.customer_id = dup.customer_id;
      else {
        const { data: cu, error } = await C.sb.from("hotel_customers").insert({ kind: "K" }).select().single();
        if (error) { toast("저장하지 못했어요"); return; }
        const pr = await C.sb.from("hotel_pets").insert({ customer_id: cu.id, name: baseName(qd.name), breed: breedOf(qd.name) || null, dog_id: qd.id });
        if (pr.error) { await C.sb.from("hotel_customers").delete().eq("id", cu.id); toast("저장하지 못했어요"); return; }
        b.customer_id = cu.id;
      }
    }
    if (!b.customer_id) { toast("고객을 골라 주세요"); return; }
    if (!b.label) { toast("강아지 이름을 적어 주세요"); return; }
    if (!b.check_in || !b.check_out || b.check_out < b.check_in) { toast("입실·퇴실 날짜를 확인해 주세요"); return; }
    const calc = fee();
    const s = settle(calc, b.manual, b.extra_cost, b.discount);
    const row = {
      customer_id: b.customer_id, kind: b.kind, label: b.label, check_in: b.check_in, in_time: b.in_time || null,
      check_out: b.check_out, out_time: b.out_time || null, pickup: !!b.pickup, drop_off: !!b.drop_off, status: b.status, services: b.services, prepaid: !!b.prepaid,
      notes: b.notes || null, calc, manual: b.manual, extra_cost: b.extra_cost || 0, discount: b.discount || 0, total: s.total,
      updated_at: new Date().toISOString(),
    };
    const btn = $("#bk-save", ov); btn.disabled = true;
    const r = bk ? await C.sb.from("hotel_bookings").update(row).eq("id", bk.id).select().single() : await C.sb.from("hotel_bookings").insert(row).select().single();
    if (r.error) { btn.disabled = false; toast("저장하지 못했어요"); console.error(r.error); return; }
    close();
    toast(bk ? "예약을 고쳤어요" : `예약했어요 · ${won(s.total)}`);
    hs.highlight = r.data.id; hs.month = b.check_in.slice(0, 7);
    await refresh();
  });
  $("#bk-cancel", ov)?.addEventListener("click", async () => {
    if (!confirm(`${b.label} ${md(b.check_in)} 예약을 취소할까요?\n기록은 남고 캘린더에서만 빠져요.`)) return;
    await C.sb.from("hotel_bookings").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", bk.id);
    close(); toast("예약을 취소했어요"); refresh();
  });
  $("#bk-del", ov)?.addEventListener("click", async () => {
    if (!confirm(`${b.label} ${md(b.check_in)} 예약을 완전히 삭제할까요?\n이용 이력에서도 사라져요. 되돌릴 수 없어요.`)) return;
    await C.sb.from("hotel_bookings").delete().eq("id", bk.id);
    close(); toast("예약을 삭제했어요"); refresh();
  });
}
