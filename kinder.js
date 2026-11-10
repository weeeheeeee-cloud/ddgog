// 유치원 회원 관리 (호텔링 고객 관리와 같은 모양)
// 회원 명단은 kinder_members 에 저장. 다이얼독 회원 명단을 북마크(dd-push.js)의 '회원 명단 가져오기'로 불러와 갱신
// 다이얼독에서 온 정보(이름·견종·보호자·전화·주소·다이얼독 메모)는 불러올 때마다 바뀌고, '우리 메모'(notes)는 그대로 남음
// app.js 가 유치원 탭을 열 때 renderKinder(ctx) 로 부름

let C = null; // { sb, toast, signed, esc, dogs }
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ks = { q: "", showGone: false, members: [], hotelDogIds: new Set(), pickupNames: new Set() };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const digits = (s) => String(s || "").replace(/\D/g, "");
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const fmtPhone = (v) => {
  const d = digits(v);
  return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : String(v || "").trim();
};
const GENDER = { M: "남아", F: "여아" };
const NEUT = { neutered: "중성화 완료", unneutered: "중성화 안 함" };
function ageOf(bd) {
  if (!bd) return "";
  const [y, m, d] = bd.split("-").map(Number), [ty, tm, td] = kstToday().split("-").map(Number);
  let a = ty - y; if (tm < m || (tm === m && td < d)) a--;
  if (a < 1) { const mo = (ty - y) * 12 + (tm - m) - (td < d ? 1 : 0); return `${Math.max(0, mo)}개월`; }
  return `${a}살`;
}
const isBirthday = (bd) => !!bd && bd.slice(5) === kstToday().slice(5);
const ago = (ts) => {
  if (!ts) return "";
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  if (m < 1) return "방금"; if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60); if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
};
function toast(m, ms) { C?.toast?.(m, ms); }

async function load() {
  const [m, hp, pd] = await Promise.all([
    C.sb.from("kinder_members").select("*").order("name"),
    C.sb.from("hotel_pets").select("dog_id"),
    C.sb.from("pd_dogs").select("phone"),
  ]);
  if (m.error) throw m.error;
  ks.members = m.data || [];
  ks.hotelDogIds = new Set((hp.data || []).map((x) => x.dog_id).filter(Boolean));
  ks.pickupPhones = new Set((pd.data || []).map((x) => digits(x.phone)).filter(Boolean));
}
const dogOf = (m) => (m.dog_id ? C.dogs.find((d) => d.id === m.dog_id) : null);

export async function renderKinder(ctx) {
  C = ctx;
  const root = $("#tab-kinder");
  root.innerHTML = `<div class="kd"><p class="muted">불러오는 중…</p></div>`;
  try { await load(); } catch (e) { console.error(e); root.innerHTML = `<p class="err">불러오지 못했어요. 새로고침해 주세요.</p>`; return; }
  draw();
}

function draw() {
  const root = $("#tab-kinder");
  const act = ks.members.filter((m) => m.active);
  const gone = ks.members.length - act.length;
  const synced = ks.members.map((m) => m.synced_at).filter(Boolean).sort().pop();
  const bdays = act.filter((m) => isBirthday(m.birthday));
  root.innerHTML = `<div class="kd">
    <div class="ho-head">
      <h2>유치원 회원 <small class="muted" id="kd-count"></small></h2>
      <div class="ho-actions">
        <button class="btn ghost sm" id="kd-sync">🔄 다이얼독에서 불러오기</button>
        <button class="btn primary sm" id="kd-new">+ 신규 회원</button>
      </div>
    </div>
    ${synced ? `<p class="kd-sync muted">다이얼독 명단 ${ago(synced)} 불러옴 · 메모는 불러와도 그대로 남아요</p>` : ""}
    ${bdays.length ? `<div class="kd-bday">🎂 오늘 생일: ${bdays.map((m) => `<button data-open="${m.id}">${esc(m.name)}</button>`).join(", ")}</div>` : ""}
    <div class="kd-tools">
      <input id="kd-q" class="ho-search" type="search" placeholder="강아지 이름 · 보호자 이름 · 전화번호 · 견종" value="${esc(ks.q)}" autocomplete="off">
      ${gone ? `<label class="kd-gone"><input type="checkbox" id="kd-showgone" ${ks.showGone ? "checked" : ""}> 그만 다니는 아이 ${gone}마리 보기</label>` : ""}
    </div>
    <div id="kd-list"></div>
  </div>`;
  $("#kd-new", root).addEventListener("click", () => openForm(null));
  $("#kd-sync", root).addEventListener("click", openSync);
  $("#kd-q", root).addEventListener("input", (e) => { ks.q = e.target.value; drawList(); });
  $("#kd-showgone", root)?.addEventListener("change", (e) => { ks.showGone = e.target.checked; drawList(); });
  $$("[data-open]", root).forEach((b) => b.addEventListener("click", () => openMember(b.dataset.open)));
  drawList();
}

