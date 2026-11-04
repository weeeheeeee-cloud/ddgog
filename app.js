import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  day: kstToday(),
  tab: "upload",
  teachers: [],
  dogs: [],
  assignments: new Map(),          // dog_id -> teacher_id
  viewTeacher: lsGet("viewTeacher") || "",
};

/* ---------- 유틸 ---------- */
function kstToday() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}
function shiftDay(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } }
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

// 이미지 리사이즈 → JPEG Blob
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
  const w = bmp.width, h = bmp.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  c.getContext("2d").drawImage(bmp, 0, 0, cw, ch);
  if (bmp.close) bmp.close();
  return await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
}

// 서명 URL 캐시
const urlCache = new Map();
async function signed(bucket, paths) {
  const need = paths.filter((p) => p && !urlCache.has(bucket + p));
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const { data } = await sb.storage.from(bucket).createSignedUrls(chunk, 60 * 60 * 6);
    (data || []).forEach((d) => d.signedUrl && urlCache.set(bucket + d.path, d.signedUrl));
  }
  return (p) => (p ? urlCache.get(bucket + p) || "" : "");
}

// 동시 실행 제한
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/* ---------- 로그인 ---------- */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) startApp(); else showLogin();
  sb.auth.onAuthStateChange((ev) => {
    if (ev === "SIGNED_OUT") showLogin();
  });
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
  await loadBase();
  render();
}

/* ---------- 데이터 ---------- */
async function loadBase() {
  const [t, d] = await Promise.all([
    sb.from("teachers").select("*").order("sort").order("name"),
    sb.from("dogs").select("*").order("name"),
  ]);
  state.teachers = t.data || [];
  state.dogs = d.data || [];
  await loadAssignments();
}
async function loadAssignments() {
  const { data } = await sb.from("assignments").select("dog_id, teacher_id").eq("day", state.day);
  state.assignments = new Map((data || []).map((a) => [a.dog_id, a.teacher_id]));
}
const dogById = (id) => state.dogs.find((d) => d.id === id);
const teacherById = (id) => state.teachers.find((t) => t.id === id);

/* ---------- 날짜·탭 ---------- */
$("#day").addEventListener("change", async (e) => {
  state.day = e.target.value || kstToday();
  await loadAssignments();
  render();
});
$$(".date-row [data-shift]").forEach((b) =>
  b.addEventListener("click", async () => {
    state.day = shiftDay(state.day, +b.dataset.shift);
    $("#day").value = state.day;
    await loadAssignments();
    render();
  }));
$("#today").addEventListener("click", async () => {
  state.day = kstToday();
  $("#day").value = state.day;
  await loadAssignments();
  render();
});
$$(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    state.tab = b.dataset.tab;
    render();
  }));

function render() {
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));
  $$(".tab").forEach((s) => s.classList.toggle("hidden", s.id !== "tab-" + state.tab));
  ({ upload: renderUpload, view: renderView, review: renderReview, admin: renderAdmin })[state.tab]();
  updateReviewBadge();
}

async function updateReviewBadge() {
  const { count } = await sb.from("photos").select("id", { count: "exact", head: true })
    .eq("day", state.day).in("status", ["review", "error"]);
  const b = $("#review-count");
  b.textContent = count || "";
  b.classList.toggle("hidden", !count);
}

/* ---------- 올리기 ---------- */
async function renderUpload() {
  const { data } = await sb.from("photos").select("status").eq("day", state.day);
  const c = { total: 0, done: 0, review: 0, pending: 0 };
  (data || []).forEach((p) => {
    c.total++;
    if (p.status === "done") c.done++;
    else if (p.status === "pending") c.pending++;
    else c.review++;
  });
  $("#stats").innerHTML = [
    ["전체", c.total], ["분류 완료", c.done], ["확인 필요", c.review], ["대기", c.pending],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("");
  $("#retry-pending").classList.toggle("hidden", !c.pending);
}
$("#refresh-stats").addEventListener("click", renderUpload);

async function classify(photoId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await sb.functions.invoke("classify", { body: { photo_id: photoId } });
    if (!error) return data;
    const status = error.context?.status;
    if (status === 503 || status === 429) { await sleep(2000 * 2 ** attempt); continue; }
    return null;
  }
  return null;
}

