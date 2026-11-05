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
  expanded: new Set(), // 비슷한 사진을 펼쳐 둔 아이
  hotel: new Set(),    // 오늘 호텔링(H) 아이
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

/* ---------- 비슷한 사진 판별: 이미지 지문(dHash)·선명도·촬영 시각 ---------- */
const SIM_DIST = 22;               // 지문 차이가 이 값 이하면 같은 장면 (실측: 연속 촬영 9~19, 다른 장면 31+)
const SIM_GAP = 3 * 60 * 1000;     // 3분 안에 찍힌 것끼리만 묶음
const SIM_KEEP = 3;                // 비슷한 사진 묶음마다 아이별로 보여줄 장수
async function imageStats(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  const g = c.getContext("2d", { willReadFrequently: true });
  // dHash 9x8: 먼저 72x64로 줄인 뒤 8x8 칸씩 평균 (바로 9x8로 줄이면 깨져서 비교가 부정확)
  c.width = 72; c.height = 64;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, 0, 0, 72, 64);
  const d = g.getImageData(0, 0, 72, 64).data;
  const cell = new Float32Array(72);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 72; x++) {
    const i = (y * 72 + x) * 4;
    cell[(y >> 3) * 9 + (x >> 3)] += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  }
  let hex = "", nib = 0, bits = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    nib = (nib << 1) | (cell[y * 9 + x + 1] > cell[y * 9 + x] ? 1 : 0);
    if (++bits % 4 === 0) { hex += nib.toString(16); nib = 0; }
  }
  // 선명도: 256px 회색조 라플라시안 분산
  const sc = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
  const w = Math.max(3, Math.round(bmp.width * sc)), h = Math.max(3, Math.round(bmp.height * sc));
  c.width = w; c.height = h;
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const p = g.getImageData(0, 0, w, h).data;
  const G = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) G[i] = p[i * 4] * 0.299 + p[i * 4 + 1] * 0.587 + p[i * 4 + 2] * 0.114;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const L = 4 * G[i] - G[i - 1] - G[i + 1] - G[i - w] - G[i + w];
    sum += L; sum2 += L * L; n++;
  }
  return { phash: hex, sharp: n ? sum2 / n - (sum / n) ** 2 : 0 };
}
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 99;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}
// 사진 원본에서 촬영 시각(EXIF DateTimeOriginal) 읽기, 한국 시간 기준
async function exifTime(file) {
  try {
    const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (buf.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off < buf.byteLength - 4) {
      const marker = buf.getUint16(off), len = buf.getUint16(off + 2);
      if (marker === 0xffe1 && buf.getUint32(off + 4) === 0x45786966) {
        const t = off + 10, le = buf.getUint16(t) === 0x4949;
        const u16 = (o) => buf.getUint16(t + o, le), u32 = (o) => buf.getUint32(t + o, le);
        const readTag = (ifd, tag) => {
          const n = u16(ifd);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (u16(e) === tag) return { count: u32(e + 4), val: u32(e + 8) };
          }
          return null;
        };
        const exif = readTag(u32(4), 0x8769);
        const dt = exif && readTag(exif.val, 0x9003);
        if (!dt) return null;
        let str = "";
        for (let i = 0; i < 19; i++) str += String.fromCharCode(buf.getUint8(t + dt.val + i));
        const m = str.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00` : null;
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + len;
    }
  } catch { /* 못 읽으면 없음 */ }
  return null;
}
// 한 아이의 사진들을 비슷한 장면끼리 묶어, 묶음마다 가장 선명한 3장만 보여줌
function splitSimilar(list) {
  const t = (p) => new Date(p.taken_at || p.created_at).getTime();
  const sorted = [...list].sort((a, b) => t(a) - t(b));
  const clusters = [];
  for (const p of sorted) {
    let home = null;
    for (let k = clusters.length - 1; k >= Math.max(0, clusters.length - 4) && !home; k--) {
      if (clusters[k].some((q) => p.phash && q.phash && hamming(p.phash, q.phash) <= SIM_DIST && Math.abs(t(p) - t(q)) <= SIM_GAP)) home = clusters[k];
    }
    if (home) home.push(p); else clusters.push([p]);
  }
  const keep = new Set();
  for (const c of clusters) {
    [...c].sort((a, b) => (b.sharp || 0) - (a.sharp || 0)).slice(0, SIM_KEEP).forEach((p) => keep.add(p.id));
  }
  return { shown: sorted.filter((p) => keep.has(p.id)), extra: sorted.filter((p) => !keep.has(p.id)) };
}

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
const refCount = (d) => (d?.dog_refs?.length || (d?.ref_path ? 1 : 0));

// 대표 사진 여러 장 추가 (한 번 올리면 계속 기억)
async function addRefs(dog, files, onEach) {
  let added = 0;
  for (const f of files) {
    try {
      const blob = await resize(f, 512, 0.85); // 여러 장을 AI가 한 번에 보도록 작게
      const path = `${dog.id}-${Date.now()}-${added}.jpg`;
      const up = await sb.storage.from("refs").upload(path, blob, { contentType: "image/jpeg" });
      if (up.error) throw up.error;
      const { data: row, error } = await sb.from("dog_refs").insert({ dog_id: dog.id, path }).select().single();
      if (error) throw error;
      dog.dog_refs = [...(dog.dog_refs || []), row];
      if (!dog.ref_path) {
        await sb.from("dogs").update({ ref_path: path }).eq("id", dog.id);
        dog.ref_path = path;
      }
      added++;
      onEach?.(added);
    } catch (err) { console.error(err); }
  }
  return added;
}
async function removeRef(dog, ref) {
  await sb.from("dog_refs").delete().eq("id", ref.id);
  await sb.storage.from("refs").remove([ref.path]);
  dog.dog_refs = (dog.dog_refs || []).filter((r) => r.id !== ref.id);
  if (dog.ref_path === ref.path) {
    const next = dog.dog_refs[0]?.path || null;
    await sb.from("dogs").update({ ref_path: next }).eq("id", dog.id);
    dog.ref_path = next;
  }
}

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
  const { data } = await sb.from("dogs").select("*, dog_refs(id, path, created_at)");
  (data || []).forEach((d) => (d.dog_refs || []).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  state.dogs = (data || []).sort(dogOrder);
}
async function loadAttendance() {
  const { data } = await sb.from("assignments").select("dog_id, hotel").eq("day", state.day);
  state.attendance = new Set((data || []).map((a) => a.dog_id));
  state.hotel = new Set((data || []).filter((a) => a.hotel).map((a) => a.dog_id)); // 오늘 호텔링(H)
}
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

async function loadPhotos() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("photos")
      .select("id, path, thumb_path, dog_ids, status, ai_note, confidence, created_at, taken_at, phash, sharp, rotation")
      .eq("day", state.day).order("created_at").range(from, from + 999);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  state.photos = all;
  backfillStats();
}

// 지문이 없는 예전 사진은 썸네일로 계산해서 채워 둠 (한 번만)
let backfilling = false;
async function backfillStats() {
  const need = state.photos.filter((p) => !p.phash);
  if (backfilling || !need.length) return;
  backfilling = true;
  try {
    const url = await signed("photos", need.map((p) => p.thumb_path));
    await pool(need, 4, async (p) => {
      try {
        const blob = await fetch(url(p.thumb_path)).then((r) => r.blob());
        const st = await imageStats(blob);
        await sb.from("photos").update(st).eq("id", p.id);
        Object.assign(p, st);
      } catch { /* 다음에 다시 */ }
    });
  } finally { backfilling = false; }
  if (state.tab === "photos") renderPhotos();
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
  else if (state.tab === "roster") renderRoster();
  else if (state.tab === "admin") renderUpLinks();
  renderSide();
}

/* ================= 사진 화면 ================= */
async function renderPhotos() {
  renderRoll(); // 왼쪽 오늘 명단(장수)도 함께 갱신
  const P = state.photos;
  const done = P.filter((p) => p.status === "done");
  const unsorted = P.filter((p) => p.status === "review" || p.status === "error");
  const pending = P.filter((p) => p.status === "pending");

  $("#summary").innerHTML = P.length
    ? `<span><b>${P.length}</b>장</span>
       <span>분류 완료 <b>${done.length}</b></span>
       ${unsorted.length ? `<span class="warn">분류 안 됨 <b>${unsorted.length}</b></span>` : ""}
       ${pending.length && !state.busy ? `<button id="resume" class="btn primary sm">남은 ${pending.length}장 분류하기</button>` : ""}
       ${!state.busy && done.some((p) => p.dog_ids.some((d) => dogById(d)?.auto)) ? `<button id="recheck-auto" class="btn ghost sm">새 강아지 다시 분류</button>` : ""}
       ${done.length ? `<button id="save-all" class="btn primary sm">📥 전체 다운로드</button>` : ""}`
    : "";
  $("#resume")?.addEventListener("click", () => classifyPending());
  $("#recheck-auto")?.addEventListener("click", () => { autoChecked.clear(); recheckAutoGroups(); });
  $("#save-all")?.addEventListener("click", (e) => saveAll(e.currentTarget));

  // 강아지별 묶기
  const groups = new Map();
  done.forEach((p) => p.dog_ids.forEach((d) => {
    if (!dogById(d)) return;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(p);
  }));
  const dogIds = [...groups.keys()].sort((a, b) => dogOrder(dogById(a), dogById(b)));
  // 비슷한 사진은 3장까지만 보이고 저장 (펼치면 전부)
  const sets = new Map(dogIds.map((id) => [id, splitSimilar(groups.get(id))]));
  const visible = (id) => (state.expanded.has(id) ? [...sets.get(id).shown, ...sets.get(id).extra] : sets.get(id).shown);

  const box = $("#groups");
  if (!P.length) {
    box.innerHTML = `<div class="empty">아직 이 날짜에 올린 사진이 없어요.<br>위에서 사진을 올려 보세요.</div>`;
    return;
  }

  const thumb = await signed("photos", P.map((p) => p.thumb_path));
  const ref = await signed("refs", dogIds.map((id) => dogById(id)?.ref_path));
  const img = (p) => `<img loading="lazy" src="${thumb(p.thumb_path)}" data-photo="${p.id}" class="rot${p.rotation || 0}${p.status === "done" && p.confidence === "low" ? " unsure" : ""}" alt=""${p.status === "done" && p.confidence === "low" ? ' title="AI가 확신하지 못한 사진 — 확인해 주세요"' : ""}>`;

  box.innerHTML = dogIds.map((id) => {
    const dog = dogById(id);
    const { shown, extra } = sets.get(id);
    const open = state.expanded.has(id);
    return `<div class="dog-group" data-list="${id}">
      <div class="dog-head">
        ${dog.ref_path ? `<img class="avatar" src="${ref(dog.ref_path)}" alt="">` : `<span class="avatar"></span>`}
        <div class="grow">
          <button class="dog-name ${dog.auto ? "unnamed" : ""}" data-rename="${id}">${esc(dog.name)} <span>✎</span></button>
          <small class="muted">${shown.length}장${extra.length ? ` · 비슷한 사진 ${extra.length}장 ${open ? "펼침" : "접힘"}` : ""}</small>
        </div>
        <div class="save-btns">${saveButtons(id)}</div>
      </div>
      <div class="grid">${shown.map(img).join("")}</div>
      ${extra.length ? `<button class="more-sim" data-expand="${id}">${open ? "비슷한 사진 접기 ▲" : `비슷한 사진 ${extra.length}장 더 보기 ▼`}</button>
        ${open ? `<div class="grid extra">${extra.map(img).join("")}</div>` : ""}` : ""}
    </div>`;
  }).join("") +
  (unsorted.length ? `<div class="dog-group unsorted" data-list="unsorted">
      <div class="dog-head"><span class="avatar q">?</span>
        <div class="grow"><b>분류 안 된 사진 ${unsorted.length}장</b><small class="muted">AI가 확신하지 못한 사진이에요. 이름? 표시는 AI 추측이니, 눌러서 맞으면 [분류 저장]만 누르세요</small></div>
        ${state.busy ? "" : `<button id="reclassify" class="btn ghost sm">AI로 다시 분류</button>`}</div>
      <div class="grid">${unsorted.map((p) => {
        const guess = p.dog_ids.map((d) => dogById(d)?.name).filter(Boolean).join("·");
        return guess ? `<div class="guess">${img(p)}<span>${esc(guess)}?</span></div>` : img(p);
      }).join("")}</div>
    </div>` : "") +
  (!dogIds.length && !unsorted.length ? `<div class="empty">분류를 기다리는 사진이 있어요.</div>` : "");

  // 사진 넘겨보기용: 그룹별 사진 순서
  const lists = new Map(dogIds.map((id) => [id, visible(id).map((p) => p.id)]));
  $$("[data-expand]", box).forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.expand;
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
    renderPhotos();
  }));
  lists.set("unsorted", unsorted.map((p) => p.id));
  $$("[data-photo]", box).forEach((el) => el.addEventListener("click", () => {
    const key = el.closest("[data-list]")?.dataset.list;
    openSheet(el.dataset.photo, lists.get(key) || [el.dataset.photo], key);
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
    saveDogPhotos(dogById(b.dataset.save), visible(b.dataset.save), b, b.dataset.mode)));
}

async function renameDog(dog) {
  const need = state.dogs.filter((d) => !d.auto && !d.ref_path && state.attendance.has(d.id))
    .map((d) => (state.hotel.has(d.id) ? `${d.name}(H)` : d.name));
  const hint = need.length ? `\n(오늘 명단 중 얼굴을 아직 모르는 아이: ${need.join(", ")})` : "";
  const name = prompt(`강아지 이름${hint}`, dog.auto ? "" : dog.name);
  if (!name || !name.trim()) return false;
  const nm = name.trim();
  let same = state.dogs.find((d) => d.id !== dog.id && norm(d.name) === norm(nm));
  if (!same) {
    // "구름"이라고만 써도 명단의 구름(포메라니안) 등과 연결
    const m = matchDog(nm, null);
    if (m.dog && m.dog.id !== dog.id) same = m.dog;
    else if (m.choices) {
      const list = m.choices.filter((c) => c.id !== dog.id);
      const v = prompt(`'${nm}' 이름의 아이가 여럿이에요. 번호를 골라 주세요 (새 아이면 0)\n` +
        list.map((c, i) => `${i + 1}. ${c.name}`).join("\n"), "1");
      if (v === null) return false;
      same = list[+v - 1] || null;
    }
  }
  if (same) {
    if (!confirm(`'${same.name}'(이)가 이미 있어요. 이 그룹 사진을 '${same.name}'(으)로 합칠까요?`)) return false;
    const moved = refCount(same) === 0 && refCount(dog) > 0;  // 얼굴을 몰랐던 아이 → 이 그룹 사진으로 기억
    const { error } = await sb.rpc("merge_dogs", { src: dog.id, dst: same.id });
    if (error) { toast("합치지 못했어요"); return false; }
    same.dog_refs = [...(same.dog_refs || []), ...(dog.dog_refs || [])];
    if (!same.ref_path) same.ref_path = dog.ref_path;
    state.dogs = state.dogs.filter((d) => d.id !== dog.id);
    state.photos.forEach((p) => {
      if (p.dog_ids.includes(dog.id)) p.dog_ids = [...new Set(p.dog_ids.map((x) => (x === dog.id ? same.id : x)))];
    });
    toast(`'${same.name}'(으)로 합쳤어요${moved ? " · 얼굴도 기억했어요" : ""}`);
    await addToToday(same.id);
    queueRescan();
    return true;
  }
  const { error } = await sb.from("dogs").update({ name: nm, auto: false }).eq("id", dog.id);
  if (error) { toast("저장하지 못했어요"); return false; }
  Object.assign(dog, { name: nm, auto: false });
  state.dogs.sort(dogOrder);
  await addToToday(dog.id);
  queueRescan();
  return true;
}

// 이름이 붙은 아이는 오늘 명단에 넣어 AI 후보가 되게 함
async function addToToday(id) {
  if (!state.attendance.size || state.attendance.has(id)) return;
  await sb.from("assignments").insert({ day: state.day, dog_id: id });
  state.attendance.add(id);
}

// 이름이 정해지거나 얼굴을 새로 배우면, '분류 안 된 사진'을 잠시 뒤 다시 훑어서 그 아이 사진을 꺼내 옴
// (직원이 직접 뺀 사진은 건드리지 않음)
let rescanTimer = null, rescanAgain = false;
const autoChecked = new Set();

// '새 강아지' 그룹 사진을 이름 있는 아이들과 다시 비교해서, 맞는 아이가 있으면 옮기고
// 한 그룹의 사진이 대부분 같은 아이로 가면 그 그룹을 그 아이로 합침 (얼굴 사진도 함께)
async function recheckAutoGroups() {
  const autoIds = new Set(state.dogs.filter((d) => d.auto).map((d) => d.id));
  if (!autoIds.size || !state.attendance.size) return;
  await loadPhotos();
  const list = state.photos.filter((p) => p.status === "done" && p.confidence !== "manual" &&
    p.dog_ids.some((d) => autoIds.has(d)) && !autoChecked.has(p.id));
  if (!list.length) return;
  state.busy = true;
  const before = new Map(list.map((p) => [p.id, p.dog_ids.filter((d) => autoIds.has(d))]));
  let done = 0;
  progress("새 강아지 그룹을 이름 있는 아이들과 다시 비교하는 중…", 0, list.length);
  await pool(list, 3, async (p) => {
    await classifyOne(p.id, true);
    autoChecked.add(p.id);
    progress("새 강아지 그룹을 이름 있는 아이들과 다시 비교하는 중…", ++done, list.length);
  });
  await loadPhotos();
  const moved = new Map(); // 자동그룹 id → {total, to: Map(이름있는 아이 → 장수)}
  for (const p of list) {
    const now = state.photos.find((x) => x.id === p.id);
    for (const a of before.get(p.id)) {
      const m = moved.get(a) || { total: 0, to: new Map() };
      m.total++;
      if (now && !now.dog_ids.includes(a)) now.dog_ids.forEach((d) => m.to.set(d, (m.to.get(d) || 0) + 1));
      moved.set(a, m);
    }
  }
  let merged = 0, photosMoved = 0;
  for (const [a, m] of moved) {
    const [best, n] = [...m.to].sort((x, y) => y[1] - x[1])[0] || [];
    photosMoved += [...m.to.values()].reduce((s, v) => s + v, 0);
    if (best && n >= Math.max(1, Math.ceil(m.total * 0.6))) {
      const { error } = await sb.rpc("merge_dogs", { src: a, dst: best });
      if (!error) merged++;
    }
  }
  state.busy = false;
  await loadDogs();
  await loadPhotos();
  progress(`새 강아지 다시 확인 완료 · ${photosMoved}장 이름 있는 아이로 옮김${merged ? ` · 그룹 ${merged}개 합침` : ""}`, list.length, list.length);
  setTimeout(() => $("#progress").classList.add("hidden"), 5000);
  await render();
}
function queueRescan() {
  autoChecked.clear();
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(rescanUnsorted, 30000);
}
async function rescanUnsorted() {
  if (state.busy) { rescanAgain = true; return; }
  const ids = state.photos.filter((p) => (p.status === "review" || p.status === "error") && p.confidence !== "manual").map((p) => p.id);
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 200) {
    await sb.from("photos").update({ status: "pending" }).in("id", ids.slice(i, i + 200)).in("status", ["review", "error"]);
  }
  toast(`분류 안 된 사진 ${ids.length}장을 새로 배운 얼굴로 다시 살펴볼게요`);
  await loadPhotos();
  classifyPending();
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

// 보드 이름 → 명단의 아이. "구름"처럼 같은 이름이 여럿(구름(포메라니안)·구름(비숑 프리제))이면 고르게 함
const baseName = (s) => norm(String(s || "").replace(/\s*\(.*\)\s*$/, ""));
function matchDog(n, draft = state.draft, usePick = true) {
  const pick = usePick && draft?.pick?.[norm(n)];
  if (pick) return { dog: dogById(pick) };
  const named = state.dogs.filter((d) => !d.auto);
  const exact = named.filter((d) => norm(d.name) === norm(n));
  const withRefs = (arr) => arr.filter((d) => refCount(d) > 0);
  if (withRefs(exact).length === 1) return { dog: withRefs(exact)[0] };
  const same = named.filter((d) => baseName(d.name) === baseName(n));
  const good = withRefs(same);
  if (good.length === 1) return { dog: good[0] };
  if (good.length > 1) return { choices: good };
  if (exact.length) return { dog: exact[0] };
  return {};
}
const isNewName = (n) => { const m = matchDog(n); return !m.dog && !m.choices; };
const isHotelName = (draft, n) => (draft.hotel || []).some((h) => norm(h) === norm(n));

async function renderRoll() {
  renderSide();
  const body = $("#roll-body");
  const count = $("#roll-count");

  // ① 보드에서 읽은 명단 확인·수정
  if (state.draft) {
    const d = state.draft;
    count.textContent = `${d.names.length}마리 읽음`;
    const amb = d.names.map((n, i) => ({ n, i, c: matchDog(n, d, false).choices })).filter((x) => x.c);
    const ambRef = amb.length ? await signed("refs", amb.flatMap((x) => x.c.map((c) => c.ref_path))) : null;
    body.innerHTML = `
      ${amb.length ? `<div class="same-name">
        <b>이름이 같은 아이가 있어요 — 오늘 온 아이를 눌러 주세요</b>
        ${amb.map(({ n, i, c }) => `<div class="same-row"><span class="same-label">${esc(n)}${d.guessed?.has(norm(n)) && d.pick?.[norm(n)] ? ` <small class="muted">(최근 자주 온 아이로 골라 둠)</small>` : ""}</span>
          <div class="same-opts">${c.map((x) => `<button class="same-opt ${d.pick?.[norm(n)] === x.id ? "on" : ""}" data-same="${i}" data-id="${x.id}">
            ${x.ref_path ? `<img src="${ambRef(x.ref_path)}" alt="">` : ""}<span>${esc(x.name)}</span></button>`).join("")}</div></div>`).join("")}
      </div>` : ""}
      ${d.img ? `<img class="board-preview" src="${d.img}" alt="출석 보드">${d.more ? `<p class="muted small" style="margin:-4px 0 8px">외 ${d.more}장 함께 읽음</p>` : ""}` : ""}
      <p class="small">읽은 이름이 맞는지 확인해 주세요. <b>이름을 누르면 고칠 수 있고</b>, ×로 뺄 수 있어요.
        ${d.names.some((n) => isNewName(n) && !isHotelName(d, n)) ? `<em class="tag-new">새 아이</em>는 명단에 없는 이름이라 확정 후 대표 사진을 받을게요.` : ""}
        <span class="tag-h">H</span> 표시는 호텔링이에요. 눌러서 켜고 끌 수 있어요. 호텔링 아이는 대표 사진 없이 분류하고, 모르는 아이는 '새 강아지'로 묶어 두면 나중에 이름을 붙이면 돼요.
        ${d.unsure.length ? `<span class="q-legend">?</span> 표시는 글씨가 애매했던 이름이에요.` : ""}</p>
      <div class="chips roll-chips">${d.names.map((n, i) => `
        <span class="${d.unsure.includes(n) ? "unsure" : ""} ${isNewName(n) && !isHotelName(d, n) ? "new" : ""} ${isHotelName(d, n) ? "hotel" : ""}"><b data-h="${i}" class="h-toggle" title="호텔링 켜기/끄기">H</b><b data-edit="${i}">${esc(n)}</b>${(() => {
          const m = matchDog(n, d);
          if (m.choices) return `<select data-pick="${i}" class="pick-dog"><option value="">어느 아이?</option>${m.choices.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>`;
          if (m.dog && norm(m.dog.name) !== norm(n)) return `<small class="muted"> → ${esc(m.dog.name)}</small>`;
          return "";
        })()}${isNewName(n) && !isHotelName(d, n) ? `<em class="tag-new">새 아이</em>` : ""}<b class="x" data-del="${i}">×</b></span>`).join("")
        || `<span class="muted small">아직 이름이 없어요</span>`}</div>
      <form id="roll-add" class="row">
        <input id="roll-add-name" class="grow" placeholder="빠진 이름 추가">
        <button class="btn ghost" type="submit">추가</button>
      </form>
      <div class="row" style="margin-top:10px">
        <button id="roll-confirm" class="btn primary grow" ${d.names.length && !d.names.some((n) => matchDog(n, d).choices) ? "" : "disabled"}>${d.names.some((n) => matchDog(n, d).choices) ? "이름이 같은 아이를 먼저 골라 주세요" : `명단 확정 (${d.names.length}마리)`}</button>
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
    $$("[data-same]", body).forEach((el) => el.addEventListener("click", () => {
      const k = norm(d.names[+el.dataset.same]);
      d.pick = { ...(d.pick || {}), [k]: el.dataset.id };
      d.guessed?.delete(k);
      renderRoll();
    }));
    $$("[data-pick]", body).forEach((el) => el.addEventListener("change", () => {
      if (!el.value) return;
      d.pick = { ...(d.pick || {}), [norm(d.names[+el.dataset.pick])]: el.value };
      renderRoll();
    }));
    $$("[data-h]", body).forEach((el) => el.addEventListener("click", () => {
      const n = d.names[+el.dataset.h];
      d.hotel = d.hotel || [];
      d.hotel = isHotelName(d, n) ? d.hotel.filter((h) => norm(h) !== norm(n)) : [...d.hotel, n];
      renderRoll();
    }));
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
      <p class="muted small">출석 보드 사진이나 <b>다이얼독 알림장 목록 캡처</b>를 올리면 AI가 이름을 읽어 명단을 만들어요. 캡처는 여러 장을 한 번에 골라도 돼요. (안 해도 분류는 돼요)</p>
      <div class="row">
        <button id="roll-board" class="btn primary grow">📋 출석 보드 사진</button>
        <button id="roll-app" class="btn primary grow">📱 다이얼독 캡처</button>
        <button id="roll-manual" class="btn ghost">직접 입력</button>
      </div>`;
    $("#roll-board").addEventListener("click", () => $("#board-file").click());
    $("#roll-app").addEventListener("click", () => $("#board-file").click());
    $("#roll-manual").addEventListener("click", () => { state.draft = { names: [], unsure: [], img: "" }; renderRoll(); });
    return;
  }

  // ③ 확정된 명단: 얼굴 아는 아이 ✓ / 처음 보는 아이는 대표 사진 올리기
  const hotelDogs = roll.filter((dg) => state.hotel.has(dg.id));
  const known = roll.filter((dg) => refCount(dg) && !state.hotel.has(dg.id));
  const need = roll.filter((dg) => !refCount(dg) && !state.hotel.has(dg.id));
  count.textContent = `${roll.length}마리${hotelDogs.length ? ` (호텔링 ${hotelDogs.length})` : ""}${need.length ? ` · 대표 사진 필요 ${need.length}` : ""}`;
  const ref = await signed("refs", [...known, ...hotelDogs].map((dg) => dg.ref_path));
  body.innerHTML = `
    ${need.length ? `<p class="small">명단에 없던 아이예요. <b>대표 사진</b>을 올려 주세요. 정면·옆·뒤·엎드린 모습 등 <b>여러 장</b>을 한 번에 고를수록 더 잘 알아봐요. 한 번 올리면 다음부터는 묻지 않아요.</p>
    <div class="need-list">${need.map((dg) => `
      <div class="need-row"><span class="avatar"></span><b class="grow">${esc(dg.name)}</b>
        <button class="btn primary sm" data-ref-for="${dg.id}">대표 사진 올리기</button></div>`).join("")}</div>` : ""}
    ${known.length ? `<div class="known-list">${known.map((dg) => `
      <span class="known" title="얼굴 기억함"><img src="${ref(dg.ref_path)}" alt="">${esc(dg.name)}<i>✓</i></span>`).join("")}</div>` : ""}
    ${hotelDogs.length ? `<p class="small" style="margin:10px 0 4px">🏨 <b>호텔링</b> · 대표 사진 없이 분류해요. AI가 모르는 아이는 '새 강아지'로 묶어 두니, 나중에 이 이름으로 붙이면 얼굴도 기억해요.</p>
    <div class="known-list">${hotelDogs.map((dg) => `
      <span class="known hotel">${dg.ref_path ? `<img src="${ref(dg.ref_path)}" alt="">` : ""}<b class="tag-h">H</b>${esc(dg.name)}</span>`).join("")}</div>` : ""}
    <div class="row" style="margin-top:10px">
      <button id="roll-edit" class="btn ghost sm">명단 수정</button>
      <button id="roll-board" class="btn ghost sm">보드·캡처 다시 읽기</button>
    </div>`;
  $$("[data-ref-for]", body).forEach((b) => b.addEventListener("click", () => {
    refTarget = b.dataset.refFor;
    $("#ref-file").click();
  }));
  $("#roll-edit").addEventListener("click", () => {
    state.draft = { names: roll.map((dg) => dg.name), unsure: [], img: "", hotel: hotelDogs.map((dg) => dg.name) };
    renderRoll();
  });
  $("#roll-board").addEventListener("click", () => $("#board-file").click());
}

// 보드 사진·앱 캡처(여러 장) → 이름 읽기
$("#board-file").addEventListener("change", async (e) => {
  const files = [...e.target.files].slice(0, 10);
  e.target.value = "";
  if (!files.length) return;
  const body = $("#roll-body");
  body.innerHTML = `<div class="reading"><span class="spinner"></span> ${files.length > 1 ? `${files.length}장에서 ` : ""}이름을 읽는 중… (10~20초 걸려요)</div>`;
  try {
    const blobs = await Promise.all(files.map((f) => resize(f, 1600, 0.85)));
    const images = await Promise.all(blobs.map(blobToBase64));
    const known = state.dogs.filter((d) => !d.auto).map((d) => d.name);
    const { data, error } = await sb.functions.invoke("read-board", { body: { images, known } });
    if (error) {
      let msg = "";
      try { msg = (await error.context.json()).error || ""; } catch { /* 무시 */ }
      throw new Error(msg || (error.context?.status === 404 ? "이름 읽기 기능을 찾을 수 없어요" : "읽지 못했어요"));
    }
    state.draft = { names: data.names || [], unsure: data.unsure || [], hotel: data.hotel || [], img: URL.createObjectURL(blobs[0]), more: blobs.length - 1 };
    if (!state.draft.names.length) toast("이름을 찾지 못했어요. 직접 추가해 주세요.");
    await suggestPicks(state.draft);
  } catch (err) {
    toast(err.message || "읽지 못했어요. 다시 시도해 주세요.");
    if (!state.draft) state.draft = { names: [], unsure: [], img: "" };
  }
  renderRoll();
});

// 이름이 같은 아이가 여럿이면: 최근에 자주 온 아이를 미리 골라 둠 (바꿀 수 있음)
async function suggestPicks(d) {
  const amb = d.names.map((n) => [n, matchDog(n, d, false).choices]).filter(([, c]) => c);
  if (!amb.length) return;
  const ids = amb.flatMap(([, c]) => c.map((x) => x.id));
  const { data } = await sb.from("assignments").select("dog_id, day").in("dog_id", ids).lt("day", state.day)
    .order("day", { ascending: false }).limit(1000);
  const score = new Map();
  (data || []).forEach((a) => score.set(a.dog_id, (score.get(a.dog_id) || 0) + 1));
  d.pick = d.pick || {};
  d.guessed = new Set();
  for (const [n, c] of amb) {
    const best = [...c].sort((a, b) => (score.get(b.id) || 0) - (score.get(a.id) || 0));
    if ((score.get(best[0].id) || 0) > (score.get(best[1].id) || 0)) {
      d.pick[norm(n)] = best[0].id;
      d.guessed.add(norm(n));
    }
  }
}

// 명단 확정 → 아는 아이는 연결, 처음 보는 이름은 새로 등록
async function confirmRoll() {
  const btn = $("#roll-confirm");
  btn.disabled = true;
  btn.textContent = "저장 중…";
  try {
    const ids = [];
    const hotelIds = new Set();
    for (const name of state.draft.names) {
      let dog = matchDog(name).dog;
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
      if (isHotelName(state.draft, name)) hotelIds.add(dog.id);
    }
    await sb.from("assignments").delete().eq("day", state.day);
    const uniq = [...new Set(ids)];
    if (uniq.length) {
      const { error } = await sb.from("assignments").insert(uniq.map((dog_id) => ({ day: state.day, dog_id, hotel: hotelIds.has(dog_id) })));
      if (error) throw error;
    }
    state.attendance = new Set(uniq);
    state.hotel = hotelIds;
    state.draft = null;
    state.dogs.sort(dogOrder);
    const need = uniq.filter((id) => !dogById(id)?.ref_path && !hotelIds.has(id)).length;
    toast(need ? `명단 저장! 대표 사진이 필요한 아이 ${need}마리` : "명단 저장! 모두 아는 얼굴이에요");
  } catch (err) {
    console.error(err);
    toast("저장하지 못했어요. 다시 시도해 주세요.");
  }
  renderPhotos();
  classifyPending(); // 기다리던 사진이 있으면 바로 분류 시작
}

// 대표 사진 올리기 (한 번 올리면 계속 기억)
let refTarget = null;
$("#ref-file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  const dog = dogById(refTarget);
  refTarget = null;
  if (!files.length || !dog) return;
  toast(`${dog.name} 사진 올리는 중…`);
  const n = await addRefs(dog, files);
  toast(n ? `${dog.name} 얼굴을 기억했어요 (${n}장)` : "올리지 못했어요. 다시 시도해 주세요.");
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
  // 똑같은 사진(같은 파일을 두 번 올린 것)은 건너뜀: 같은 찍은 시각 + 거의 같은 이미지
  await loadPhotos();
  const seen = state.photos.filter((p) => p.phash).map((p) => ({ h: p.phash, t: p.taken_at ? +new Date(p.taken_at) : null }));
  const isDup = (h, t) => h && seen.some((x) => x.t === t && hamming(x.h, h) <= 4);
  let dupes = 0;
  await pool(files, 3, async (file) => {
    try {
      const id = crypto.randomUUID();
      const [full, small, taken] = await Promise.all([resize(file, 1600, 0.85), resize(file, 640, 0.8), exifTime(file)]);
      const st = await imageStats(small).catch(() => ({}));
      const t = taken ? +new Date(taken) : null;
      if (isDup(st.phash, t)) { dupes++; n++; progress("사진 올리는 중… 창을 닫지 마세요", n, files.length, `똑같은 사진 ${dupes}장 건너뜀`); return; }
      seen.push({ h: st.phash, t });
      const path = `${day}/${id}.jpg`, thumbPath = `${day}/thumb/${id}.jpg`;
      const opt = { contentType: "image/jpeg", upsert: false };
      const [a, b] = await Promise.all([
        sb.storage.from("photos").upload(path, full, opt),
        sb.storage.from("photos").upload(thumbPath, small, opt),
      ]);
      if (a.error || b.error) throw a.error || b.error;
      const ins = await sb.from("photos").insert({ id, day, path, thumb_path: thumbPath, taken_at: taken, ...st });
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
async function classifyOne(photoId, recheck = false) {
  for (let attempt = 0; attempt < 4; attempt++) {
    // 2분 넘게 답이 없으면 멈춘 것으로 보고 다시 시도
    const res = await Promise.race([
      sb.functions.invoke("classify", { body: { photo_id: photoId, recheck } }),
      sleep(120000).then(() => ({ error: { context: { status: 504 } } })),
    ]);
    const { error } = res;
    if (!error) return true;
    const status = error.context?.status;
    if (status === 503 || status === 429 || status === 504 || status === 546) { await sleep(2000 * 2 ** attempt); continue; }
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
  const { data } = await sb.from("photos").select("id, phash, sharp, taken_at").eq("day", state.day).eq("status", "pending").order("created_at");
  const all = data || [];
  // 연속으로 찍은 거의 같은 사진(5초 안, 이미지 거의 같음)은 가장 선명한 1장만 AI에게 보내고 결과를 나머지에 그대로 적용
  const byTime = [...all].sort((a, b) => String(a.taken_at || "").localeCompare(String(b.taken_at || "")));
  const twins = new Map(); // 대표 id → 같은 장면 id[]
  const used = new Set();
  for (let i = 0; i < byTime.length; i++) {
    const a = byTime[i];
    if (used.has(a.id)) continue;
    const grp = [a];
    for (let j = i + 1; j < byTime.length; j++) {
      const b = byTime[j];
      if (!a.taken_at || !b.taken_at) break;
      if (Math.abs(new Date(b.taken_at) - new Date(grp[grp.length - 1].taken_at)) > 5000) break;
      if (!used.has(b.id) && hamming(a.phash, b.phash) <= 12) grp.push(b);
    }
    grp.forEach((x) => used.add(x.id));
    const rep = grp.reduce((m, x) => ((x.sharp || 0) > (m.sharp || 0) ? x : m), grp[0]);
    twins.set(rep.id, grp.filter((x) => x.id !== rep.id).map((x) => x.id));
  }
  const list = all.filter((p) => twins.has(p.id));
  if (!list.length) { $("#progress").classList.add("hidden"); await render(); return; }
  // 명단부터: 오늘 온 아이들 안에서만 찾아야 빠르고 정확함
  if (state.draft) {
    progress(`사진 ${list.length}장이 기다리고 있어요`, 0, list.length,
      "위의 '명단 확정'을 먼저 눌러 주세요. 확정하면 오늘 온 아이들 안에서만 찾아서 훨씬 빠르고 정확해요. 누르면 바로 이어서 분류해요.");
    await render();
    return;
  }
  state.busy = true;
  const noRoll = !state.attendance.size;
  lastError = "";
  let ok = 0, fail = 0, done = 0, stop = false;
  const saved = all.length - list.length;
  const tick = () => progress("AI가 강아지별로 묶는 중… 창을 닫지 마세요", done, list.length,
    noRoll ? "오늘 출석 명단이 없어서 등록된 모든 아이와 비교해요 (느려요). 출석 보드를 먼저 올리면 빨라져요."
           : `아래 목록이 조금씩 채워져요${saved ? ` · 연속 사진 ${saved}장은 같은 장면이라 함께 처리` : ""}`);
  tick();
  // 처음 몇 장은 한 장씩(새 아이 그룹이 겹치지 않게), 그다음은 6장씩 동시에
  const runOne = async (id) => {
    if (stop) return;
    if (await classifyOne(id)) {
      ok++;
      const sibs = twins.get(id) || [];
      if (sibs.length) {
        const { data: r } = await sb.from("photos").select("dog_ids, status, confidence, rotation").eq("id", id).single();
        if (r) {
          await sb.from("photos").update({ ...r, ai_note: "연속 사진: 바로 앞 사진과 같은 분류" }).in("id", sibs);
          ok += sibs.length;
        }
      }
    } else if (++fail >= 3 && !ok) stop = true;    // 설정 문제면 바로 멈춤
    done++;
    tick();
    if (done % 12 === 0 && state.tab === "photos") { await loadDogs(); await loadPhotos(); await renderPhotos(); }
  };
  const head = list.slice(0, 6), rest = list.slice(6);
  for (const p of head) await runOne(p.id);
  if (!stop) await pool(rest, 6, (p) => runOne(p.id));
  state.busy = false;
  if (rescanAgain) { rescanAgain = false; queueRescan(); }
  else if (!stop) await recheckAutoGroups();
  if (fail && lastError) {
    progress("분류를 멈췄어요", ok, list.length, lastError);
  } else {
    progress(`완료! ${ok}장 분류했어요`, list.length, list.length, saved ? `연속 사진 ${saved}장은 함께 처리해서 시간을 줄였어요` : "");
    setTimeout(() => $("#progress").classList.add("hidden"), 4000);
  }
  await render();
}

/* ---------- 사진 시트 (크게 보기 + 강아지 지정) ---------- */
let sheetPhoto = null;
let sheetList = [];
let sheetKey = null; // 연 그룹 (강아지 id 또는 "unsorted")
async function openSheet(photoId, list = sheetList, key = sheetKey) {
  sheetKey = key;
  const p = state.photos.find((x) => x.id === photoId);
  if (!p) return;
  sheetPhoto = p;
  sheetList = list;
  const i = sheetList.indexOf(photoId);
  $("#sheet-count").textContent = sheetList.length > 1 ? `${i + 1} / ${sheetList.length}` : "";
  $("#sheet-prev").disabled = i <= 0;
  $("#sheet-next").disabled = i < 0 || i >= sheetList.length - 1;
  const url = await signed("photos", [p.path]);
  await showSheetImage(p, url(p.path));
  $("#sheet-note").textContent = p.ai_note ? `AI 메모: ${p.ai_note}` : "";
  // 오늘 출석한 아이를 앞쪽에
  const chipDogs = state.dogs.filter((d) => d.active)
    .sort((a, b) => (state.attendance.has(b.id) - state.attendance.has(a.id)) || dogOrder(a, b));
  $("#sheet-chips").innerHTML = chipDogs.map((d) =>
    `<button data-dog="${d.id}" data-name="${esc(norm(d.name))}" class="${p.dog_ids.includes(d.id) ? "on" : ""}">${esc(d.name)}</button>`).join("")
    || `<span class="muted small">아직 강아지 그룹이 없어요. '새 강아지로'를 눌러 주세요.</span>`;
  $$("#sheet-chips button").forEach((b) => b.addEventListener("click", () => { b.classList.toggle("on"); renderPicked(); }));
  $("#sheet-search").value = "";
  filterChips();
  renderPicked();
  const inGroup = sheetKey && sheetKey !== "unsorted" && p.dog_ids.includes(sheetKey);
  $("#sheet-out").classList.toggle("hidden", !inGroup);
  $("#sheet-out").textContent = inGroup ? `${dogById(sheetKey)?.name || ""}에서 빼기` : "여기서 빼기";
  $("#sheet-del").classList.toggle("hidden", inGroup);
  $("#sheet").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  // 다음 사진 미리 불러오기
  const nextId = sheetList[i + 1];
  const next = nextId && state.photos.find((x) => x.id === nextId);
  if (next) signed("photos", [next.path]).then((u) => { new Image().src = u(next.path); });
}
// 고른 아이들을 위에 한 줄로 (× 로 빼기)
function renderPicked() {
  const on = $$("#sheet-chips button.on");
  $("#sheet-picked").innerHTML = on.length
    ? on.map((b) => `<span class="tag" data-un="${b.dataset.dog}">${esc(b.textContent)} <b>×</b></span>`).join("")
    : `<span class="muted small">아직 고른 아이가 없어요</span>`;
  $$("#sheet-picked [data-un]").forEach((t) => t.addEventListener("click", () => {
    $(`#sheet-chips button[data-dog="${t.dataset.un}"]`)?.classList.remove("on");
    renderPicked();
  }));
}
function filterChips() {
  const q = norm($("#sheet-search").value || "");
  $$("#sheet-chips button").forEach((b) => b.classList.toggle("hidden", !!q && !b.dataset.name.includes(q)));
}
$("#sheet-search").addEventListener("input", filterChips);
$("#sheet-search").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  e.preventDefault();
  const q = norm(e.target.value || "");
  if (!q) return;
  const vis = $$("#sheet-chips button:not(.hidden)");
  const b = vis.find((x) => x.dataset.name === q) || vis.find((x) => !x.classList.contains("on")) || vis[0];
  if (!b) { toast("그 이름은 명단에 없어요"); return; }
  b.classList.add("on");
  e.target.value = "";
  filterChips();
  renderPicked();
});

