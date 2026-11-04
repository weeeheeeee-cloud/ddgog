import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  day: kstToday(),
  tab: "photos",
  dogs: [],
  photos: [],
  attendance: new Set(), // 오늘 출석한 강아지 id (assignments 테이블에 저장)
  draft: null,           // 출석 보드에서 읽은 명단 (확정 전) { names, unsure, img }
  busy: false, // 업로드·분류 진행 중
};

/* ================= 유틸 ================= */
function kstToday() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
function shiftDay(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resize(file, maxSide, quality) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bmp = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
}

const urlCache = new Map();
async function signed(bucket, paths) {
  const need = [...new Set(paths.filter((p) => p && !urlCache.has(bucket + p)))];
  for (let i = 0; i < need.length; i += 100) {
    const { data } = await sb.storage.from(bucket).createSignedUrls(need.slice(i, i + 100), 60 * 60 * 6);
    (data || []).forEach((d) => d.signedUrl && urlCache.set(bucket + d.path, d.signedUrl));
  }
  return (p) => (p ? urlCache.get(bucket + p) || "" : "");
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

// 이름 붙은 강아지 가나다순 → 새 강아지 번호순
function dogOrder(a, b) {
  if (a.auto !== b.auto) return a.auto ? 1 : -1;
  if (a.auto) return (parseInt(a.name.replace(/\D/g, "")) || 0) - (parseInt(b.name.replace(/\D/g, "")) || 0);
  return a.name.localeCompare(b.name, "ko");
}
const dogById = (id) => state.dogs.find((d) => d.id === id);

/* ================= 로그인 ================= */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) startApp(); else showLogin();
  sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") showLogin(); });
}
function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-err").textContent = "";
  const { error } = await sb.auth.signInWithPassword({
    email: $("#login-email").value.trim(),
    password: $("#login-pw").value,
  });
  if (error) $("#login-err").textContent = "이메일 또는 비밀번호를 확인해 주세요.";
  else startApp();
});
$("#logout").addEventListener("click", () => sb.auth.signOut());

let started = false;
async function startApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  if (started) return;
  started = true;
  $("#day").value = state.day;
  await render();
}

/* ================= 데이터 ================= */
async function loadDogs() {
  const { data } = await sb.from("dogs").select("*");
  state.dogs = (data || []).sort(dogOrder);
}
async function loadAttendance() {
  const { data } = await sb.from("assignments").select("dog_id").eq("day", state.day);
  state.attendance = new Set((data || []).map((a) => a.dog_id));
}
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

async function loadPhotos() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("photos")
      .select("id, path, thumb_path, dog_ids, status, ai_note, created_at")
      .eq("day", state.day).order("created_at").range(from, from + 999);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  state.photos = all;
}

/* ================= 날짜·탭 ================= */
async function setDay(day) {
  state.day = day;
  state.draft = null;
  $("#day").value = day;
  $("#progress").classList.add("hidden");
  await render();
}
$("#day").addEventListener("change", (e) => setDay(e.target.value || kstToday()));
$$(".date-row [data-shift]").forEach((b) => b.addEventListener("click", () => setDay(shiftDay(state.day, +b.dataset.shift))));
$("#today").addEventListener("click", () => setDay(kstToday()));
$$(".tabs button").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; render(); }));

async function render() {
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));
  $$(".tab").forEach((s) => s.classList.toggle("hidden", s.id !== "tab-" + state.tab));
  await Promise.all([loadDogs(), loadAttendance()]);
  if (state.tab === "photos") { await loadPhotos(); await renderPhotos(); }
  else renderDogs();
}