function matches(m, q) {
  if (!q) return true;
  const t = q.trim().toLowerCase(), d = digits(q);
  const hay = [m.name, m.owner_name, m.breed, ...(m.owners || []).map((o) => o.name)].join(" ").toLowerCase();
  return hay.includes(t) || (d.length >= 2 && [m.phone, ...(m.owners || []).map((o) => o.phone)].some((p) => digits(p).includes(d)));
}

async function drawList() {
  const box = $("#kd-list");
  const pool = ks.members.filter((m) => m.active || ks.showGone);
  const list = pool.filter((m) => matches(m, ks.q));
  $("#kd-count").textContent = ks.q ? `${list.length} / ${pool.length}마리` : `${pool.length}마리`;
  if (!ks.members.length) {
    box.innerHTML = `<div class="ho-empty"><b>아직 유치원 회원이 없어요</b><p class="muted"><b>다이얼독에서 불러오기</b>로 다이얼독 회원 명단을 한 번에 가져오거나, <b>신규 회원</b>으로 직접 넣어 주세요.</p></div>`;
    return;
  }
  if (!list.length) { box.innerHTML = `<p class="muted">‘${esc(ks.q)}’에 맞는 아이가 없어요.</p>`; return; }
  const refPaths = list.map((m) => dogOf(m)?.ref_path).filter(Boolean);
  const ref = await C.signed("refs", refPaths);
  box.innerHTML = `<div class="ho-table kd-table">
    <div class="ho-tr ho-th"><span></span><span>강아지</span><span>보호자</span><span>전화번호</span><span>메모</span></div>
    ${list.map((m) => {
      const dog = dogOf(m);
      const memo = [m.notes, m.dd_memo].filter(Boolean).join(" · ");
      return `<button class="ho-tr ${m.active ? "" : "gone"}" data-m="${m.id}">
        <span>${dog?.ref_path ? `<img class="kd-av" src="${ref(dog.ref_path)}" alt="">` : `<i class="kd-av none">🐶</i>`}</span>
        <span class="kd-name"><b>${esc(m.name)}${isBirthday(m.birthday) ? " 🎂" : ""}</b><small>${esc([m.breed, GENDER[m.gender]].filter(Boolean).join(" · "))}${m.active ? "" : " · 그만 다님"}</small></span>
        <span>${esc(m.owner_name || "")}</span>
        <span class="ho-phone">${esc(m.phone || "")}</span>
        <span class="muted kd-memo">${esc(memo)}</span>
      </button>`;
    }).join("")}</div>`;
  $$("[data-m]", box).forEach((b) => b.addEventListener("click", () => openMember(b.dataset.m)));
}

/* ---------- 팝업 ---------- */
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