// 사람이 고쳐 준 사진 = AI가 틀리거나 망설인 사진 → 그 아이 대표 사진으로 배워 둠 (한 마리만 나온 사진, 아이당 하루 4장까지)
const learned = new Map();
function learnMistake(photo_id, wrong_id, right_id) {
  sb.functions.invoke("learn-mistake", { body: { photo_id, wrong_id, right_id } }).catch(() => {});
}
async function learnFrom(p, ids, before) {
  if (ids.length !== 1) return;
  const id = ids[0];
  // AI가 확신해서 맞힌 사진은 이미 아는 것 → 확신 못 했거나 틀렸거나 직원이 직접 넣은 사진만 학습
  const wasRight = before.status === "done" && before.conf === "high" && before.ids.length === 1 && before.ids[0] === id;
  if (wasRight) return;
  const k = `${state.day}:${id}`;
  if ((learned.get(k) || 0) >= 8) return;
  learned.set(k, (learned.get(k) || 0) + 1);
  try {
    const { data: blob } = await sb.storage.from("photos").download(p.thumb_path);
    const path = `${id}-learn-${Date.now()}.jpg`;
    const up = await sb.storage.from("refs").upload(path, await rotated(blob, p.rotation || 0), { contentType: "image/jpeg" });
    if (up.error) return;
    const { data: row } = await sb.from("dog_refs").insert({ dog_id: id, path }).select().single();
    const dog = dogById(id);
    if (dog && row) dog.dog_refs = [...(dog.dog_refs || []), row];
    queueRescan();
  } catch (err) { console.error(err); }
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
// 크게 보기: 돌려야 하는 사진은 실제로 돌린 이미지를 보여줌 (가로·세로가 바뀌어도 화면에 맞게)
let sheetObjUrl = null;
async function showSheetImage(p, src) {
  const el = $("#sheet-img");
  if (sheetObjUrl) { URL.revokeObjectURL(sheetObjUrl); sheetObjUrl = null; }
  el.className = "";
  if (!p.rotation) { el.src = src; return; }
  el.src = src;
  el.className = `rot${p.rotation}`; // 불러오는 동안 임시로
  try {
    const blob = await rotated(await fetch(src).then((r) => r.blob()), p.rotation);
    if (sheetPhoto !== p) return;
    sheetObjUrl = URL.createObjectURL(blob);
    el.className = "";
    el.src = sheetObjUrl;
  } catch { /* 임시 표시 유지 */ }
}

// AI가 방향을 잘못 잡았을 때 직접 돌리기 (시계 방향 90도씩)
$("#sheet-rot").addEventListener("click", async () => {
  const p = sheetPhoto;
  if (!p) return;
  p.rotation = ((p.rotation || 0) + 90) % 360;
  const url = await signed("photos", [p.path]);
  showSheetImage(p, url(p.path));
  const { error } = await sb.from("photos").update({ rotation: p.rotation }).eq("id", p.id);
  if (error) toast("저장하지 못했어요");
  const t = document.querySelector(`[data-photo="${p.id}"]`);
  if (t) t.className = `rot${p.rotation}`;
});

$("#sheet-dl").addEventListener("click", async (e) => {
  const p = sheetPhoto;
  const names = p.dog_ids.map((id) => dogById(id)?.name).filter(Boolean).join("_") || "사진";
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const { data } = await sb.storage.from("photos").download(p.path);
    const file = new File([await rotated(data, p.rotation || 0)], `${safeName(names)}_${state.day}_${p.id.slice(0, 4)}.jpg`, { type: "image/jpeg" });
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
  const before = { status: sheetPhoto.status, ids: [...sheetPhoto.dog_ids], conf: sheetPhoto.confidence };
  await sb.from("photos").update({ dog_ids: ids, status: "done", confidence: "manual" }).eq("id", sheetPhoto.id);
  learnFrom(sheetPhoto, ids, before);
  // AI가 잘못 넣었던 아이 → 실수로 기억하고 두 아이 구분 포인트를 스스로 다시 정리
  // 직원이 손으로 고친 부분은 매번 학습: 잘못 넣은 아이(A→B 정정)와 AI가 못 알아본 아이(직접 추가) 모두
  {
    const wrong = before.ids.filter((id) => !ids.includes(id) && !dogById(id)?.auto);
    const added = ids.filter((id) => !before.ids.includes(id) && !dogById(id)?.auto);
    if (wrong.length) wrong.forEach((w, i) => learnMistake(sheetPhoto.id, w, added.length === 1 ? added[0] : (added[i] || null)));
    added.filter((a, i) => !(wrong.length && (added.length === 1 || i < wrong.length))).forEach((a) => learnMistake(sheetPhoto.id, null, a));
  }
  sheetPhoto.confidence = "manual";
  // 명단에 없던 아이를 직접 골랐으면 오늘 명단에 넣어서 AI도 그 아이를 후보로 보게 함
  const extra = ids.filter((id) => !state.attendance.has(id));
  if (extra.length && state.attendance.size) {
    await sb.from("assignments").insert(extra.map((dog_id) => ({ day: state.day, dog_id })));
    extra.forEach((id) => state.attendance.add(id));
  }
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
  await sb.from("dog_refs").insert({ dog_id: dog.id, path: refPath });
  const ids = [...new Set([...$$("#sheet-chips button.on").map((b) => b.dataset.dog), dog.id])];
  await sb.from("photos").update({ dog_ids: ids, status: "done", confidence: "manual" }).eq("id", p.id);
  closeSheet();
  toast(`${dog.name} 그룹을 만들었어요`);
  if (!dog.auto) await addToToday(dog.id);
  queueRescan();
  render();
});

// 잘못 들어간 사진: 지우지 않고 이 강아지에서만 빼서 '분류 안 된 사진'으로 돌려보냄
$("#sheet-out").addEventListener("click", async () => {
  const p = sheetPhoto, dogId = sheetKey;
  const rest = p.dog_ids.filter((d) => d !== dogId);
  const status = rest.length ? "done" : "review";
  const wasAi = p.confidence !== "manual";
  const { error } = await sb.from("photos").update({ dog_ids: rest, status, confidence: "manual" }).eq("id", p.id);
  if (error) { toast("옮기지 못했어요"); return; }
  if (wasAi && !dogById(dogId)?.auto) learnMistake(p.id, dogId, null);
  p.confidence = "manual";
  Object.assign(p, { dog_ids: rest, status });
  toast(rest.length ? `${dogById(dogId)?.name}에서 뺐어요` : "분류 안 된 사진으로 옮겼어요");
  const i = sheetList.indexOf(p.id);
  sheetList = sheetList.filter((id) => id !== p.id);
  if (sheetList.length) openSheet(sheetList[Math.min(i, sheetList.length - 1)]); else closeSheet();
  renderPhotos();
});

$("#sheet-del").addEventListener("click", async () => {
  if (!confirm("이 사진을 완전히 삭제할까요? 되돌릴 수 없어요.\n(잘못 분류된 거라면 다른 강아지를 골라 '분류 저장'을 누르세요)")) return;
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
// 회전값만큼 실제로 돌린 JPEG 만들기 (저장·크게 보기용)
async function rotated(blob, deg) {
  if (!deg) return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  const side = deg === 90 || deg === 270;
  c.width = side ? bmp.height : bmp.width;
  c.height = side ? bmp.width : bmp.height;
  const g = c.getContext("2d");
  g.translate(c.width / 2, c.height / 2);
  g.rotate((deg * Math.PI) / 180);
  g.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  bmp.close?.();
  return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
}

// 파일 이름은 사진마다 고정(찍은 시각 + 사진 id) → 다시 받아도 같은 사진이 두 번 생기지 않음
function photoFileName(dog, p) {
  const tm = new Date(p.taken_at || p.created_at);
  const t = isNaN(tm) ? "" : `${String(tm.getHours()).padStart(2, "0")}${String(tm.getMinutes()).padStart(2, "0")}${String(tm.getSeconds()).padStart(2, "0")}_`;
  return `${safeName(dog.name)}_${state.day}_${t}${p.id.slice(0, 6)}.jpg`;
}
async function photoFiles(dog, photos, onEach, skip = new Set()) {
  const out = [];
  const sorted = [...photos].sort((a, b) => String(a.taken_at || a.created_at).localeCompare(String(b.taken_at || b.created_at)))
    .filter((p) => !skip.has(photoFileName(dog, p)));
  await pool(sorted, 4, async (p, i) => {
    const { data } = await sb.storage.from("photos").download(p.path);
    out[i] = new File([await rotated(data, p.rotation || 0)], photoFileName(dog, p), { type: "image/jpeg" });
    onEach?.();
  });
  return out.filter(Boolean);
}
// 폴더 맞추기: 이미 받은 사진은 건너뛰고 새 사진만 받아서 넣음.
// 이 아이에게서 빠진 사진(다른 아이로 옮겨짐 등)의 파일만 정리
async function syncFolder(dir, dog, photos, onEach) {
  const want = new Set(photos.map((p) => photoFileName(dog, p)));
  const have = new Set();
  let removed = 0;
  const mine = `${safeName(dog.name)}_${state.day}_`;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== "file") continue;
    if (want.has(name)) have.add(name);
    else if (name.startsWith(mine) && /\.jpe?g$/i.test(name)) { try { await dir.removeEntry(name); removed++; } catch { /* 무시 */ } }
  }
  photos.filter((p) => have.has(photoFileName(dog, p))).forEach(() => onEach?.(true));
  const files = await photoFiles(dog, photos, () => onEach?.(false), have);
  for (const f of files) {
    const fh = await dir.getFileHandle(f.name, { create: true });
    const w = await fh.createWritable();
    await w.write(f);
    await w.close();
  }
  return { added: files.length, kept: have.size, removed };
}
async function writeToFolder(dir, files) {
  for (const f of files) {
    const fh = await dir.getFileHandle(f.name, { create: true });
    const w = await fh.createWritable();
    await w.write(f);
    await w.close();
  }
}
function doneBanner(msg) {
  progress("✅ 다운로드 완료", 1, 1, msg);
  toast(msg);
  setTimeout(() => $("#progress").classList.add("hidden"), 10000);
}

async function saveDogPhotos(dog, photos, btn, mode) {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    let root = null;
    if (mode === "folder") {
      root = await (await saveFolder()).getDirectoryHandle(state.day, { create: true });
      const dir = await root.getDirectoryHandle(safeName(dog.name), { create: true });
      let n = 0;
      const r = await syncFolder(dir, dog, photos, () => { btn.textContent = `${++n}/${photos.length}`; });
      doneBanner(`'${state.day}/${dog.name}' 폴더 · 새로 받은 사진 ${r.added}장${r.kept ? ` (이미 받은 ${r.kept}장은 건너뜀)` : ""}`);
      btn.disabled = false;
      btn.textContent = label;
      return;
    }
    let n = 0;
    const files = await photoFiles(dog, photos, () => { btn.textContent = `${++n}/${photos.length}`; });
    if (mode === "share") {
      await navigator.share({ files, title: `${dog.name} ${state.day}` });
    } else {
      const zip = new JSZip();
      files.forEach((f) => zip.file(f.name, f));
      downloadBlob(await zip.generateAsync({ type: "blob" }), `${safeName(dog.name)}_${state.day}.zip`);
      doneBanner(`${dog.name} ${files.length}장 ZIP 다운로드 완료`);
    }
  } catch (err) {
    if (err?.name !== "AbortError") toast("저장하지 못했어요. 다시 시도해 주세요.");
  }
  btn.disabled = false;
  btn.textContent = label;
}