/* ================= 사진 화면 ================= */
async function renderPhotos() {
  renderRoll();
  const P = state.photos;
  const done = P.filter((p) => p.status === "done");
  const unsorted = P.filter((p) => p.status === "review" || p.status === "error");
  const pending = P.filter((p) => p.status === "pending");

  $("#summary").innerHTML = P.length
    ? `<span><b>${P.length}</b>장</span>
       <span>분류 완료 <b>${done.length}</b></span>
       ${unsorted.length ? `<span class="warn">분류 안 됨 <b>${unsorted.length}</b></span>` : ""}
       ${pending.length && !state.busy ? `<button id="resume" class="btn primary sm">남은 ${pending.length}장 분류하기</button>` : ""}
       ${done.length ? `<button id="save-all" class="btn ghost sm">${CAN_FOLDER ? "전체 폴더별 저장" : "전체 ZIP 받기"}</button>` : ""}`
    : "";
  $("#resume")?.addEventListener("click", () => classifyPending());
  $("#save-all")?.addEventListener("click", (e) => saveAll(e.currentTarget));

  // 강아지별 묶기
  const groups = new Map();
  done.forEach((p) => p.dog_ids.forEach((d) => {
    if (!dogById(d)) return;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(p);
  }));
  const dogIds = [...groups.keys()].sort((a, b) => dogOrder(dogById(a), dogById(b)));

  const box = $("#groups");
  if (!P.length) {
    box.innerHTML = `<div class="empty">아직 이 날짜에 올린 사진이 없어요.<br>위에서 사진을 올려 보세요.</div>`;
    return;
  }

  const thumb = await signed("photos", P.map((p) => p.thumb_path));
  const ref = await signed("refs", dogIds.map((id) => dogById(id)?.ref_path));
  const img = (p) => `<img loading="lazy" src="${thumb(p.thumb_path)}" data-photo="${p.id}" alt="">`;

  box.innerHTML = dogIds.map((id) => {
    const dog = dogById(id);
    const list = groups.get(id);
    return `<div class="dog-group" data-list="${id}">
      <div class="dog-head">
        ${dog.ref_path ? `<img class="avatar" src="${ref(dog.ref_path)}" alt="">` : `<span class="avatar"></span>`}
        <div class="grow">
          <button class="dog-name ${dog.auto ? "unnamed" : ""}" data-rename="${id}">${esc(dog.name)} <span>✎</span></button>
          <small class="muted">${list.length}장</small>
        </div>
        <div class="save-btns">${saveButtons(id)}</div>
      </div>
      <div class="grid">${list.map(img).join("")}</div>
    </div>`;
  }).join("") +
  (unsorted.length ? `<div class="dog-group unsorted" data-list="unsorted">
      <div class="dog-head"><span class="avatar q">?</span>
        <div class="grow"><b>분류 안 된 사진 ${unsorted.length}장</b><small class="muted">사진을 눌러 직접 고르거나, AI에게 다시 맡겨 보세요</small></div>
        ${state.busy ? "" : `<button id="reclassify" class="btn ghost sm">AI로 다시 분류</button>`}</div>
      <div class="grid">${unsorted.map(img).join("")}</div>
    </div>` : "") +
  (!dogIds.length && !unsorted.length ? `<div class="empty">분류를 기다리는 사진이 있어요.</div>` : "");

  // 사진 넘겨보기용: 그룹별 사진 순서
  const lists = new Map(dogIds.map((id) => [id, groups.get(id).map((p) => p.id)]));
  lists.set("unsorted", unsorted.map((p) => p.id));
  $$("[data-photo]", box).forEach((el) => el.addEventListener("click", () => {
    const key = el.closest("[data-list]")?.dataset.list;
    openSheet(el.dataset.photo, lists.get(key) || [el.dataset.photo]);
  }));
  // 그룹이 늘어난 뒤 다시 돌리면 대부분 자리를 찾아감
  $("#reclassify")?.addEventListener("click", async () => {
    const ids = unsorted.map((p) => p.id);
    for (let i = 0; i < ids.length; i += 200) {
      await sb.from("photos").update({ status: "pending", dog_ids: [], ai_note: null }).in("id", ids.slice(i, i + 200));
    }
    classifyPending();
  });
  $$("[data-rename]", box).forEach((b) => b.addEventListener("click", async () => {
    if (await renameDog(dogById(b.dataset.rename))) renderPhotos();
  }));
  $$("[data-save]", box).forEach((b) => b.addEventListener("click", () =>
    saveDogPhotos(dogById(b.dataset.save), groups.get(b.dataset.save), b, b.dataset.mode)));
}

async function renameDog(dog) {
  const need = state.dogs.filter((d) => !d.auto && !d.ref_path && state.attendance.has(d.id)).map((d) => d.name);
  const hint = need.length ? `\n(오늘 명단 중 얼굴을 아직 모르는 아이: ${need.join(", ")})` : "";
  const name = prompt(`강아지 이름${hint}`, dog.auto ? "" : dog.name);
  if (!name || !name.trim()) return false;
  const nm = name.trim();
  const same = state.dogs.find((d) => d.id !== dog.id && norm(d.name) === norm(nm));
  if (same) {
    if (!confirm(`'${same.name}'(이)가 이미 있어요. 이 그룹 사진을 '${same.name}'(으)로 합칠까요?`)) return false;
    let moved = false;
    if (!same.ref_path && dog.ref_path) {            // 얼굴을 몰랐던 아이 → 이 그룹 기준 사진으로 기억
      await sb.from("dogs").update({ ref_path: dog.ref_path }).eq("id", same.id);
      same.ref_path = dog.ref_path;
      moved = true;
    }
    const { error } = await sb.rpc("merge_dogs", { src: dog.id, dst: same.id });
    if (error) { toast("합치지 못했어요"); return false; }
    if (dog.ref_path && !moved) await sb.storage.from("refs").remove([dog.ref_path]);
    state.dogs = state.dogs.filter((d) => d.id !== dog.id);
    state.photos.forEach((p) => {
      if (p.dog_ids.includes(dog.id)) p.dog_ids = [...new Set(p.dog_ids.map((x) => (x === dog.id ? same.id : x)))];
    });
    toast(`'${same.name}'(으)로 합쳤어요${moved ? " · 얼굴도 기억했어요" : ""}`);
    return true;
  }
  const { error } = await sb.from("dogs").update({ name: nm, auto: false }).eq("id", dog.id);
  if (error) { toast("저장하지 못했어요"); return false; }
  Object.assign(dog, { name: nm, auto: false });
  state.dogs.sort(dogOrder);
  return true;
}