async function openMember(id) {
  const m = ks.members.find((x) => x.id === id);
  if (!m) return;
  const dog = dogOf(m);
  const ref = await C.signed("refs", dog?.ref_path ? [dog.ref_path] : []);
  const row = (k, v) => (v ? `<div class="ho-kv"><span>${k}</span><b>${v}</b></div>` : "");
  const others = (m.owners || []).filter((o) => !o.main && (o.name || o.phone));
  const links = [
    dog ? `<span class="hk-link">사진함 명단 연결</span>` : `<span class="kd-nolink">사진함 명단 없음</span>`,
    dog && ks.hotelDogIds.has(dog.id) ? `<span class="hk-link">호텔링 고객</span>` : "",
    m.phone && ks.pickupPhones.has(digits(m.phone)) ? `<span class="hk-link">픽드랍 등록</span>` : "",
    m.dd_pet_id ? `<span class="hk-link">다이얼독 회원</span>` : `<span class="kd-nolink">직접 넣은 회원</span>`,
  ].filter(Boolean).join(" ");
  const { ov, close } = modal(`
    <div class="rc-head"><div class="grow"><b class="ho-title"><b class="hk k">K</b> ${esc(m.name)}${isBirthday(m.birthday) ? " 🎂" : ""}</b>
      <small class="muted">${esc([m.breed, m.owner_name && `보호자 ${m.owner_name}`].filter(Boolean).join(" · "))}${m.active ? "" : " · 그만 다님"}</small></div>
      <button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">
      <div class="kd-links">${links}</div>
      <div class="ho-cols">
        <section><h3>보호자</h3>
          ${row("이름", esc(m.owner_name))}
          ${row("전화", m.phone ? `<a href="tel:${esc(digits(m.phone))}">${esc(m.phone)}</a>` : "")}
          ${row("주소", esc(m.address))}
          ${others.map((o) => row("다른 보호자", `${esc(o.name || "")}${o.phone ? ` · <a href="tel:${esc(digits(o.phone))}">${esc(o.phone)}</a>` : ""}`)).join("")}
          ${!m.owner_name && !m.phone && !m.address ? `<p class="muted small">아직 없어요</p>` : ""}
        </section>
        <section><h3>강아지</h3>
          <div class="ho-pet-card">${dog?.ref_path ? `<img src="${ref(dog.ref_path)}" alt="">` : ""}<div>
            <b>${esc(m.name)}</b><br><small class="muted">${[m.breed, GENDER[m.gender], NEUT[m.neutered], m.birthday ? `${ageOf(m.birthday)} (${m.birthday})` : "", m.weight ? `${m.weight}kg` : ""].filter(Boolean).map(esc).join(" · ") || "정보 없음"}</small></div></div>
        </section>
      </div>
      ${m.dd_memo ? `<section><h3>다이얼독 메모</h3><p class="ho-pre">${esc(m.dd_memo)}</p></section>` : ""}
      <section><h3>우리 메모 <small class="muted">다이얼독에서 불러와도 지워지지 않아요</small></h3>
        <textarea id="kd-notes" rows="3" class="kd-notes" placeholder="선생님들끼리 알아야 할 것 (성격, 주의할 점, 픽드랍 정보 등)">${esc(m.notes || "")}</textarea>
        <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn primary sm" id="kd-notes-save" disabled>메모 저장</button></div>
      </section>
      ${m.synced_at ? `<p class="small muted">다이얼독에서 ${ago(m.synced_at)} 불러온 정보예요</p>` : ""}
    </div>
    <div class="rc-foot">
      ${m.dd_pet_id ? `<button class="btn ghost sm" data-gone>${m.active ? "그만 다님으로" : "다시 다님으로"}</button>` : `<button class="btn ghost sm danger" data-del>회원 삭제</button>`}
      <span class="grow"></span>
      <button class="btn ghost sm" data-edit>정보 수정</button>
    </div>`, "wide");
  const ta = $("#kd-notes", ov), sv = $("#kd-notes-save", ov);
  ta.addEventListener("input", () => { sv.disabled = ta.value === (m.notes || ""); });
  sv.addEventListener("click", async () => {
    sv.disabled = true;
    const { error } = await C.sb.from("kinder_members").update({ notes: ta.value.trim() || null, updated_at: new Date().toISOString() }).eq("id", m.id);
    if (error) { toast("저장하지 못했어요"); sv.disabled = false; return; }
    m.notes = ta.value.trim() || null; toast("메모를 저장했어요"); drawList();
  });
  $("[data-edit]", ov).addEventListener("click", () => { close(); openForm(m); });
  $("[data-gone]", ov)?.addEventListener("click", async () => {
    const { error } = await C.sb.from("kinder_members").update({ active: !m.active, updated_at: new Date().toISOString() }).eq("id", m.id);
    if (error) { toast("바꾸지 못했어요"); return; }
    m.active = !m.active; close(); toast(m.active ? "다시 다니는 아이로 바꿨어요" : "그만 다니는 아이로 바꿨어요"); draw();
  });
  $("[data-del]", ov)?.addEventListener("click", async () => {
    if (!confirm(`'${m.name}' 회원을 삭제할까요? 되돌릴 수 없어요.\n(사진함 명단은 그대로예요)`)) return;
    const { error } = await C.sb.from("kinder_members").delete().eq("id", m.id);
    if (error) { toast("삭제하지 못했어요"); return; }
    ks.members = ks.members.filter((x) => x.id !== m.id); close(); toast("삭제했어요"); draw();
  });
}