// 이 날짜 전체를 강아지별 폴더로
// 저장 폴더(보통 '다운로드')를 한 번 고르면 기억해 두고 다음부터 바로 저장
function idb(op, val) {
  return new Promise((res) => {
    try {
      const r = indexedDB.open("ddgog", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => {
        const tx = r.result.transaction("kv", op === "get" ? "readonly" : "readwrite");
        const st = tx.objectStore("kv");
        const q = op === "get" ? st.get("saveDir") : st.put(val, "saveDir");
        q.onsuccess = () => res(q.result);
        q.onerror = () => res(null);
      };
      r.onerror = () => res(null);
    } catch { res(null); }
  });
}
async function saveFolder() {
  const saved = await idb("get");
  if (saved) {
    try {
      const ok = (await saved.queryPermission({ mode: "readwrite" })) === "granted" ||
        (await saved.requestPermission({ mode: "readwrite" })) === "granted";
      if (ok) return saved;
    } catch { /* 다시 고르기 */ }
  }
  toast("저장할 폴더를 골라 주세요 (보통 '다운로드'). 한 번 고르면 다음부터는 바로 저장돼요");
  const picked = await window.showDirectoryPicker({ mode: "readwrite", id: "ddgog", startIn: "downloads" });
  await idb("put", picked);
  return picked;
}

async function saveAll(btn) {
  const groups = new Map();
  state.photos.filter((p) => p.status === "done").forEach((p) => p.dog_ids.forEach((d) => {
    const dog = dogById(d);
    if (!dog) return;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(p);
  }));
  for (const [id, list] of groups) {
    const { shown, extra } = splitSimilar(list);
    groups.set(id, state.expanded.has(id) ? [...shown, ...extra] : shown);
  }
  const label = btn.textContent;
  btn.disabled = true;
  try {
    let root = null;
    if (CAN_FOLDER) {
      const picked = await saveFolder();
      root = await picked.getDirectoryHandle(state.day, { create: true });
      window.__saveDirName = picked.name;
    }
    const zip = CAN_FOLDER ? null : new JSZip();
    const total = [...groups.values()].reduce((a, g) => a + g.length, 0);
    let n = 0, added = 0, kept = 0;
    const tick = () => { n++; btn.textContent = `저장 중 ${n}/${total}`; progress("📥 다운로드 중… 창을 닫지 마세요", n, total, `새로 받는 사진 ${added}장 · 이미 받은 사진 ${kept}장 건너뜀`); };
    progress("📥 다운로드 중… 창을 닫지 마세요", 0, total);
    for (const [id, photos] of groups) {
      const dog = dogById(id);
      if (root) {
        const r = await syncFolder(await root.getDirectoryHandle(safeName(dog.name), { create: true }), dog, photos,
          (skipped) => { skipped ? kept++ : added++; tick(); });
      } else {
        const files = await photoFiles(dog, photos, () => { added++; tick(); });
        files.forEach((f) => zip.file(`${state.day}/${safeName(dog.name)}/${f.name}`, f));
      }
    }
    if (zip) {
      downloadBlob(await zip.generateAsync({ type: "blob" }), `${state.day}.zip`);
      doneBanner(`${state.day}.zip · 강아지 ${groups.size}마리, ${total}장`);
    } else {
      doneBanner(`'${window.__saveDirName || "다운로드"}/${state.day}' 폴더 · 강아지 ${groups.size}마리 · 새로 받은 사진 ${added}장${kept ? ` (이미 받은 ${kept}장은 건너뜀)` : ""}`);
    }
  } catch (err) {
    if (err?.name !== "AbortError") toast("저장하지 못했어요. 다시 시도해 주세요.");
  }
  btn.disabled = false;
  btn.textContent = label;
}

/* ================= 관리 ================= */
/* ---------- 왼쪽 명단 (항상 보임) ---------- */
// 오늘 명단에서 빼기: 이 아이로 들어간 사진은 지우지 않고 '분류 안 된 사진'으로 돌린 뒤 다시 분류
async function removeFromToday(dog) {
  if (!dog) return;
  const mine = state.photos.filter((p) => p.dog_ids.includes(dog.id));
  if (!confirm(`'${dog.name}'을(를) 오늘 명단에서 뺄까요?${mine.length ? `\n이 아이로 분류된 사진 ${mine.length}장은 다른 아이로 다시 분류할게요.` : ""}`)) return;
  await sb.from("assignments").delete().eq("day", state.day).eq("dog_id", dog.id);
  state.attendance.delete(dog.id);
  state.hotel.delete(dog.id);
  for (const p of mine) {
    const rest = p.dog_ids.filter((d) => d !== dog.id);
    const status = rest.length ? "done" : "pending";
    await sb.from("photos").update({ dog_ids: rest, status }).eq("id", p.id);
    Object.assign(p, { dog_ids: rest, status });
  }
  toast(`${dog.name}을(를) 오늘 명단에서 뺐어요`);
  await render();
  if (mine.length) classifyPending();
}
// 오늘 명단에 이름 추가 (명단에 없으면 새로 등록, 호텔링이면 H)
async function addNameToToday(name, hotel) {
  if (!name) return;
  let m = matchDog(name, null);
  let dog = m.dog;
  if (!dog && m.choices) {
    const v = prompt(`'${name}' 이름의 아이가 여럿이에요. 번호를 골라 주세요\n` + m.choices.map((c, i) => `${i + 1}. ${c.name}`).join("\n"), "1");
    if (v === null) return;
    dog = m.choices[+v - 1];
  }
  if (!dog) {
    const { data, error } = await sb.from("dogs").insert({ name, auto: false, active: true }).select().single();
    if (error) { toast("추가하지 못했어요"); return; }
    dog = data;
    state.dogs.push(dog);
  }
  if (!state.attendance.has(dog.id)) {
    await sb.from("assignments").insert({ day: state.day, dog_id: dog.id, hotel });
    state.attendance.add(dog.id);
  } else if (hotel) {
    await sb.from("assignments").update({ hotel: true }).eq("day", state.day).eq("dog_id", dog.id);
  }
  if (hotel) state.hotel.add(dog.id);
  toast(`${dog.name}${hotel ? "(호텔링)" : ""}을(를) 오늘 명단에 넣었어요`);
  queueRescan();
  await render();
}

// 왼쪽 명단 장수: 늘어난 아이는 숫자가 톡 튀고 +N 표시
const sideCounts = new Map();
let sideCountsDay = null;
async function renderSide() {
  const layout = document.querySelector(".layout");
  const ref = await signed("refs", state.dogs.map((d) => d.ref_path));

  // ---- 사진 탭: 오늘 온 아이들 + 분류된 사진 장수
  if (state.tab === "photos") {
    const today = state.dogs.filter((d) => state.attendance.has(d.id)).sort(dogOrder);
    layout?.classList.toggle("with-side", today.length > 0);
    if (!today.length) return;
    const count = new Map();
    const per = new Map();
    let done = 0, unsorted = 0, pending = 0;
    state.photos.forEach((p) => {
      if (p.status === "done") { done++; p.dog_ids.forEach((d) => { if (!per.has(d)) per.set(d, []); per.get(d).push(p); }); }
      else if (p.status === "pending") pending++;
      else unsorted++;
    });
    for (const [d, list] of per) count.set(d, splitSimilar(list).shown.length); // 비슷한 사진 정리 후 장수
    const zero = today.filter((d) => !count.get(d.id)).length;
    // 명단 밖인데 사진이 분류된 아이 (자동 그룹 등)
    const extra = [...count.keys()].filter((id) => !state.attendance.has(id) && dogById(id)).map(dogById).sort(dogOrder);

    $("#side-head-label").innerHTML = `📋 오늘 <b id="side-count">${today.length}</b>마리`;
    $("#side-sub").textContent = state.photos.length
      ? `분류 완료 ${done}장${unsorted ? ` · 분류 안 됨 ${unsorted}` : ""}${pending ? ` · 대기 ${pending}` : ""}${zero && done ? ` · 사진 없는 아이 ${zero}` : ""}`
      : "아직 올린 사진이 없어요";
    const row = (d) => {
      const n = count.get(d.id) || 0;
      const inToday = state.attendance.has(d.id);
      const prev = sideCounts.get(d.id);
      const up = prev !== undefined && n > prev ? n - prev : 0;
      return `<div class="side-item"><button class="side-row ${n ? "" : "zero"}" data-side="${d.id}" title="${esc(d.name)}">
        ${d.ref_path ? `<img src="${ref(d.ref_path)}" alt="">` : `<span class="noimg">?</span>`}
        <span class="nm">${state.hotel.has(d.id) ? `<b class="tag-h">H</b>` : ""}${esc(d.name)}</span>
        <b class="cnt ${up ? "bump" : ""}">${n}<small>장</small>${up ? `<i class="plus">+${up}</i>` : ""}</b>
      </button>${inToday ? `<button class="side-x" data-unroll="${d.id}" title="오늘 명단에서 빼기">×</button>` : ""}</div>`;
    };
    const keyDay = state.day;
    if (sideCountsDay !== keyDay) { sideCounts.clear(); sideCountsDay = keyDay; }
    const html = today.map(row).join("") +
      (extra.length ? `<p class="side-sec">명단 밖 ${extra.length}</p>` + extra.map(row).join("") : "") +
      `<form id="side-add" class="side-add"><input id="side-add-name" placeholder="이름 추가 (호텔링은 H 이름)"><button class="btn ghost sm">추가</button></form>`;
    $("#side-list").innerHTML = html;
    [...today, ...extra].forEach((d) => sideCounts.set(d.id, count.get(d.id) || 0));
    $$("[data-unroll]", $("#side-list")).forEach((b) => b.addEventListener("click", () => removeFromToday(dogById(b.dataset.unroll))));
    $("#side-add").addEventListener("submit", async (e) => {
      e.preventDefault();
      const raw = $("#side-add-name").value.trim();
      if (!raw) return;
      const hotel = /^\s*[Hh]\s+|\(\s*[Hh]\s*\)\s*$|\s+[Hh]\s*$/.test(raw);
      const name = raw.replace(/^\s*[Hh]\s+|\s*\(\s*[Hh]\s*\)\s*$|\s+[Hh]\s*$/g, "").trim();
      await addNameToToday(name, hotel);
    });
    $$("[data-side]", $("#side-list")).forEach((b) => b.addEventListener("click", () => {
      const g = document.querySelector(`[data-list="${b.dataset.side}"]`);
      if (g) {
        g.scrollIntoView({ behavior: "smooth", block: "start" });
        g.classList.add("flash");
        setTimeout(() => g.classList.remove("flash"), 1200);
      } else toast("아직 이 아이로 분류된 사진이 없어요");
      if (matchMedia("(max-width: 899px)").matches) $("#side").classList.remove("open");
    }));
    return;
  }

  // ---- 명단 탭: 등록된 전체 명단
  layout?.classList.toggle("with-side", state.tab === "roster");
  if (state.tab !== "roster") return;
  const named = state.dogs.filter((d) => !d.auto);
  const autos = state.dogs.filter((d) => d.auto && d.active);
  const refs = named.reduce((a, d) => a + refCount(d), 0);
  $("#side-head-label").innerHTML = `🐾 명단 <b id="side-count">${named.length}</b>마리`;
  $("#side-sub").textContent = `대표 사진 ${refs}장${state.attendance.size ? ` · 오늘 ${state.attendance.size}마리` : ""}`;
  const row = (d) => `<button class="side-row ${d.active ? "" : "off"}" data-side="${d.id}" title="${esc(d.name)}">
      ${d.ref_path ? `<img src="${ref(d.ref_path)}" alt="">` : `<span class="noimg">?</span>`}
      <span class="nm">${esc(d.name)}</span>
      ${state.attendance.has(d.id) ? `<i class="dot" title="오늘 출석"></i>` : ""}
      <small>${refCount(d)}</small>
    </button>`;
  $("#side-list").innerHTML =
    (named.length ? named.map(row).join("") : `<p class="muted small side-empty">아직 등록된 강아지가 없어요</p>`) +
    (autos.length ? `<p class="side-sec">이름 없는 그룹 ${autos.length}</p>` + autos.map(row).join("") : "");
  $$("[data-side]", $("#side-list")).forEach((b) => b.addEventListener("click", () => {
    const card = document.querySelector(`.dog-card[data-id="${b.dataset.side}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    card?.classList.add("flash");
    setTimeout(() => card?.classList.remove("flash"), 1200);
    if (matchMedia("(max-width: 899px)").matches) $("#side").classList.remove("open");
  }));
}
$("#side-toggle").addEventListener("click", () => $("#side").classList.toggle("open"));

// 잘못 학습된 내용 정정: AI 구분 포인트·부위별 특징 고치기, 실수 기록 지우기, 학습 초기화
async function openFix(dog, box) {
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  box.innerHTML = `<p class="muted small">불러오는 중…</p>`;
  const { data: les } = await sb.from("lessons").select("id, wrong_dog, right_dog, path, note, created_at")
    .or(`wrong_dog.eq.${dog.id},right_dog.eq.${dog.id}`).order("created_at", { ascending: false }).limit(60);
  const url = await signed("refs", (les || []).map((l) => l.path));
  const nm = (id) => (id ? dogById(id)?.name || "(다른 아이)" : "모름");
  const learnedRefs = (dog.dog_refs || []).filter((r) => r.path.includes("-learn-"));
  box.innerHTML = `
    <label class="fix-l">🔍 AI가 정리한 구분 포인트 <small class="muted">(틀린 내용은 고치거나 지우세요)</small></label>
    <textarea data-f="tips_ai" rows="2">${esc(dog.tips_ai || "")}</textarea>
    <label class="fix-l">🐾 부위별 특징</label>
    <textarea data-f="features" rows="6">${esc(dog.features || "")}</textarea>
    <div class="row"><button class="btn primary mini" data-fix-save>저장</button></div>
    <label class="fix-l">📝 실수 기록 ${les?.length || 0}개 <small class="muted">AI가 "이 사진은 A가 아니라 B"로 기억한 것. 기록 자체가 틀렸으면 ×로 지우세요</small></label>
    <div class="lesson-list">${(les || []).map((l) => `<div class="lesson"><img src="${url(l.path)}" alt="">
      <span><b>${esc(nm(l.wrong_dog))}</b> 아님 → <b>${esc(nm(l.right_dog))}</b>${l.note ? `<br><small>${esc(l.note)}</small>` : ""}</span>
      <b class="x" data-del-lesson="${l.id}" title="이 기록 지우기">×</b></div>`).join("") || `<span class="muted small">없음</span>`}</div>
    <p class="small" style="margin-top:8px">분류하면서 배운 사진 ${learnedRefs.length}장은 위 대표 사진 줄에 <i class="lb">학습</i>으로 표시돼 있어요. 다른 아이 사진이면 ×로 빼 주세요.</p>
    <button class="btn ghost mini danger" data-fix-reset>이 아이 학습 초기화</button>
    <small class="muted"> (배운 사진·실수 기록·AI 구분 포인트를 지우고, 다이얼독 대표 사진과 직원이 쓴 구분 포인트만 남김)</small>`;
  $("[data-fix-save]", box).addEventListener("click", async () => {
    const upd = {};
    $$("textarea[data-f]", box).forEach((t) => { upd[t.dataset.f] = t.value.trim() || null; });
    const { error } = await sb.from("dogs").update(upd).eq("id", dog.id);
    if (error) { toast("저장하지 못했어요"); return; }
    Object.assign(dog, upd);
    toast("고쳤어요. 다음 분류부터 반영돼요");
  });
  $$("[data-del-lesson]", box).forEach((x) => x.addEventListener("click", async () => {
    const l = les.find((y) => y.id === x.dataset.delLesson);
    await sb.from("lessons").delete().eq("id", l.id);
    await sb.storage.from("refs").remove([l.path]);
    x.closest(".lesson").remove();
    toast("실수 기록을 지웠어요");
  }));
  $("[data-fix-reset]", box).addEventListener("click", async () => {
    if (!confirm(`${dog.name}의 학습 내용(배운 사진 ${learnedRefs.length}장, 실수 기록 ${les?.length || 0}개, AI 구분 포인트)을 지울까요?`)) return;
    for (const r of learnedRefs) await removeRef(dog, r);
    if (les?.length) {
      await sb.from("lessons").delete().in("id", les.map((l) => l.id));
      await sb.storage.from("refs").remove(les.map((l) => l.path));
    }
    await sb.from("dogs").update({ tips_ai: null }).eq("id", dog.id);
    dog.tips_ai = null;
    toast(`${dog.name} 학습을 초기화했어요`);
    renderRoster();
  });
}

async function renderRoster() {
  renderSide();
  const q = norm($("#roster-search").value);
  const named = state.dogs.filter((d) => !d.auto && (!q || norm(d.name).includes(q)));
  const autos = state.dogs.filter((d) => d.auto && d.active && !q);
  const paths = state.dogs.flatMap((d) => (d.dog_refs || []).map((r) => r.path).concat(d.ref_path || []));
  const ref = await signed("refs", paths);

  const card = (d) => {
    const refs = d.dog_refs?.length ? d.dog_refs : (d.ref_path ? [{ id: "", path: d.ref_path }] : []);
    const today = state.attendance.has(d.id);
    return `<div class="dog-card ${d.active ? "" : "off"} ${d.auto ? "auto" : ""}" data-id="${d.id}">
      <div class="dog-card-head">
        ${d.ref_path ? `<img class="avatar" src="${ref(d.ref_path)}" alt="">` : `<span class="avatar"></span>`}
        <div class="grow">
          <b class="nm">${esc(d.name)}</b>
          ${d.auto ? `<span class="tag">이름 필요</span>` : ""}
          ${today ? `<span class="tag today">오늘 출석</span>` : ""}
          ${!d.active ? `<span class="tag off">숨김</span>` : ""}
          <small>${esc(d.note || "")}</small>
          ${d.tips || d.tips_ai ? `<div class="tips">🔍 <b>구분</b> ${esc(d.tips || "")}${d.tips && d.tips_ai ? "<br>" : ""}${d.tips_ai ? `<span class="tips-ai">${esc(d.tips_ai)} <i>(AI)</i></span>` : ""}</div>` : ""}
          ${d.features ? `<details class="feat"><summary>🐾 부위별 특징 (AI 학습)</summary><div>${esc(d.features).replace(/\n/g, "<br>")}</div></details>` : ""}
        </div>
        <div class="row-actions">
          <button class="btn ${d.auto ? "primary" : "ghost"} mini" data-edit>${d.auto ? "이름" : "수정"}</button>
          ${d.auto ? "" : `<button class="btn ghost mini" data-fix>학습 정정</button>`}
          <button class="btn ghost mini" data-merge>합치기</button>
          <button class="btn ghost mini" data-toggle>${d.active ? "숨기기" : "표시"}</button>
        </div>
      </div>
      <div class="ref-strip">
        ${refs.map((r) => `<span class="ref-thumb ${r.path.includes("-learn-") ? "learned" : ""}"><img src="${ref(r.path)}" alt="">${r.path.includes("-learn-") ? `<i class="lb">학습</i>` : ""}${r.id ? `<b class="x" data-del-ref="${r.id}" title="이 아이가 아니면 빼기">×</b>` : ""}</span>`).join("")}
        <button class="ref-add" data-add-ref>＋<small>사진</small></button>
      </div>
      <p class="ref-hint ${refs.length >= 3 ? "ok" : ""}">대표 사진 ${refs.length}장${refs.length < 3 ? " · 여러 각도로 많이 올릴수록 정확해요" : refs.length > 10 ? " ✓ (AI는 매번 이 중 최대 10장을 골고루 골라 참고해요)" : " ✓ 더 올려도 돼요"}</p>
      <div class="fix-box hidden"></div>
      <div class="merge-box hidden">
        <span class="small">이 강아지를</span>
        <select>${state.dogs.filter((o) => o.id !== d.id).map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}</select>
        <span class="small">(으)로</span>
        <button class="btn primary mini" data-merge-go>합치기</button>
        <button class="btn ghost mini" data-merge-cancel>취소</button>
      </div>
    </div>`;
  };

  // 명단 현황 (검색과 상관없이 전체 기준)
  const allNamed = state.dogs.filter((d) => !d.auto);
  const totalRefs = allNamed.reduce((a, d) => a + refCount(d), 0);
  const noPhoto = allNamed.filter((d) => !refCount(d)).length;
  const fewPhoto = allNamed.filter((d) => refCount(d) > 0 && refCount(d) < 3).length;
  const autoCount = state.dogs.filter((d) => d.auto && d.active).length;
  $("#roster-stats").innerHTML = `
    <div class="stat"><b>${allNamed.length}</b><span>등록된 강아지</span></div>
    <div class="stat"><b>${totalRefs}</b><span>대표 사진</span></div>
    <div class="stat ${noPhoto ? "warn" : ""}"><b>${noPhoto}</b><span>사진 없음</span></div>
    <div class="stat ${autoCount ? "warn" : ""}"><b>${autoCount}</b><span>이름 없는 그룹</span></div>
    ${fewPhoto ? `<p class="stats-note">사진이 3장 미만인 아이가 ${fewPhoto}마리 있어요. 더 올리면 정확해져요.</p>` : ""}`;

  $("#roster-list").innerHTML = named.length
    ? `<h3 class="sec">명단 ${named.length}마리</h3>` + named.map(card).join("")
    : `<div class="empty">${q ? "찾는 이름이 없어요." : "아직 명단이 없어요. 위에서 등록하거나, 사진 탭에서 출석 보드를 올려 보세요."}</div>`;
  $("#roster-auto").innerHTML = autos.length
    ? `<h3 class="sec">이름 없는 그룹 ${autos.length}개 <small class="muted">AI가 만든 그룹이에요. 이름을 붙이면 명단에 들어가요 (같은 이름이 있으면 합쳐져요)</small></h3>` + autos.map(card).join("")
    : "";

  $$(".dog-card").forEach((row) => {
    const dog = dogById(row.dataset.id);
    $("[data-add-ref]", row).addEventListener("click", () => { refTarget = dog.id; $("#roster-file").click(); });
    $$("[data-del-ref]", row).forEach((x) => x.addEventListener("click", async () => {
      const r = dog.dog_refs.find((y) => y.id === x.dataset.delRef);
      const v = prompt(`${dog.name}에서 이 사진을 뺄게요.\n다른 아이 사진이면 그 아이 이름을 써 주세요 (그 아이 대표 사진으로 옮겨요).\n그냥 빼려면 비워 두고 확인`, "");
      if (v === null) return;
      if (v.trim()) {
        const m = matchDog(v.trim(), null);
        const to = m.dog || (m.choices && m.choices[(+prompt(m.choices.map((c, i) => `${i + 1}. ${c.name}`).join("\n"), "1") || 1) - 1]);
        if (!to) { toast("그 이름을 명단에서 찾지 못했어요"); return; }
        await sb.from("dog_refs").update({ dog_id: to.id }).eq("id", r.id);
        dog.dog_refs = dog.dog_refs.filter((y) => y.id !== r.id);
        to.dog_refs = [...(to.dog_refs || []), r];
        if (dog.ref_path === r.path) {
          const next = dog.dog_refs[0]?.path || null;
          await sb.from("dogs").update({ ref_path: next }).eq("id", dog.id);
          dog.ref_path = next;
        }
        if (!to.ref_path) { await sb.from("dogs").update({ ref_path: r.path }).eq("id", to.id); to.ref_path = r.path; }
        toast(`${to.name}(으)로 옮겼어요`);
      } else {
        await removeRef(dog, r);
      }
      renderRoster();
    }));
    $("[data-edit]", row).addEventListener("click", async () => {
      if (dog.auto) { if (await renameDog(dog)) renderRoster(); return; }
      const name = prompt("이름", dog.name);
      if (name === null) return;
      const note = prompt("특징 (견종·털색·무늬)", dog.note || "");
      if (note === null) return;
      const tips = prompt("구분 포인트 (닮은 아이와 다른 점: 꼬리 길이, 얼굴 점, 귀 색 등)", dog.tips || "");
      if (tips === null) return;
      await sb.from("dogs").update({ name: name.trim() || dog.name, note: note.trim(), tips: tips.trim() || null }).eq("id", dog.id);
      Object.assign(dog, { name: name.trim() || dog.name, note: note.trim(), tips: tips.trim() || null });
      state.dogs.sort(dogOrder);
      renderRoster();
    });
    $("[data-fix]", row)?.addEventListener("click", () => openFix(dog, $(".fix-box", row)));
    $("[data-toggle]", row).addEventListener("click", async () => {
      await sb.from("dogs").update({ active: !dog.active }).eq("id", dog.id);
      dog.active = !dog.active;
      renderRoster();
    });
    const box = $(".merge-box", row);
    $("[data-merge]", row).addEventListener("click", () => box.classList.toggle("hidden"));
    $("[data-merge-cancel]", row).addEventListener("click", () => box.classList.add("hidden"));
    $("[data-merge-go]", row).addEventListener("click", async () => {
      const target = dogById($("select", box).value);
      if (!target || !confirm(`'${dog.name}'의 사진과 대표 사진을 모두 '${target.name}'(으)로 옮기고 '${dog.name}'은(는) 지울까요?`)) return;
      const { error } = await sb.rpc("merge_dogs", { src: dog.id, dst: target.id });
      if (error) { toast("합치지 못했어요. 다시 시도해 주세요."); return; }
      toast(`'${target.name}'(으)로 합쳤어요`);
      await Promise.all([loadDogs(), loadAttendance()]);
      renderRoster();
    });
  });
}
$("#roster-search").addEventListener("input", () => renderRoster());
$("#roster-file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  const dog = dogById(refTarget);
  refTarget = null;
  if (!files.length || !dog) return;
  toast(`${dog.name} 사진 올리는 중…`);
  const n = await addRefs(dog, files);
  toast(n ? `${dog.name} 대표 사진 ${n}장 추가` : "올리지 못했어요");
  renderRoster();
});

// ---------- 지난 알림장 사진으로 한꺼번에 등록 ----------
// 폴더 구조: 상위폴더/강아지이름/사진들  (상위폴더 없이 바로 강아지 폴더 하나를 골라도 됨)
let importPlan = null; // [{ name, files, existing }]
const IMG_RE = /\.(jpe?g|png|heic|heif|webp|gif|bmp)$/i;

$("#import-dir").addEventListener("change", (e) => {
  const files = [...e.target.files].filter((f) => IMG_RE.test(f.name) || (f.type || "").startsWith("image/"));
  e.target.value = "";
  if (!files.length) { toast("사진을 찾지 못했어요"); return; }
  const groups = new Map();
  for (const f of files) {
    const parts = (f.webkitRelativePath || f.name).split("/").filter(Boolean);
    // 사진 바로 위 폴더 이름 = 강아지 이름
    const name = (parts.length >= 2 ? parts[parts.length - 2] : "").trim();
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(f);
  }
  importPlan = [...groups].map(([name, fs]) => ({
    name,
    files: fs.sort((a, b) => a.name.localeCompare(b.name)),
    existing: state.dogs.find((d) => !d.auto && norm(d.name) === norm(name)) || null,
    on: true,
  })).sort((a, b) => a.name.localeCompare(b.name, "ko"));
  renderImport();
});

function renderImport(statusMap = null) {
  const box = $("#import-body");
  if (!importPlan) { box.innerHTML = ""; return; }
  const on = importPlan.filter((x) => x.on);
  box.innerHTML = `
    <p class="small" style="margin-top:12px"><b>${importPlan.length}마리</b>, 사진 ${importPlan.reduce((a, x) => a + x.files.length, 0)}장을 찾았어요.
      이름이 틀렸으면 눌러서 고치고, 빼고 싶은 아이는 체크를 풀어 주세요.</p>
    <div class="import-list">${importPlan.map((x, i) => {
      const st = statusMap?.get(i);
      return `<label class="import-row ${x.on ? "" : "off"}">
        <input type="checkbox" data-on="${i}" ${x.on ? "checked" : ""} ${statusMap ? "disabled" : ""}>
        <b class="grow" data-rn="${i}">${esc(x.name)}</b>
        ${x.existing ? `<span class="tag today">명단에 있음 · 사진 추가</span>` : `<span class="tag-new">새로 등록</span>`}
        <small class="muted">${x.files.length}장</small>
        ${st ? `<span class="imp-st ${st.cls || ""}">${st.text}</span>` : ""}
      </label>`;
    }).join("")}</div>
    <div class="row" style="margin-top:10px">
      <span class="small">아이당 대표 사진</span>
      <select id="import-max" ${statusMap ? "disabled" : ""}>${[6, 8, 10, 12, 15, 20].map((n) => `<option ${n === 12 ? "selected" : ""}>${n}</option>`).join("")}</select>
      <span class="small">장까지</span>
    </div>
    ${statusMap ? "" : `<div class="row" style="margin-top:10px">
      <button id="import-go" class="btn primary grow" ${on.length ? "" : "disabled"}>${on.length}마리 등록 시작</button>
      <button id="import-cancel" class="btn ghost">취소</button></div>
      <p class="muted small">한 마리에 10~20초 정도 걸려요. 진행 중에는 창을 닫지 마세요.</p>`}`;
  if (statusMap) return;
  $$("[data-on]", box).forEach((c) => c.addEventListener("change", () => { importPlan[+c.dataset.on].on = c.checked; renderImport(); }));
  $$("[data-rn]", box).forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault();
    const x = importPlan[+b.dataset.rn];
    const v = prompt("강아지 이름", x.name);
    if (!v || !v.trim()) return;
    x.name = v.trim();
    x.existing = state.dogs.find((d) => !d.auto && norm(d.name) === norm(x.name)) || null;
    renderImport();
  }));
  $("#import-cancel").addEventListener("click", () => { importPlan = null; renderImport(); });
  $("#import-go").addEventListener("click", runImport);
}

async function runImport() {
  const max = +$("#import-max").value || 12;
  const status = new Map();
  const set = (i, text, cls = "") => { status.set(i, { text, cls }); renderImport(status); };
  state.busy = true;
  let made = 0, added = 0, failed = 0;
  for (let i = 0; i < importPlan.length; i++) {
    const x = importPlan[i];
    if (!x.on) continue;
    try {
      set(i, "사진 준비 중…");
      // 너무 많으면 고르게 40장만 후보로
      const pool40 = x.files.length <= 40 ? x.files
        : Array.from({ length: 40 }, (_, k) => x.files[Math.floor((k * x.files.length) / 40)]);
      const blobs = [];
      for (const f of pool40) { try { blobs.push(await resize(f, 512, 0.82)); } catch { /* 못 여는 사진 건너뜀 */ } }
      if (!blobs.length) throw new Error("열 수 있는 사진이 없어요");
      const images = await Promise.all(blobs.map(blobToBase64));

      set(i, "AI가 고르는 중…");
      let res = null;
      for (let t = 0; t < 4 && !res; t++) {
        const { data, error } = await sb.functions.invoke("pick-refs", { body: { name: x.name, images, max } });
        if (!error) res = data;
        else if ([503, 429].includes(error.context?.status)) await sleep(3000 * 2 ** t);
        else throw new Error("AI 오류");
      }
      if (!res) throw new Error("AI가 바빠요");
      if (!res.picks.length) { set(i, "쓸 만한 사진 없음", "warn"); failed++; continue; }

      let dog = x.existing;
      if (!dog) {
        const { data, error } = await sb.from("dogs")
          .insert({ name: x.name, note: res.note || null, auto: false, active: true }).select().single();
        if (error) throw error;
        dog = data;
        dog.dog_refs = [];
        state.dogs.push(dog);
        made++;
      } else if (!dog.note && res.note) {
        await sb.from("dogs").update({ note: res.note }).eq("id", dog.id);
        dog.note = res.note;
      }
      set(i, `대표 사진 저장 중 0/${res.picks.length}`);
      const chosen = res.picks.map((k) => new File([blobs[k]], `ref${k}.jpg`, { type: "image/jpeg" }));
      const n = await addRefs(dog, chosen, (k) => set(i, `대표 사진 저장 중 ${k}/${chosen.length}`));
      added += n;
      set(i, `✓ ${n}장 등록${res.consistent === false ? " (사진이 섞여 있어 확인 필요)" : ""}`, res.consistent === false ? "warn" : "ok");
    } catch (err) {
      console.error(err);
      failed++;
      set(i, err.message || "실패", "err");
    }
  }
  state.busy = false;
  state.dogs.sort(dogOrder);
  toast(`새로 등록 ${made}마리 · 대표 사진 ${added}장${failed ? ` · 실패 ${failed}` : ""}`);
  $("#import-body").insertAdjacentHTML("beforeend",
    `<div class="row" style="margin-top:10px"><button id="import-done" class="btn ghost block">닫기</button></div>`);
  $("#import-done").addEventListener("click", () => { importPlan = null; renderImport(); });
  renderRoster();
}

// 새 강아지 등록 (이름 + 여러 각도 사진)
$("#new-dog-files").addEventListener("change", (e) => {
  const n = e.target.files.length;
  $("#new-dog-files-label").textContent = n ? `📷 ${n}장 선택됨` : "📷 대표 사진 고르기 (여러 장)";
});
$("#new-dog").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#new-dog-name").value.trim();
  const files = [...$("#new-dog-files").files];
  if (!name) return;
  if (state.dogs.some((d) => !d.auto && norm(d.name) === norm(name))) {
    toast(`'${name}'은(는) 이미 명단에 있어요. 아래에서 사진을 추가하세요.`);
    return;
  }
  const btn = $("button[type=submit]", e.target);
  btn.disabled = true;
  const { data: dog, error } = await sb.from("dogs")
    .insert({ name, note: $("#new-dog-note").value.trim() || null, auto: false }).select().single();
  if (error) { toast("등록하지 못했어요"); btn.disabled = false; return; }
  dog.dog_refs = [];
  state.dogs.push(dog);
  if (files.length) await addRefs(dog, files, (n) => { btn.textContent = `사진 올리는 중 ${n}/${files.length}`; });
  e.target.reset();
  $("#new-dog-files-label").textContent = "📷 대표 사진 고르기 (여러 장)";
  btn.disabled = false;
  btn.textContent = "등록";
  state.dogs.sort(dogOrder);
  toast(`${name} 등록 완료`);
  renderRoster();
});

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

// ---- 선생님 업로드 링크
const upUrl = (t) => `${location.origin}${location.pathname.replace(/[^/]*$/, "")}up.html#k=${t}`;
async function renderUpLinks() {
  const { data } = await sb.from("upload_links").select("*").order("created_at", { ascending: false });
  const list = data || [];
  $("#up-links").innerHTML = list.length ? list.map((l) => `<div class="up-link ${l.active ? "" : "off"}">
      <div class="grow"><b>${esc(l.label || "선생님 링크")}</b>${l.active ? "" : ` <span class="tag off">꺼짐</span>`}<br><small class="muted">${esc(upUrl(l.token))}</small></div>
      ${l.active ? `<button class="btn primary mini" data-copy="${l.token}">링크 복사</button>` : ""}
      <button class="btn ghost mini" data-onoff="${l.token}">${l.active ? "끄기" : "켜기"}</button>
    </div>`).join("") : `<p class="muted small">아직 링크가 없어요.</p>`;
  $$("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    const url = upUrl(b.dataset.copy);
    try { await navigator.clipboard.writeText(url); toast("링크를 복사했어요. 선생님 단톡방에 붙여 넣어 주세요"); }
    catch { prompt("이 링크를 복사해 주세요", url); }
  }));
  $$("[data-onoff]").forEach((b) => b.addEventListener("click", async () => {
    const l = list.find((x) => x.token === b.dataset.onoff);
    if (l.active && !confirm("이 링크를 끄면 선생님들이 더 이상 올릴 수 없어요. 끌까요?")) return;
    await sb.from("upload_links").update({ active: !l.active }).eq("token", l.token);
    renderUpLinks();
  }));
}
$("#up-new").addEventListener("click", async () => {
  const label = prompt("링크 이름 (예: 선생님 단톡방)", "선생님 단톡방");
  if (label === null) return;
  const b = crypto.getRandomValues(new Uint8Array(18));
  const token = btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]));
  const { error } = await sb.from("upload_links").insert({ token, label: label.trim() || null });
  if (error) { toast("만들지 못했어요"); return; }
  await renderUpLinks();
  try { await navigator.clipboard.writeText(upUrl(token)); toast("새 링크를 만들고 복사했어요"); } catch { /* 무시 */ }
});

// 선생님이 링크로 올리는 사진: 실시간으로 받아서 알림 → 다 들어오면(20초 조용하면) 자동 분류
const live = { n: 0, timer: null, last: 0 };
const baseTitle = document.title;
function showLive() {
  const bar = $("#live-bar");
  const quiet = Date.now() - live.last > 15000;
  $("#live-text").innerHTML = quiet
    ? `📲 선생님이 올린 사진 <b>${live.n}장</b>이 들어왔어요${state.attendance.size ? " · 분류 시작" : " · 명단을 확정하면 분류해요"}`
    : `📲 선생님이 사진을 올리고 있어요… <b>${live.n}장</b> 들어옴`;
  bar.classList.toggle("receiving", !quiet);
  bar.classList.remove("hidden");
  document.title = `(${live.n}) ${baseTitle}`;
}
$("#live-x").addEventListener("click", () => { $("#live-bar").classList.add("hidden"); live.n = 0; document.title = baseTitle; });
sb.channel("teacher-photos")
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "photos" }, (msg) => {
    const p = msg.new || {};
    if (p.source !== "teacher" || p.day !== kstToday()) return;
    live.n++;
    live.last = Date.now();
    showLive();
    clearTimeout(live.timer);
    live.timer = setTimeout(async () => {
      showLive();
      if (state.day === kstToday()) { await loadPhotos(); if (state.tab === "photos") await renderPhotos(); }
      if (!state.busy && !state.draft && state.attendance.size && state.day === kstToday()) classifyPending();
      setTimeout(() => { if (Date.now() - live.last > 60000) { $("#live-bar").classList.add("hidden"); live.n = 0; document.title = baseTitle; } }, 60000);
    }, 20000);
  })
  .subscribe();