/* ---------- 오늘 출석 (보드 사진 → 명단 → 대표 사진) ---------- */
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

async function renderRoll() {
  const body = $("#roll-body");
  const count = $("#roll-count");

  // ① 보드에서 읽은 명단 확인·수정
  if (state.draft) {
    const d = state.draft;
    count.textContent = `${d.names.length}마리 읽음`;
    body.innerHTML = `
      ${d.img ? `<img class="board-preview" src="${d.img}" alt="출석 보드">` : ""}
      <p class="small">읽은 이름이 맞는지 확인해 주세요. <b>이름을 누르면 고칠 수 있고</b>, ×로 뺄 수 있어요.
        ${d.unsure.length ? `<span class="q-legend">?</span> 표시는 글씨가 애매했던 이름이에요.` : ""}</p>
      <div class="chips roll-chips">${d.names.map((n, i) => `
        <span class="${d.unsure.includes(n) ? "unsure" : ""}"><b data-edit="${i}">${esc(n)}</b><b class="x" data-del="${i}">×</b></span>`).join("")
        || `<span class="muted small">아직 이름이 없어요</span>`}</div>
      <form id="roll-add" class="row">
        <input id="roll-add-name" class="grow" placeholder="빠진 이름 추가">
        <button class="btn ghost" type="submit">추가</button>
      </form>
      <div class="row" style="margin-top:10px">
        <button id="roll-confirm" class="btn primary grow" ${d.names.length ? "" : "disabled"}>명단 확정 (${d.names.length}마리)</button>
        <button id="roll-retake" class="btn ghost">다시 찍기</button>
        <button id="roll-cancel" class="btn ghost">취소</button>
      </div>`;
    $$("[data-edit]", body).forEach((el) => el.addEventListener("click", () => {
      const i = +el.dataset.edit;
      const v = prompt("이름 고치기", d.names[i]);
      if (v === null) return;
      if (!v.trim()) d.names.splice(i, 1);
      else { d.unsure = d.unsure.filter((u) => u !== d.names[i]); d.names[i] = v.trim(); }
      renderRoll();
    }));
    $$("[data-del]", body).forEach((el) => el.addEventListener("click", () => { d.names.splice(+el.dataset.del, 1); renderRoll(); }));
    $("#roll-add").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $("#roll-add-name").value.trim();
      if (v && !d.names.some((n) => norm(n) === norm(v))) d.names.push(v);
      renderRoll();
      $("#roll-add-name")?.focus();
    });
    $("#roll-confirm").addEventListener("click", confirmRoll);
    $("#roll-retake").addEventListener("click", () => $("#board-file").click());
    $("#roll-cancel").addEventListener("click", () => { state.draft = null; renderRoll(); });
    return;
  }

  const roll = state.dogs.filter((dg) => state.attendance.has(dg.id)).sort(dogOrder);

  // ② 아직 명단 없음
  if (!roll.length) {
    count.textContent = "";
    body.innerHTML = `
      <p class="muted small">출석 보드를 찍어 올리면 AI가 이름을 읽어 명단을 만들어요. 명단이 있으면 분류가 더 정확해져요. (안 해도 분류는 돼요)</p>
      <div class="row">
        <button id="roll-board" class="btn primary grow">출석 보드 사진 올리기</button>
        <button id="roll-manual" class="btn ghost">직접 입력</button>
      </div>`;
    $("#roll-board").addEventListener("click", () => $("#board-file").click());
    $("#roll-manual").addEventListener("click", () => { state.draft = { names: [], unsure: [], img: "" }; renderRoll(); });
    return;
  }

  // ③ 확정된 명단: 얼굴 아는 아이 ✓ / 처음 보는 아이는 대표 사진 올리기
  const known = roll.filter((dg) => dg.ref_path);
  const need = roll.filter((dg) => !dg.ref_path);
  count.textContent = `${roll.length}마리${need.length ? ` · 대표 사진 필요 ${need.length}` : " · 모두 얼굴 앎 ✓"}`;
  const ref = await signed("refs", known.map((dg) => dg.ref_path));
  body.innerHTML = `
    ${need.length ? `<p class="small">처음 보는 아이예요. <b>대표 사진</b>을 한 번만 올려 주면 다음부터는 알아서 알아봐요.</p>
    <div class="need-list">${need.map((dg) => `
      <div class="need-row"><span class="avatar"></span><b class="grow">${esc(dg.name)}</b>
        <button class="btn primary sm" data-ref-for="${dg.id}">대표 사진 올리기</button></div>`).join("")}</div>` : ""}
    ${known.length ? `<div class="known-list">${known.map((dg) => `
      <span class="known" title="얼굴 기억함"><img src="${ref(dg.ref_path)}" alt="">${esc(dg.name)}<i>✓</i></span>`).join("")}</div>` : ""}
    <div class="row" style="margin-top:10px">
      <button id="roll-edit" class="btn ghost sm">명단 수정</button>
      <button id="roll-board" class="btn ghost sm">보드 다시 읽기</button>
    </div>`;
  $$("[data-ref-for]", body).forEach((b) => b.addEventListener("click", () => {
    refTarget = b.dataset.refFor;
    $("#ref-file").click();
  }));
  $("#roll-edit").addEventListener("click", () => {
    state.draft = { names: roll.map((dg) => dg.name), unsure: [], img: "" };
    renderRoll();
  });
  $("#roll-board").addEventListener("click", () => $("#board-file").click());
}