let uploading = false;
$("#file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length || uploading) return;
  uploading = true;
  const day = state.day;
  const box = $("#up-progress");
  box.classList.remove("hidden");
  $("#up-title").textContent = "올리고 분류하는 중… 창을 닫지 마세요";
  let done = 0, failed = 0;
  const tick = () => {
    $("#up-count").textContent = `${done + failed} / ${files.length}`;
    $("#up-bar").style.width = `${((done + failed) / files.length) * 100}%`;
    $("#up-detail").textContent = failed ? `실패 ${failed}장 (다시 올려 주세요)` : "";
  };
  tick();

  await pool(files, 3, async (file) => {
    try {
      const id = crypto.randomUUID();
      const [full, thumb] = await Promise.all([resize(file, 1600, 0.85), resize(file, 640, 0.8)]);
      const path = `${day}/${id}.jpg`;
      const thumbPath = `${day}/thumb/${id}.jpg`;
      const opts = { contentType: "image/jpeg", upsert: false };
      const [a, b] = await Promise.all([
        sb.storage.from("photos").upload(path, full, opts),
        sb.storage.from("photos").upload(thumbPath, thumb, opts),
      ]);
      if (a.error || b.error) throw a.error || b.error;
      const ins = await sb.from("photos").insert({ id, day, path, thumb_path: thumbPath });
      if (ins.error) throw ins.error;
      await classify(id);
      done++;
    } catch (err) {
      console.error(err);
      failed++;
    }
    tick();
  });

  $("#up-title").textContent = `완료! ${done}장 올림`;
  uploading = false;
  toast(`${done}장 올리기 완료`);
  if (state.tab === "upload") renderUpload();
  updateReviewBadge();
});

$("#retry-pending").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const { data } = await sb.from("photos").select("id").eq("day", state.day).eq("status", "pending");
  let n = 0;
  await pool(data || [], 3, async (p) => {
    await classify(p.id);
    n++;
    btn.textContent = `분류 중… ${n}/${data.length}`;
  });
  btn.disabled = false;
  btn.textContent = "분류 안 된 사진 다시 분류";
  renderUpload();
  updateReviewBadge();
});

/* ---------- 내 사진 ---------- */
async function renderView() {
  const pick = $("#teacher-pick");
  const opts = [{ id: "", name: "전체" }, ...state.teachers];
  pick.innerHTML = opts.map((t) =>
    `<button data-id="${t.id}" class="${t.id === state.viewTeacher ? "on" : ""}">${esc(t.name)}</button>`).join("");
  $$("button", pick).forEach((b) => b.addEventListener("click", () => {
    state.viewTeacher = b.dataset.id;
    lsSet("viewTeacher", state.viewTeacher);
    renderView();
  }));

  const body = $("#view-body");
  body.innerHTML = `<div class="empty">불러오는 중…</div>`;

  let dogIds;
  if (state.viewTeacher) {
    dogIds = [...state.assignments].filter(([, t]) => t === state.viewTeacher).map(([d]) => d);
    if (!dogIds.length) {
      body.innerHTML = `<div class="empty">이 날짜에 담당 강아지가 지정되지 않았어요.<br>관리 탭에서 담당을 지정해 주세요.</div>`;
      return;
    }
  }

  let q = sb.from("photos").select("id, path, thumb_path, dog_ids, created_at")
    .eq("day", state.day).eq("status", "done").order("created_at");
  if (dogIds) q = q.overlaps("dog_ids", dogIds);
  const { data: photos } = await q;

  const groups = new Map();
  (dogIds || []).forEach((id) => groups.set(id, []));
  (photos || []).forEach((p) => p.dog_ids.forEach((d) => {
    if (dogIds && !dogIds.includes(d)) return;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(p);
  }));

  if (![...groups.values()].some((g) => g.length) && !dogIds) {
    body.innerHTML = `<div class="empty">아직 분류된 사진이 없어요.</div>`;
    return;
  }

  const order = [...groups.keys()].sort((a, b) =>
    (dogById(a)?.name || "").localeCompare(dogById(b)?.name || "", "ko"));
  const thumbUrl = await signed("photos", (photos || []).map((p) => p.thumb_path));
  const refUrl = await signed("refs", order.map((id) => dogById(id)?.ref_path));

  body.innerHTML = order.map((id) => {
    const dog = dogById(id);
    const list = groups.get(id);
    return `<div class="dog-group">
      <div class="dog-head">
        ${dog?.ref_path ? `<img class="avatar" src="${refUrl(dog.ref_path)}" alt="">` : `<span class="avatar"></span>`}
        <div class="grow"><div class="name">${esc(dog?.name || "알 수 없음")}</div>
        <small class="muted">${list.length}장</small></div>
        ${list.length ? `<button class="btn primary sm" data-save="${id}">저장</button>` : ""}
      </div>
      ${list.length
        ? `<div class="grid">${list.map((p) => `<img loading="lazy" src="${thumbUrl(p.thumb_path)}" data-full="${p.path}" alt="">`).join("")}</div>`
        : `<div class="muted small">아직 사진이 없어요</div>`}
    </div>`;
  }).join("") || `<div class="empty">사진이 없어요.</div>`;

  $$("[data-save]", body).forEach((b) => b.addEventListener("click", () =>
    saveDogPhotos(dogById(b.dataset.save), groups.get(b.dataset.save), b)));
  bindViewer(body);
}