// 실시간 연결이 끊겼을 때를 대비해 30초마다도 확인해서 자동 분류
setInterval(async () => {
  if (state.busy || state.draft || document.hidden || state.day !== kstToday()) return;
  const { count } = await sb.from("photos").select("id", { count: "exact", head: true }).eq("day", state.day).eq("status", "pending");
  if (!count) return;
  if (!state.attendance.size) {
    progress(`선생님이 올린 사진 ${count}장이 기다리고 있어요`, 0, count, "출석 보드를 올리고 명단을 확정하면 바로 분류해요");
    return;
  }
  await loadPhotos();
  toast(`선생님이 올린 사진 ${count}장을 분류할게요`);
  classifyPending();
}, 30000);

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
    const { data: dogs } = await sb.from("dogs").select("id, ref_path, dog_refs(path)");
    const refs = [...new Set((dogs || []).flatMap((d) => (d.dog_refs || []).map((r) => r.path).concat(d.ref_path || [])))];
    for (let i = 0; i < refs.length; i += 100) await sb.storage.from("refs").remove(refs.slice(i, i + 100));
    if (dogs?.length) await sb.from("dogs").delete().in("id", dogs.map((d) => d.id));
    urlCache.clear();
    msg.textContent = "초기화했어요. 사진 탭에서 새로 올려 보세요.";
    await render();
  } catch { msg.textContent = "초기화 중 오류가 났어요. 다시 눌러 주세요."; }
});

/* ================= 새 버전 알림 ================= */
// 화면 파일이 바뀌면(제가 수정해서 올리면) 위에 알림 띄우기
async function fingerprint() {
  const t = Date.now();
  const parts = await Promise.all(["app.js", "style.css", "shell.html", "index.html"].map((f) =>
    fetch(`./${f}?check=${t}`, { cache: "no-store" }).then((r) => (r.ok ? r.text() : "")).catch(() => "")));
  const all = parts.join("|");
  if (!parts.every(Boolean)) return null;
  let h = 0;
  for (let i = 0; i < all.length; i++) h = (h * 31 + all.charCodeAt(i)) | 0;
  return h;
}
let baseFp = null;
async function checkUpdate() {
  const fp = await fingerprint();
  if (fp === null) return;
  if (baseFp === null) { baseFp = fp; return; }
  if (fp !== baseFp) $("#update-bar").classList.remove("hidden");
}
$("#update-now").addEventListener("click", () => {
  if (state.busy && !confirm("지금 분류 중이에요. 새로고침하면 남은 사진은 '남은 N장 분류하기'로 이어서 할 수 있어요. 새로고침할까요?")) return;
  location.reload();
});
checkUpdate();
setInterval(checkUpdate, 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); });

boot();