// 보드 사진 → 이름 읽기
$("#board-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const body = $("#roll-body");
  body.innerHTML = `<div class="reading"><span class="spinner"></span> 출석 보드를 읽는 중… (10초 정도 걸려요)</div>`;
  try {
    const blob = await resize(f, 1600, 0.85);
    const image = await blobToBase64(blob);
    const known = state.dogs.filter((d) => !d.auto).map((d) => d.name);
    const { data, error } = await sb.functions.invoke("read-board", { body: { image, known } });
    if (error) {
      let msg = "";
      try { msg = (await error.context.json()).error || ""; } catch { /* 무시 */ }
      throw new Error(msg || (error.context?.status === 404 ? "보드 읽기 기능을 찾을 수 없어요" : "읽지 못했어요"));
    }
    state.draft = { names: data.names || [], unsure: data.unsure || [], img: URL.createObjectURL(blob) };
    if (!state.draft.names.length) toast("이름을 찾지 못했어요. 직접 추가해 주세요.");
  } catch (err) {
    toast(err.message || "읽지 못했어요. 다시 시도해 주세요.");
    if (!state.draft) state.draft = { names: [], unsure: [], img: "" };
  }
  renderRoll();
});

// 명단 확정 → 아는 아이는 연결, 처음 보는 이름은 새로 등록
async function confirmRoll() {
  const btn = $("#roll-confirm");
  btn.disabled = true;
  btn.textContent = "저장 중…";
  try {
    const ids = [];
    for (const name of state.draft.names) {
      let dog = state.dogs.find((d) => !d.auto && norm(d.name) === norm(name));
      if (!dog) {
        const { data, error } = await sb.from("dogs").insert({ name, auto: false, active: true }).select().single();
        if (error) throw error;
        dog = data;
        state.dogs.push(dog);
      } else if (!dog.active) {
        await sb.from("dogs").update({ active: true }).eq("id", dog.id);
        dog.active = true;
      }
      ids.push(dog.id);
    }
    await sb.from("assignments").delete().eq("day", state.day);
    const uniq = [...new Set(ids)];
    if (uniq.length) {
      const { error } = await sb.from("assignments").insert(uniq.map((dog_id) => ({ day: state.day, dog_id })));
      if (error) throw error;
    }
    state.attendance = new Set(uniq);
    state.draft = null;
    state.dogs.sort(dogOrder);
    const need = uniq.filter((id) => !dogById(id)?.ref_path).length;
    toast(need ? `명단 저장! 대표 사진이 필요한 아이 ${need}마리` : "명단 저장! 모두 아는 얼굴이에요");
  } catch (err) {
    console.error(err);
    toast("저장하지 못했어요. 다시 시도해 주세요.");
  }
  renderPhotos();
}

// 대표 사진 올리기 (한 번 올리면 계속 기억)
let refTarget = null;
$("#ref-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  const dog = dogById(refTarget);
  refTarget = null;
  if (!f || !dog) return;
  try {
    const blob = await resize(f, 640, 0.85);
    const path = `${dog.id}-${Date.now()}.jpg`;
    const { error } = await sb.storage.from("refs").upload(path, blob, { contentType: "image/jpeg" });
    if (error) throw error;
    if (dog.ref_path) await sb.storage.from("refs").remove([dog.ref_path]);
    await sb.from("dogs").update({ ref_path: path }).eq("id", dog.id);
    dog.ref_path = path;
    toast(`${dog.name} 얼굴을 기억했어요`);
  } catch {
    toast("올리지 못했어요. 다시 시도해 주세요.");
  }
  renderRoll();
});

/* ---------- 올리기 + 분류 ---------- */
function progress(title, n, total, detail = "") {
  $("#progress").classList.remove("hidden");
  $("#pg-title").textContent = title;
  $("#pg-count").textContent = total ? `${n} / ${total}` : "";
  $("#pg-bar").style.width = total ? `${(n / total) * 100}%` : "0";
  $("#pg-detail").textContent = detail;
}