function bindViewer(root) {
  $$("img[data-full]", root).forEach((img) => img.addEventListener("click", async () => {
    const url = await signed("photos", [img.dataset.full]);
    const v = $("#viewer");
    $("img", v).src = url(img.dataset.full);
    v.classList.remove("hidden");
  }));
}
$("#viewer").addEventListener("click", () => {
  $("#viewer").classList.add("hidden");
  $("#viewer img").src = "";
});

// 폰: 공유 시트(→ 사진 앱에 저장) / PC: ZIP 다운로드
async function saveDogPhotos(dog, photos, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "준비 중…";
  try {
    const blobs = await Promise.all(photos.map(async (p, i) => {
      const { data } = await sb.storage.from("photos").download(p.path);
      return new File([data], `${dog.name}_${state.day}_${String(i + 1).padStart(2, "0")}.jpg`, { type: "image/jpeg" });
    }));
    const canShare = navigator.canShare && navigator.canShare({ files: blobs });
    const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    if (isMobile && canShare) {
      await navigator.share({ files: blobs, title: `${dog.name} ${state.day}` });
    } else {
      const zip = new JSZip();
      blobs.forEach((f) => zip.file(f.name, f));
      const out = await zip.generateAsync({ type: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(out);
      a.download = `${dog.name}_${state.day}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  } catch (err) {
    if (err?.name !== "AbortError") toast("저장하지 못했어요. 다시 시도해 주세요.");
  }
  btn.disabled = false;
  btn.textContent = label;
}

/* ---------- 확인 필요 ---------- */
async function renderReview() {
  const body = $("#review-body");
  body.innerHTML = `<div class="empty">불러오는 중…</div>`;
  const { data: photos } = await sb.from("photos")
    .select("id, path, thumb_path, dog_ids, ai_note, status")
    .eq("day", state.day).in("status", ["review", "error"]).order("created_at").limit(60);
  if (!photos?.length) {
    body.innerHTML = `<div class="empty">확인할 사진이 없어요 👍</div>`;
    return;
  }
  // 후보: 오늘 담당 지정된 강아지 → 없으면 활성 강아지 전체
  const todays = state.dogs.filter((d) => state.assignments.has(d.id));
  const candidates = (todays.length ? todays : state.dogs.filter((d) => d.active))
    .slice().sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const thumbUrl = await signed("photos", photos.map((p) => p.thumb_path));

  body.innerHTML = photos.map((p) => `
    <div class="review-item" data-id="${p.id}">
      <img class="big" src="${thumbUrl(p.thumb_path)}" data-full="${p.path}" alt="">
      ${p.ai_note ? `<div class="ai-note">AI 메모: ${esc(p.ai_note)}</div>` : ""}
      <div class="chips">${candidates.map((d) =>
        `<button data-dog="${d.id}" class="${p.dog_ids.includes(d.id) ? "on" : ""}">${esc(d.name)}</button>`).join("")}</div>
      <div class="row">
        <button class="btn primary grow" data-act="save">저장</button>
        <button class="btn ghost" data-act="none">강아지 없음</button>
        <button class="btn ghost" data-act="del">삭제</button>
      </div>
    </div>`).join("") + (photos.length === 60 ? `<p class="muted small">60장씩 보여드려요. 정리하면 다음 사진이 나와요.</p>` : "");

  $$(".review-item", body).forEach((item) => {
    const id = item.dataset.id;
    const photo = photos.find((p) => p.id === id);
    $$(".chips button", item).forEach((b) => b.addEventListener("click", () => b.classList.toggle("on")));
    $$("[data-act]", item).forEach((b) => b.addEventListener("click", async () => {
      const act = b.dataset.act;
      if (act === "del") {
        if (!confirm("이 사진을 삭제할까요?")) return;
        await sb.storage.from("photos").remove([photo.path, photo.thumb_path]);
        await sb.from("photos").delete().eq("id", id);
      } else {
        const ids = act === "none" ? [] : $$(".chips button.on", item).map((x) => x.dataset.dog);
        if (act === "save" && !ids.length) { toast("강아지를 한 마리 이상 골라 주세요"); return; }
        await sb.from("photos").update({ dog_ids: ids, status: "done", confidence: "manual" }).eq("id", id);
      }
      item.remove();
      updateReviewBadge();
      if (!$(".review-item", body)) renderReview();
    }));
  });
  bindViewer(body);
}

/* ---------- 관리 ---------- */
async function renderAdmin() {
  renderAssign();
  renderDogs();
  renderTeachers();
}

function renderAssign() {
  const active = state.dogs.filter((d) => d.active);
  const body = $("#assign-body");
  if (!active.length) {
    body.innerHTML = `<div class="muted small">먼저 아래에서 강아지를 등록해 주세요.</div>`;
    return;
  }
  const opts = (sel) => `<option value="">안 옴</option>` + state.teachers.map((t) =>
    `<option value="${t.id}" ${t.id === sel ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  const count = state.assignments.size;
  body.innerHTML = `<p class="small"><b>${count}</b>마리 등원</p>` + active.map((d) => `
    <div class="assign-row">
      <span class="grow">${esc(d.name)}</span>
      <select data-dog="${d.id}">${opts(state.assignments.get(d.id) || "")}</select>
    </div>`).join("");
  $$("select", body).forEach((s) => s.addEventListener("change", async () => {
    const dogId = s.dataset.dog;
    if (s.value) {
      await sb.from("assignments").upsert({ day: state.day, dog_id: dogId, teacher_id: s.value });
      state.assignments.set(dogId, s.value);
    } else {
      await sb.from("assignments").delete().eq("day", state.day).eq("dog_id", dogId);
      state.assignments.delete(dogId);
    }
    $("p.small b", body).textContent = state.assignments.size;
  }));
}

$("#copy-prev").addEventListener("click", async () => {
  const prev = shiftDay(state.day, -1);
  const { data } = await sb.from("assignments").select("dog_id, teacher_id").eq("day", prev);
  if (!data?.length) { toast("전날 담당 기록이 없어요"); return; }
  if (state.assignments.size && !confirm("지금 담당을 전날 담당으로 바꿀까요?")) return;
  await sb.from("assignments").delete().eq("day", state.day);
  await sb.from("assignments").insert(data.map((a) => ({ ...a, day: state.day })));
  await loadAssignments();
  renderAssign();
  toast("전날 담당을 불러왔어요");
});

async function renderDogs() {
  const list = $("#dog-list");
  const refUrl = await signed("refs", state.dogs.map((d) => d.ref_path));
  list.innerHTML = state.dogs.map((d) => `
    <div class="dog-row ${d.active ? "" : "off"}" data-id="${d.id}">
      <label class="ref-pick" style="width:52px;height:52px">
        <input type="file" accept="image/*" hidden data-ref>
        ${d.ref_path ? `<img src="${refUrl(d.ref_path)}" alt="">` : "사진"}
      </label>
      <div class="grow"><b>${esc(d.name)}</b><small>${esc(d.note || "")}</small></div>
      <button class="btn ghost mini" data-edit>수정</button>
      <button class="btn ghost mini" data-toggle>${d.active ? "숨기기" : "다시 표시"}</button>
    </div>`).join("") || `<div class="muted small">등록된 강아지가 없어요.</div>`;

  $$(".dog-row", list).forEach((row) => {
    const dog = dogById(row.dataset.id);
    $("[data-ref]", row).addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      await saveRef(dog, f);
      renderDogs();
    });
    $("[data-edit]", row).addEventListener("click", async () => {
      const name = prompt("이름", dog.name);
      if (name === null) return;
      const note = prompt("특징", dog.note || "");
      if (note === null) return;
      await sb.from("dogs").update({ name: name.trim() || dog.name, note: note.trim() }).eq("id", dog.id);
      Object.assign(dog, { name: name.trim() || dog.name, note: note.trim() });
      renderDogs(); renderAssign();
    });
    $("[data-toggle]", row).addEventListener("click", async () => {
      await sb.from("dogs").update({ active: !dog.active }).eq("id", dog.id);
      dog.active = !dog.active;
      renderDogs(); renderAssign();
    });
  });
}

async function saveRef(dog, file) {
  const blob = await resize(file, 512, 0.85);
  const path = `${dog.id}-${Date.now()}.jpg`;
  const { error } = await sb.storage.from("refs").upload(path, blob, { contentType: "image/jpeg" });
  if (error) { toast("기준 사진을 올리지 못했어요"); return; }
  if (dog.ref_path) await sb.storage.from("refs").remove([dog.ref_path]);
  await sb.from("dogs").update({ ref_path: path }).eq("id", dog.id);
  dog.ref_path = path;
}

let newRef = null;
$("#dog-ref").addEventListener("change", (e) => {
  newRef = e.target.files[0] || null;
  $("#dog-ref-preview").innerHTML = newRef ? `<img src="${URL.createObjectURL(newRef)}" alt="">` : "기준<br>사진";
});
$("#dog-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#dog-name").value.trim();
  if (!name) return;
  if (!newRef) { toast("기준 사진도 함께 넣어 주세요"); return; }
  const { data, error } = await sb.from("dogs")
    .insert({ name, note: $("#dog-note").value.trim() || null }).select().single();
  if (error) { toast("추가하지 못했어요"); return; }
  await saveRef(data, newRef);
  state.dogs.push(data);
  state.dogs.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  e.target.reset();
  newRef = null;
  $("#dog-ref-preview").innerHTML = "기준<br>사진";
  toast(`${name} 등록 완료`);
  renderDogs(); renderAssign();
});

function renderTeachers() {
  const box = $("#teacher-list");
  box.innerHTML = state.teachers.map((t) =>
    `<span>${esc(t.name)}<b class="x" data-id="${t.id}">×</b></span>`).join("");
  $$(".x", box).forEach((x) => x.addEventListener("click", async () => {
    const t = teacherById(x.dataset.id);
    if (!confirm(`${t.name} 선생님을 목록에서 뺄까요?`)) return;
    await sb.from("teachers").delete().eq("id", t.id);
    state.teachers = state.teachers.filter((v) => v.id !== t.id);
    renderTeachers(); renderAssign();
  }));
}
$("#teacher-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#teacher-name").value.trim();
  if (!name) return;
  const { data, error } = await sb.from("teachers")
    .insert({ name, sort: state.teachers.length + 1 }).select().single();
  if (error) { toast("추가하지 못했어요 (이미 있는 이름일 수 있어요)"); return; }
  state.teachers.push(data);
  e.target.reset();
  renderTeachers(); renderAssign();
});

$("#purge").addEventListener("click", async () => {
  const days = +$("#purge-days").value;
  const cutoff = shiftDay(kstToday(), -days);
  if (!confirm(`${cutoff} 이전 사진을 모두 삭제할까요? 되돌릴 수 없어요.`)) return;
  const msg = $("#purge-msg");
  let removed = 0;
  for (;;) {
    const { data } = await sb.from("photos").select("id, path, thumb_path").lt("day", cutoff).limit(200);
    if (!data?.length) break;
    await sb.storage.from("photos").remove(data.flatMap((p) => [p.path, p.thumb_path]));
    const del = await sb.from("photos").delete().in("id", data.map((p) => p.id));
    if (del.error) { msg.textContent = "삭제 중 오류가 났어요."; return; }
    removed += data.length;
    msg.textContent = `${removed}장 삭제 중…`;
  }
  msg.textContent = removed ? `${removed}장 삭제했어요.` : "지울 사진이 없어요.";
});

boot();