/* ---------- 등록·수정 ---------- */
function openForm(m) {
  const v = m || {};
  const { ov, close } = modal(`
    <div class="rc-head"><div class="grow"><b>${m ? `${esc(m.name)} 정보 수정` : "신규 유치원 회원"}</b>
      ${m?.dd_pet_id ? `<small class="muted">다이얼독 회원이라 다음에 불러오면 다이얼독 정보로 바뀌어요. 바꿀 건 다이얼독에서도 고쳐 주세요 (우리 메모는 그대로)</small>` : ""}</div>
      <button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">
      <h3>강아지</h3>
      <div class="ho-grid">
        <label>이름<input id="kf-name" value="${esc(v.name || "")}"></label>
        <label>견종<input id="kf-breed" value="${esc(v.breed || "")}"></label>
        <label>성별<select id="kf-gender"><option value="">모름</option><option value="M" ${v.gender === "M" ? "selected" : ""}>남아</option><option value="F" ${v.gender === "F" ? "selected" : ""}>여아</option></select></label>
        <label>중성화<select id="kf-neut"><option value="">모름</option><option value="neutered" ${v.neutered === "neutered" ? "selected" : ""}>완료</option><option value="unneutered" ${v.neutered === "unneutered" ? "selected" : ""}>안 함</option></select></label>
        <label>생일<input id="kf-bd" type="date" value="${esc(v.birthday || "")}"></label>
        <label>몸무게 (kg)<input id="kf-w" inputmode="decimal" value="${v.weight ?? ""}"></label>
      </div>
      <h3>보호자</h3>
      <div class="ho-grid">
        <label>보호자 이름<input id="kf-owner" value="${esc(v.owner_name || "")}"></label>
        <label>전화번호<input id="kf-phone" type="tel" value="${esc(v.phone || "")}"></label>
        <label class="full">주소<input id="kf-addr" value="${esc(v.address || "")}"></label>
        <label class="full">우리 메모<textarea id="kf-notes" rows="3">${esc(v.notes || "")}</textarea></label>
      </div>
    </div>
    <div class="rc-foot"><button class="btn ghost sm" data-close>취소</button><button class="btn primary sm" id="kf-save">저장</button></div>`, "wide");
  $("#kf-name", ov).focus();
  $("#kf-save", ov).addEventListener("click", async () => {
    const name = $("#kf-name", ov).value.trim();
    if (!name) { toast("이름을 넣어 주세요"); return; }
    const w = parseFloat($("#kf-w", ov).value);
    const row = {
      name, breed: $("#kf-breed", ov).value.trim() || null,
      gender: $("#kf-gender", ov).value || null, neutered: $("#kf-neut", ov).value || null,
      birthday: $("#kf-bd", ov).value || null, weight: Number.isFinite(w) && w > 0 ? w : null,
      owner_name: $("#kf-owner", ov).value.trim() || null, phone: fmtPhone($("#kf-phone", ov).value) || null,
      address: $("#kf-addr", ov).value.trim() || null, notes: $("#kf-notes", ov).value.trim() || null,
      updated_at: new Date().toISOString(),
    };
    if (!m) {
      // 사진함 명단에 같은 이름이 하나뿐이면 연결
      const same = C.dogs.filter((d) => !d.auto && d.name.trim() === name);
      if (same.length === 1) row.dog_id = same[0].id;
    }
    const btn = $("#kf-save", ov); btn.disabled = true;
    const q = m ? C.sb.from("kinder_members").update(row).eq("id", m.id) : C.sb.from("kinder_members").insert(row);
    const { error } = await q;
    if (error) { toast("저장하지 못했어요"); btn.disabled = false; return; }
    close(); toast(m ? "고쳤어요" : "회원을 넣었어요");
    await load(); draw();
  });
}

/* ---------- 다이얼독에서 불러오기 ---------- */
function openSync() {
  const { ov } = modal(`
    <div class="rc-head"><div class="grow"><b>🔄 다이얼독 회원 명단 불러오기</b><small class="muted">다이얼독에 있는 회원(강아지·보호자·전화·주소·메모)을 한 번에 가져와요</small></div>
      <button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body">
      <ol class="kd-steps">
        <li>아래 <b>다이얼독 열기</b>를 눌러요.</li>
        <li>다이얼독 화면에서 즐겨찾기 <b>‘댕겨올개 알림장’</b>을 눌러요.</li>
        <li>뜨는 창 위쪽의 <b>👥 회원 명단 가져오기</b>를 누르면 끝이에요.</li>
      </ol>
      <p class="small muted">새로 온 아이는 추가되고, 바뀐 정보는 다이얼독 내용으로 바뀌어요. 다이얼독에서 지운 아이는 ‘그만 다님’으로 옮겨요. 우리 메모는 그대로 남아요.</p>
    </div>
    <div class="rc-foot"><button class="btn ghost sm" data-close>닫기</button><button class="btn primary sm" id="kd-open-dd">다이얼독 열기</button></div>`);
  $("#kd-open-dd", ov).addEventListener("click", () => { window.open("https://dialodog.com/partners/#members", "dialodog"); });
}