$("#file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  if (state.busy) { toast("지금 진행 중인 작업이 끝나면 다시 올려 주세요"); return; }
  state.busy = true;
  const day = state.day;
  let n = 0, failed = 0;
  progress("사진 올리는 중… 창을 닫지 마세요", 0, files.length);
  await pool(files, 3, async (file) => {
    try {
      const id = crypto.randomUUID();
      const [full, small] = await Promise.all([resize(file, 1600, 0.85), resize(file, 640, 0.8)]);
      const path = `${day}/${id}.jpg`, thumbPath = `${day}/thumb/${id}.jpg`;
      const opt = { contentType: "image/jpeg", upsert: false };
      const [a, b] = await Promise.all([
        sb.storage.from("photos").upload(path, full, opt),
        sb.storage.from("photos").upload(thumbPath, small, opt),
      ]);
      if (a.error || b.error) throw a.error || b.error;
      const ins = await sb.from("photos").insert({ id, day, path, thumb_path: thumbPath });
      if (ins.error) throw ins.error;
    } catch (err) {
      console.error(err);
      failed++;
    }
    n++;
    progress("사진 올리는 중… 창을 닫지 마세요", n, files.length, failed ? `실패 ${failed}장` : "");
  });
  state.busy = false;
  await classifyPending();
});

let lastError = "";
async function classifyOne(photoId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await sb.functions.invoke("classify", { body: { photo_id: photoId } });
    if (!error) return true;
    const status = error.context?.status;
    if (status === 503 || status === 429) { await sleep(2000 * 2 ** attempt); continue; }
    let detail = "";
    try { detail = (await error.context.json()).error || ""; } catch { /* 무시 */ }
    lastError = status === 404 || !status
      ? "분류 함수(classify)를 찾을 수 없어요. Supabase에 함수가 배포됐는지 확인해 주세요."
      : `분류 오류 (${status}) ${detail}`.trim();
    return false;
  }
  lastError = "AI가 바빠서 분류하지 못했어요. 잠시 후 다시 시도해 주세요.";
  return false;
}

// 같은 아이가 여러 그룹으로 생기지 않도록 한 장씩 차례로 분류
async function classifyPending() {
  if (state.busy) return;
  state.busy = true;
  const { data } = await sb.from("photos").select("id").eq("day", state.day).eq("status", "pending").order("created_at");
  const list = data || [];
  if (!list.length) { state.busy = false; $("#progress").classList.add("hidden"); await render(); return; }
  lastError = "";
  let ok = 0, fail = 0;
  for (let i = 0; i < list.length; i++) {
    progress("AI가 강아지별로 묶는 중… 창을 닫지 마세요", i, list.length, "아래 목록이 조금씩 채워져요");
    if (await classifyOne(list[i].id)) ok++;
    else if (++fail >= 3 && !ok) break;          // 설정 문제면 바로 멈춤
    if ((i + 1) % 8 === 0 && state.tab === "photos") { await loadDogs(); await loadPhotos(); await renderPhotos(); }
  }
  state.busy = false;
  if (fail && lastError) {
    progress("분류를 멈췄어요", ok, list.length, lastError);
  } else {
    progress(`완료! ${ok}장 분류했어요`, list.length, list.length);
    setTimeout(() => $("#progress").classList.add("hidden"), 4000);
  }
  await render();
}

/* ---------- 사진 시트 (크게 보기 + 강아지 지정) ---------- */
let sheetPhoto = null;
let sheetList = [];
async function openSheet(photoId, list = sheetList) {
  const p = state.photos.find((x) => x.id === photoId);
  if (!p) return;
  sheetPhoto = p;
  sheetList = list;
  const i = sheetList.indexOf(photoId);
  $("#sheet-count").textContent = sheetList.length > 1 ? `${i + 1} / ${sheetList.length}` : "";
  $("#sheet-prev").disabled = i <= 0;
  $("#sheet-next").disabled = i < 0 || i >= sheetList.length - 1;
  const url = await signed("photos", [p.path]);
  $("#sheet-img").src = url(p.path);
  $("#sheet-note").textContent = p.ai_note ? `AI 메모: ${p.ai_note}` : "";
  // 오늘 출석한 아이를 앞쪽에
  const chipDogs = state.dogs.filter((d) => d.active)
    .sort((a, b) => (state.attendance.has(b.id) - state.attendance.has(a.id)) || dogOrder(a, b));
  $("#sheet-chips").innerHTML = chipDogs.map((d) =>
    `<button data-dog="${d.id}" class="${p.dog_ids.includes(d.id) ? "on" : ""}">${esc(d.name)}</button>`).join("")
    || `<span class="muted small">아직 강아지 그룹이 없어요. '새 강아지로'를 눌러 주세요.</span>`;
  $$("#sheet-chips button").forEach((b) => b.addEventListener("click", () => b.classList.toggle("on")));
  $("#sheet").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  // 다음 사진 미리 불러오기
  const nextId = sheetList[i + 1];
  const next = nextId && state.photos.find((x) => x.id === nextId);
  if (next) signed("photos", [next.path]).then((u) => { new Image().src = u(next.path); });
}
function stepSheet(d) {
  const i = sheetList.indexOf(sheetPhoto?.id);
  const id = sheetList[i + d];
  if (id) openSheet(id);
}
$("#sheet-prev").addEventListener("click", () => stepSheet(-1));
$("#sheet-next").addEventListener("click", () => stepSheet(1));
document.addEventListener("keydown", (e) => {
  if ($("#sheet").classList.contains("hidden")) return;
  if (e.key === "ArrowLeft") stepSheet(-1);
  else if (e.key === "ArrowRight") stepSheet(1);
  else if (e.key === "Escape") closeSheet();
});
// 폰: 좌우로 밀어서 넘기기
let touchX = null;
$("#sheet-img").addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
$("#sheet-img").addEventListener("touchend", (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 50) stepSheet(dx < 0 ? 1 : -1);
});
$("#sheet-dl").addEventListener("click", async (e) => {
  const p = sheetPhoto;
  const names = p.dog_ids.map((id) => dogById(id)?.name).filter(Boolean).join("_") || "사진";
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const { data } = await sb.storage.from("photos").download(p.path);
    const file = new File([data], `${safeName(names)}_${state.day}_${p.id.slice(0, 4)}.jpg`, { type: "image/jpeg" });
    if (IS_MOBILE && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
    else downloadBlob(file, file.name);
  } catch (err) {
    if (err?.name !== "AbortError") toast("저장하지 못했어요");
  }
  btn.disabled = false;
});

function closeSheet() {
  $("#sheet").classList.add("hidden");
  $("#sheet-img").src = "";
  document.body.style.overflow = "";
  sheetPhoto = null;
}
$(".sheet-close").addEventListener("click", closeSheet);
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });

$("#sheet-save").addEventListener("click", async () => {
  const ids = $$("#sheet-chips button.on").map((b) => b.dataset.dog);
  if (!ids.length) { toast("강아지를 한 마리 이상 골라 주세요"); return; }
  await sb.from("photos").update({ dog_ids: ids, status: "done", confidence: "manual" }).eq("id", sheetPhoto.id);
  Object.assign(sheetPhoto, { dog_ids: ids, status: "done" });
  toast("분류를 저장했어요");
  const i = sheetList.indexOf(sheetPhoto.id);
  if (sheetList[i + 1]) openSheet(sheetList[i + 1]); else closeSheet();
  renderPhotos();
});

// 이 사진으로 새 강아지 그룹 만들기
$("#sheet-new").addEventListener("click", async () => {
  const p = sheetPhoto;
  const name = prompt("강아지 이름 (모르면 비워 두세요)", "");
  if (name === null) return;
  const { count } = await sb.from("dogs").select("id", { count: "exact", head: true });
  const { data: dog, error } = await sb.from("dogs")
    .insert({ name: name.trim() || `새 강아지 ${(count ?? 0) + 1}`, auto: !name.trim() }).select().single();
  if (error) { toast("만들지 못했어요"); return; }
  const { data: blob } = await sb.storage.from("photos").download(p.thumb_path);
  const refPath = `${dog.id}-${Date.now()}.jpg`;
  await sb.storage.from("refs").upload(refPath, blob, { contentType: "image/jpeg" });
  await sb.from("dogs").update({ ref_path: refPath }).eq("id", dog.id);
  const ids = [...new Set([...$$("#sheet-chips button.on").map((b) => b.dataset.dog), dog.id])];
  await sb.from("photos").update({ dog_ids: ids, status: "done", confidence: "manual" }).eq("id", p.id);
  closeSheet();
  toast(`${dog.name} 그룹을 만들었어요`);
  render();
});

$("#sheet-del").addEventListener("click", async () => {
  if (!confirm("이 사진을 삭제할까요?")) return;
  const p = sheetPhoto;
  await sb.storage.from("photos").remove([p.path, p.thumb_path]);
  await sb.from("photos").delete().eq("id", p.id);
  state.photos = state.photos.filter((x) => x.id !== p.id);
  closeSheet();
  renderPhotos();
});

// 저장 방식: 폰 → 사진 앱(공유 시트) / PC → 폴더에 바로 저장(크롬·엣지) 또는 ZIP
const IS_MOBILE = /Android|iPhone|iPad/i.test(navigator.userAgent);
const CAN_FOLDER = !IS_MOBILE && "showDirectoryPicker" in window;
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, "_").trim() || "이름없음";

function saveButtons(id) {
  if (IS_MOBILE) return `<button class="btn primary sm" data-save="${id}" data-mode="share">사진 앱에 저장</button>`;
  return (CAN_FOLDER ? `<button class="btn primary sm" data-save="${id}" data-mode="folder">폴더에 저장</button>` : "") +
    `<button class="btn ${CAN_FOLDER ? "ghost" : "primary"} sm" data-save="${id}" data-mode="zip">ZIP</button>`;
}
function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function photoFiles(dog, photos, onEach) {
  const prefix = `${safeName(dog.name)}_${state.day}`;
  const out = [];
  await pool(photos, 4, async (p, i) => {
    const { data } = await sb.storage.from("photos").download(p.path);
    out[i] = new File([data], `${prefix}_${String(i + 1).padStart(2, "0")}.jpg`, { type: "image/jpeg" });
    onEach?.();
  });
  return out;
}
async function writeToFolder(dir, files) {
  for (const f of files) {
    const fh = await dir.getFileHandle(f.name, { create: true });
    const w = await fh.createWritable();
    await w.write(f);
    await w.close();
  }
}

async function saveDogPhotos(dog, photos, btn, mode) {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    let root = null;
    if (mode === "folder") root = await window.showDirectoryPicker({ mode: "readwrite", id: "ddgog" });
    let n = 0;
    const files = await photoFiles(dog, photos, () => { btn.textContent = `${++n}/${photos.length}`; });
    if (mode === "share") {
      await navigator.share({ files, title: `${dog.name} ${state.day}` });
    } else if (mode === "folder") {
      const dir = await root.getDirectoryHandle(`${state.day}_${safeName(dog.name)}`, { create: true });
      await writeToFolder(dir, files);
      toast(`${dog.name} ${files.length}장을 폴더에 저장했어요`);
    } else {
      const zip = new JSZip();
      files.forEach((f) => zip.file(f.name, f));
      downloadBlob(await zip.generateAsync({ type: "blob" }), `${safeName(dog.name)}_${state.day}.zip`);
    }
  } catch (err) {
    if (err?.name !== "AbortError") toast("저장하지 못했어요. 다시 시도해 주세요.");
  }
  btn.disabled = false;
  btn.textContent = label;
}

// 이 날짜 전체를 강아지별 폴더로
async function saveAll(btn) {
  const groups = new Map();
  state.photos.filter((p) => p.status === "done").forEach((p) => p.dog_ids.forEach((d) => {
    const dog = dogById(d);
    if (!dog) return;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(p);
  }));
  const label = btn.textContent;
  btn.disabled = true;
  try {
    let root = null;
    if (CAN_FOLDER) {
      const picked = await window.showDirectoryPicker({ mode: "readwrite", id: "ddgog" });
      root = await picked.getDirectoryHandle(state.day, { create: true });
    }
    const zip = CAN_FOLDER ? null : new JSZip();
    const total = [...groups.values()].reduce((a, g) => a + g.length, 0);
    let n = 0;
    for (const [id, photos] of groups) {
      const dog = dogById(id);
      const files = await photoFiles(dog, photos, () => { btn.textContent = `저장 중 ${++n}/${total}`; });
      if (root) await writeToFolder(await root.getDirectoryHandle(safeName(dog.name), { create: true }), files);
      else files.forEach((f) => zip.file(`${safeName(dog.name)}/${f.name}`, f));
    }
    if (zip) downloadBlob(await zip.generateAsync({ type: "blob" }), `댕겨올개_${state.day}.zip`);
    else toast(`강아지 ${groups.size}마리, ${total}장을 폴더별로 저장했어요`);
  } catch (err) {
    if (err?.name !== "AbortError") toast("저장하지 못했어요. 다시 시도해 주세요.");
  }
  btn.disabled = false;
  btn.textContent = label;
}

/* ================= 관리 ================= */
async function renderDogs() {
  const list = $("#dog-list");
  const ref = await signed("refs", state.dogs.map((d) => d.ref_path));
  list.innerHTML = state.dogs.map((d) => `
    <div class="dog-row ${d.active ? "" : "off"} ${d.auto ? "auto" : ""}" data-id="${d.id}">
      <label class="ref-pick sm">
        <input type="file" accept="image/*" hidden data-ref>
        ${d.ref_path ? `<img src="${ref(d.ref_path)}" alt="">` : "사진"}
      </label>
      <div class="grow"><b>${esc(d.name)}</b>${d.auto ? ` <span class="tag">이름 필요</span>` : ""}<small>${esc(d.note || "")}</small></div>
      <div class="row-actions">
        <button class="btn ${d.auto ? "primary" : "ghost"} mini" data-edit>${d.auto ? "이름" : "수정"}</button>
        <button class="btn ghost mini" data-merge>합치기</button>
        <button class="btn ghost mini" data-toggle>${d.active ? "숨기기" : "표시"}</button>
      </div>
      <div class="merge-box hidden">
        <span class="small">이 그룹을</span>
        <select>${state.dogs.filter((o) => o.id !== d.id).map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}</select>
        <span class="small">(으)로</span>
        <button class="btn primary mini" data-merge-go>합치기</button>
        <button class="btn ghost mini" data-merge-cancel>취소</button>
      </div>
    </div>`).join("") || `<div class="muted small">아직 강아지가 없어요. 사진을 올리면 AI가 자동으로 그룹을 만들어요.</div>`;

  $$(".dog-row", list).forEach((row) => {
    const dog = dogById(row.dataset.id);
    $("[data-ref]", row).addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const blob = await resize(f, 640, 0.85);
      const path = `${dog.id}-${Date.now()}.jpg`;
      const { error } = await sb.storage.from("refs").upload(path, blob, { contentType: "image/jpeg" });
      if (error) { toast("기준 사진을 올리지 못했어요"); return; }
      if (dog.ref_path) await sb.storage.from("refs").remove([dog.ref_path]);
      await sb.from("dogs").update({ ref_path: path }).eq("id", dog.id);
      dog.ref_path = path;
      renderDogs();
    });
    $("[data-edit]", row).addEventListener("click", async () => {
      if (dog.auto) { if (await renameDog(dog)) renderDogs(); return; }
      const name = prompt("이름", dog.name);
      if (name === null) return;
      const note = prompt("특징 (견종·털색·무늬, 헷갈리는 아이면 자세히)", dog.note || "");
      if (note === null) return;
      await sb.from("dogs").update({ name: name.trim() || dog.name, note: note.trim() }).eq("id", dog.id);
      Object.assign(dog, { name: name.trim() || dog.name, note: note.trim() });
      state.dogs.sort(dogOrder);
      renderDogs();
    });
    $("[data-toggle]", row).addEventListener("click", async () => {
      await sb.from("dogs").update({ active: !dog.active }).eq("id", dog.id);
      dog.active = !dog.active;
      renderDogs();
    });
    const box = $(".merge-box", row);
    $("[data-merge]", row).addEventListener("click", () => box.classList.toggle("hidden"));
    $("[data-merge-cancel]", row).addEventListener("click", () => box.classList.add("hidden"));
    $("[data-merge-go]", row).addEventListener("click", async () => {
      const target = dogById($("select", box).value);
      if (!target || !confirm(`'${dog.name}' 사진을 모두 '${target.name}'(으)로 옮기고 '${dog.name}' 그룹은 지울까요?`)) return;
      const { error } = await sb.rpc("merge_dogs", { src: dog.id, dst: target.id });
      if (error) { toast("합치지 못했어요. 다시 시도해 주세요."); return; }
      if (dog.ref_path) await sb.storage.from("refs").remove([dog.ref_path]);
      state.dogs = state.dogs.filter((d) => d.id !== dog.id);
      toast(`'${target.name}'(으)로 합쳤어요`);
      renderDogs();
    });
  });
}

// 사진 + 파일 일괄 삭제 (조건에 맞는 것만)
async function deletePhotos(applyFilter, onProgress) {
  let removed = 0;
  for (;;) {
    const { data } = await applyFilter(sb.from("photos").select("id, path, thumb_path")).limit(200);
    if (!data?.length) break;
    await sb.storage.from("photos").remove(data.flatMap((p) => [p.path, p.thumb_path]));
    const del = await sb.from("photos").delete().in("id", data.map((p) => p.id));
    if (del.error) throw del.error;
    removed += data.length;
    onProgress(removed);
  }
  return removed;
}

$("#purge").addEventListener("click", async () => {
  const cutoff = shiftDay(kstToday(), -+$("#purge-days").value);
  if (!confirm(`${cutoff} 이전 사진을 모두 삭제할까요? 되돌릴 수 없어요.`)) return;
  const msg = $("#purge-msg");
  try {
    const n = await deletePhotos((q) => q.lt("day", cutoff), (n) => { msg.textContent = `${n}장 삭제 중…`; });
    msg.textContent = n ? `${n}장 삭제했어요.` : "지울 사진이 없어요.";
  } catch { msg.textContent = "삭제 중 오류가 났어요."; }
});

$("#reset-all").addEventListener("click", async () => {
  if (!confirm("모든 사진과 강아지 그룹을 지울까요? 되돌릴 수 없어요.")) return;
  if (prompt("확인을 위해 '초기화'라고 입력해 주세요") !== "초기화") return;
  const msg = $("#reset-msg");
  try {
    await deletePhotos((q) => q, (n) => { msg.textContent = `사진 ${n}장 삭제 중…`; });
    const { data: dogs } = await sb.from("dogs").select("id, ref_path");
    const refs = (dogs || []).map((d) => d.ref_path).filter(Boolean);
    for (let i = 0; i < refs.length; i += 100) await sb.storage.from("refs").remove(refs.slice(i, i + 100));
    if (dogs?.length) await sb.from("dogs").delete().in("id", dogs.map((d) => d.id));
    urlCache.clear();
    msg.textContent = "초기화했어요. 사진 탭에서 새로 올려 보세요.";
    await render();
  } catch { msg.textContent = "초기화 중 오류가 났어요. 다시 눌러 주세요."; }
});

boot();
