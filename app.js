import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { loadFingerprint, fingerprint } from "./fp.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  tileSize: (() => { try { return localStorage.getItem("tileSize") || "l"; } catch { return "l"; } })(), // 모르는 아이 칸 사진 크기
  sel: null, // 여러 장 선택: { key: 그룹(강아지 id·"unsorted"·"skipped"), ids: Set }
  find: [], // 특정 아이만 찾기: 이번에 올리는 사진에서 이 아이(들)만 찾음
  day: kstToday(),
  tab: "board",
  dogs: [],
  photos: [],
  expanded: new Set(), // 비슷한 사진을 펼쳐 둔 아이
  hotel: new Set(),    // 오늘 호텔링(H) 아이
  first: new Set(),    // 오늘 처음 온 아이(N)
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
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
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
function splitSimilar(list, dogId) {
  const t = (p) => new Date(p.taken_at || p.created_at).getTime();
  const sorted = [...list].sort((a, b) => t(a) - t(b));
  const custom = dogId && state.order?.get(dogId)?.length;
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
  if (!custom) return { shown: sorted.filter((p) => keep.has(p.id)), extra: sorted.filter((p) => !keep.has(p.id)) };
  // 순서를 정했으면: 그 순서대로, 순서에 넣은 사진은 비슷해도 숨기지 않음
  const ids = new Set(state.order.get(dogId));
  const ord = sortForDog(dogId, list);
  return { shown: ord.filter((p) => keep.has(p.id) || ids.has(p.id)), extra: ord.filter((p) => !keep.has(p.id) && !ids.has(p.id)) };
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

// 이름 가나다순
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
// ---- 대표 사진 크게 보기 (명단 탭): 넘겨 보면서 잘못된 사진은 바로 삭제하거나 다른 아이로 옮김
const rv = { dog: null, list: [], i: 0, changed: false };
function refList(dog) {
  // 명단 카드에 보이는 순서 그대로
  return dog.dog_refs?.length ? [...dog.dog_refs] : (dog.ref_path ? [{ id: null, path: dog.ref_path }] : []);
}
async function openRefView(dog, i) {
  rv.dog = dog; rv.list = refList(dog); rv.i = i; rv.changed = false;
  $("#ref-view").classList.remove("hidden");
  await showRef();
}
async function showRef() {
  const r = rv.list[rv.i];
  if (!r) { closeRefView(); return; }
  $("#rv-name").textContent = rv.dog.name;
  $("#rv-count").textContent = `${rv.i + 1} / ${rv.list.length}`;
  $("#rv-tag").innerHTML = r.path.includes("-learn-") ? `<i class="lb">분류하며 학습</i>` : r.path.includes("-dd-") ? `<i class="lb dd">다이얼독</i>` : "";
  const url = await signed("refs", [r.path]);
  $("#rv-img").src = url(r.path);
  $("#rv-del").disabled = !r.id;
  $("#rv-move").disabled = !r.id;
}
function closeRefView() {
  $("#ref-view").classList.add("hidden");
  if (rv.changed) renderRoster();
}
function stepRef(d) { if (!rv.list.length) return; rv.i = (rv.i + d + rv.list.length) % rv.list.length; showRef(); }
$("#rv-prev").addEventListener("click", () => stepRef(-1));
$("#rv-next").addEventListener("click", () => stepRef(1));
$("#rv-close").addEventListener("click", closeRefView);
$("#ref-view").addEventListener("click", (e) => { if (e.target.id === "ref-view") closeRefView(); });
async function deleteCurrentRef() {
  const r = rv.list[rv.i];
  if (!r?.id) return;
  await removeRef(rv.dog, r);
  rv.list.splice(rv.i, 1);
  rv.changed = true;
  toast("삭제했어요");
  if (!rv.list.length) { closeRefView(); return; }
  if (rv.i >= rv.list.length) rv.i = rv.list.length - 1;
  showRef();
}
$("#rv-del").addEventListener("click", deleteCurrentRef);
$("#rv-move").addEventListener("click", async () => {
  const r = rv.list[rv.i];
  if (!r?.id) return;
  const v = prompt("이 사진은 어떤 아이인가요? 이름을 써 주세요 (그 아이 대표 사진으로 옮겨요)", "");
  if (!v || !v.trim()) return;
  const to = await findOrCreateDog(v.trim());
  if (!to || to.id === rv.dog.id) return;
  await sb.from("dog_refs").update({ dog_id: to.id }).eq("id", r.id);
  rv.dog.dog_refs = (rv.dog.dog_refs || []).filter((y) => y.id !== r.id);
  to.dog_refs = [...(to.dog_refs || []), r];
  if (rv.dog.ref_path === r.path) {
    const next = rv.dog.dog_refs[0]?.path || null;
    await sb.from("dogs").update({ ref_path: next }).eq("id", rv.dog.id);
    rv.dog.ref_path = next;
  }
  if (!to.ref_path) { await sb.from("dogs").update({ ref_path: r.path }).eq("id", to.id); to.ref_path = r.path; }
  rv.list.splice(rv.i, 1);
  rv.changed = true;
  toast(`${to.name}(으)로 옮겼어요`);
  if (!rv.list.length) { closeRefView(); return; }
  if (rv.i >= rv.list.length) rv.i = rv.list.length - 1;
  showRef();
  moveSimilarRefs(rv.dog, to);
});
// 이름으로 명단에서 찾고, 없으면 새로 등록할지 물어봄
async function findOrCreateDog(name) {
  const m = matchDog(name, null);
  if (m.dog) return m.dog;
  if (m.choices) {
    const v = prompt(`'${name}' 이름의 아이가 여럿이에요. 번호를 골라 주세요\n` + m.choices.map((c, i) => `${i + 1}. ${tellApart(c, name) || c.name}`).join("\n"), "1");
    return v === null ? null : m.choices[+v - 1] || null;
  }
  if (m.similar) {
    const got = askSimilar(name, m.similar);
    if (got === undefined) return null;
    if (got) return got;
  }
  if (!confirm(`'${name}'은(는) 명단에 없어요. 새로 등록할까요?`)) return null;
  const { data, error } = await sb.from("dogs").insert({ name, auto: false, active: true }).select("*, dog_refs(id, path, created_at)").single();
  if (error || !data) { toast("등록하지 못했어요"); return null; }
  state.dogs.push(data);
  state.dogs.sort(dogOrder);
  return data;
}
// 한 장을 B로 옮기면 A의 나머지 사진 중 B인 것도 AI가 찾아서 바로 함께 옮김
async function moveSimilarRefs(from, to) {
  toast(`${from.name} 사진 중에 ${to.name} 사진이 더 있는지 찾고 있어요…`);
  try {
    const { data } = await sb.functions.invoke("move-similar-refs", { body: { from_id: from.id, to_id: to.id } });
    const ids = data?.ids || [];
    if (!ids.length) { toast(`${from.name} 사진 중에 ${to.name} 사진은 더 없어요`); return; }
    const moved = (from.dog_refs || []).filter((r) => ids.includes(r.id));
    from.dog_refs = (from.dog_refs || []).filter((r) => !ids.includes(r.id));
    to.dog_refs = [...(to.dog_refs || []), ...moved];
    if (moved.some((r) => r.path === from.ref_path)) from.ref_path = from.dog_refs[0]?.path || null;
    if (!to.ref_path) to.ref_path = moved[0]?.path || null;
    toast(`${to.name} 사진 ${ids.length}장을 더 찾아서 ${to.name}(으)로 옮겼어요`);
    if (!$("#ref-view").classList.contains("hidden") && rv.dog?.id === from.id) {
      const cur = rv.list[rv.i]?.id;
      rv.list = rv.list.filter((r) => !ids.includes(r.id));
      rv.changed = true;
      if (!rv.list.length) { closeRefView(); return; }
      const k = rv.list.findIndex((r) => r.id === cur);
      rv.i = k >= 0 ? k : Math.min(rv.i, rv.list.length - 1);
      showRef();
    } else if (state.tab === "roster") renderRoster();
  } catch (e) { console.warn(e); }
}
document.addEventListener("keydown", (e) => {
  if ($("#ref-view").classList.contains("hidden")) return;
  if (e.key === "ArrowLeft") stepRef(-1);
  else if (e.key === "ArrowRight") stepRef(1);
  else if (e.key === "Escape") closeRefView();
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteCurrentRef(); }
});

// 그룹 삭제 (사진은 남김: 그 아이만 빠지고, 아무도 안 남으면 '분류 안 됨'으로)
async function deleteDogs(ids) {
  const { data, error } = await sb.rpc("delete_dogs", { ids });
  if (error) { toast("삭제하지 못했어요"); console.warn(error); return; }
  const paths = [...new Set((data || []).map((x) => x.path).filter(Boolean))];
  for (let i = 0; i < paths.length; i += 100) await sb.storage.from("refs").remove(paths.slice(i, i + 100));
  state.dogs = state.dogs.filter((d) => !ids.includes(d.id));
  ids.forEach((id) => state.attendance.delete(id));
  toast(ids.length > 1 ? `그룹 ${ids.length}개를 삭제했어요` : "삭제했어요");
  await loadPhotos();
  render();
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
$("#my-pw").addEventListener("click", async () => {
  const { data } = await sb.auth.getUser();
  $("#me-email").textContent = data?.user?.email || "";
  $("#pw-dialog").classList.remove("hidden");
  $("#pw-new").focus();
});
$("#pw-close").addEventListener("click", () => $("#pw-dialog").classList.add("hidden"));
$("#pw-dialog").addEventListener("click", (e) => { if (e.target.id === "pw-dialog") $("#pw-dialog").classList.add("hidden"); });

let started = false;
// 관리 탭은 최고 관리자만
async function applyRole() {
  const { data: { user } } = await sb.auth.getUser();
  const { data: me } = user ? await sb.from("staff_roles").select("role").eq("user_id", user.id).maybeSingle() : { data: null };
  state.owner = me?.role === "owner";
  // 초대된 선생님은 알림장·호텔링·픽드랍만 (DB·관리자는 최고 관리자만)
  $("#tab-admin-btn").classList.toggle("hidden", !state.owner);
  $("#tab-roster-btn")?.classList.toggle("hidden", !state.owner);
  if (!state.owner && (state.tab === "admin" || state.tab === "roster")) { state.tab = "board"; await render(); }
  else if (state.tab === "pickup") await render(); // 관리 버튼 보이기
}
async function startApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  applyRole();
  if (started) return;
  started = true;
  $("#day").value = state.day;
  if (location.hash === "#pickup") state.tab = "pickup";
  setupPickupWatch();
  await render();
}

/* ================= 픽드랍: 탭 빨간 점·실시간·폰 알림 눌렀을 때 ================= */
const PICKUP_V = Date.now();
const pickupMod = () => import(`./pickup.js?v=${PICKUP_V}`);
async function updatePickupDot() {
  try {
    const n = state.tab === "pickup" ? 0 : await (await pickupMod()).pickupUnseen(sb);
    $("#pk-dot")?.classList.toggle("hidden", !n);
  } catch { /* 표시만 못 함 */ }
}
function setupPickupWatch() {
  updatePickupDot();
  let t = null;
  let tt = null;
  sb.channel("tasks-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "daily_tasks" }, () => { clearTimeout(tt); tt = setTimeout(() => { if (state.tab === "board") drawTasks(); }, 300); })
    .on("postgres_changes", { event: "*", schema: "public", table: "hotel_bookings" }, () => { clearTimeout(tt); tt = setTimeout(() => { if (state.tab === "board") drawTasks(); }, 300); })
    .subscribe();
  sb.channel("pd-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "pd_requests" }, () => {
      clearTimeout(t);
      t = setTimeout(() => { if (state.tab === "pickup") render(); else updatePickupDot(); }, 600);
    })
    .subscribe();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { type: "module" }).catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "open-tab" && e.data.tab) { state.tab = e.data.tab; render(); }
    });
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { if (state.tab === "pickup") render(); else updatePickupDot(); if (state.tab === "board") drawTasks(); } });
}

/* ================= 데이터 ================= */
async function loadDogs() {
  const { data } = await sb.from("dogs").select("*, dog_refs(id, path, created_at)");
  (data || []).forEach((d) => (d.dog_refs || []).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  const autos = (data || []).filter((d) => d.auto);
  if (autos.length) purgeAutoGroups(autos.map((d) => d.id));
  state.dogs = (data || []).filter((d) => !d.auto).sort(dogOrder);
}
// '새 강아지' 그룹은 더 이상 쓰지 않음: 남아 있으면 지우고 사진은 '모르는 아이'로 돌림
async function purgeAutoGroups(ids) {
  try {
    await sb.from("lessons").update({ wrong_dog: null }).in("wrong_dog", ids);
    await sb.from("lessons").delete().in("right_dog", ids);
    const { data } = await sb.rpc("delete_dogs", { ids });
    const paths = [...new Set((data || []).map((x) => x.path).filter(Boolean))];
    for (let i = 0; i < paths.length; i += 100) await sb.storage.from("refs").remove(paths.slice(i, i + 100));
  } catch (e) { console.warn(e); }
}
async function loadAttendance() {
  const { data } = await sb.from("assignments").select("dog_id, hotel, first").eq("day", state.day);
  state.attendance = new Set((data || []).map((a) => a.dog_id));
  state.hotel = new Set((data || []).filter((a) => a.hotel).map((a) => a.dog_id)); // 오늘 호텔링(H)
  state.first = new Set((data || []).filter((a) => a.first).map((a) => a.dog_id)); // 오늘 처음 온 아이(N)
}
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

async function loadPhotos() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("photos")
      .select("id, path, thumb_path, dog_ids, status, ai_note, confidence, created_at, taken_at, phash, sharp, rotation, not_dogs, rotation_checked")
      .eq("day", state.day).eq("practice", !!state.practice).order("created_at").range(from, from + 999);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  state.photos = all;
  await loadOrder();
  backfillStats();
}

/* ---------- 순서·대표 정하기 창 ---------- */
async function openOrder(dogId, list, thumb) {
  const dog = dogById(dogId);
  if (!dog) return;
  let ids = sortForDog(dogId, list).map((p) => p.id);
  const byId = new Map(list.map((p) => [p.id, p]));
  document.querySelector(".rc-overlay")?.remove();
  const ov = document.createElement("div");
  ov.className = "rc-overlay";
  ov.innerHTML = `<div class="rc-box po-box">
    <div class="rc-head"><div class="grow"><b>${esc(dog.name)} 사진 순서</b><small class="muted">끌어서 순서를 바꾸고, ⭐를 누르면 대표 사진(맨 앞)이 돼요</small></div><button class="btn ghost sm" data-close>닫기</button></div>
    <div class="rc-body"><div class="po-grid" id="po-grid"></div></div>
    <div class="rc-foot"><button class="btn ghost sm" data-reset>찍은 순서로 되돌리기</button><span class="grow"></span><button class="btn primary sm" data-save>순서 저장</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  $("[data-close]", ov).addEventListener("click", close);
  const grid = $("#po-grid", ov);
  const draw = () => {
    grid.innerHTML = ids.map((id, i) => { const p = byId.get(id); return `<div class="po-it ${i === 0 ? "cover" : ""}" data-id="${id}">
      <img src="${thumb(p.thumb_path)}" class="rot${p.rotation || 0}" alt="" draggable="false">
      <span class="po-n">${i === 0 ? "대표" : i + 1}</span>
      <button class="po-star" data-star="${id}" aria-label="대표 사진으로">${i === 0 ? "⭐" : "☆"}</button>
      <span class="po-mv"><button data-up="${id}" aria-label="앞으로">‹</button><button data-down="${id}" aria-label="뒤로">›</button></span>
    </div>`; }).join("");
    $$("[data-star]", grid).forEach((b) => b.addEventListener("click", () => { ids = [b.dataset.star, ...ids.filter((x) => x !== b.dataset.star)]; draw(); }));
    $$("[data-up]", grid).forEach((b) => b.addEventListener("click", () => { const i = ids.indexOf(b.dataset.up); if (i > 0) { [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; draw(); } }));
    $$("[data-down]", grid).forEach((b) => b.addEventListener("click", () => { const i = ids.indexOf(b.dataset.down); if (i < ids.length - 1) { [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; draw(); } }));
  };
  draw();
  try {
    const { default: Sortable } = await import("https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/modular/sortable.esm.js");
    Sortable.create(grid, { animation: 150, delay: 120, delayOnTouchOnly: true, filter: "button", preventOnFilter: false,
      onEnd: () => { ids = $$(".po-it", grid).map((el) => el.dataset.id); draw(); } });
  } catch { /* 끌기가 안 되면 ‹ › 버튼으로 */ }
  $("[data-reset]", ov).addEventListener("click", async () => {
    await sb.from("photo_order").delete().eq("day", state.day).eq("dog_id", dogId);
    state.order.delete(dogId);
    toast("찍은 순서로 되돌렸어요");
    close(); renderPhotos();
  });
  $("[data-save]", ov).addEventListener("click", async () => {
    const { error } = await sb.from("photo_order").upsert({ day: state.day, dog_id: dogId, ids, updated_at: new Date().toISOString() }, { onConflict: "day,dog_id" });
    if (error) { toast("저장하지 못했어요"); return; }
    state.order.set(dogId, ids);
    toast("순서를 저장했어요. 다운로드·다이얼독도 이 순서예요");
    close(); renderPhotos();
  });
}

/* ---------- 사진 순서·대표 사진 (아이별·날짜별, 맨 앞 = 대표) ---------- */
state.order = new Map(); // 아이 id → [사진 id 순서]
async function loadOrder() {
  const { data } = await sb.from("photo_order").select("dog_id, ids").eq("day", state.day);
  state.order = new Map((data || []).map((r) => [r.dog_id, r.ids || []]));
}
// 정한 순서가 있으면 그 순서대로, 새로 들어온 사진은 뒤에 찍은 시간 순
function sortForDog(dogId, list) {
  const t = (p) => new Date(p.taken_at || p.created_at).getTime();
  const ids = state.order.get(dogId) || [];
  const rank = new Map(ids.map((id, i) => [id, i]));
  return [...list].sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9) || t(a) - t(b));
}
const coverOf = (dogId) => (state.order.get(dogId) || [])[0] || null;

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
$$(".tabs button").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; state.sel = null; renderSelBar(); render(); }));

const HOTEL_V = Date.now();
async function render() {
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));
  document.querySelector(".layout")?.classList.toggle("wide", state.tab === "hotel" || state.tab === "kinder" || state.tab === "pickup" || state.tab === "admin");
  $("#app")?.classList.toggle("tab-admin", state.tab === "admin");
  $("#app")?.classList.toggle("tab-hotel", state.tab === "hotel");
  $("#app")?.classList.toggle("tab-kinder", state.tab === "kinder");
  $("#app")?.classList.toggle("tab-pickup", state.tab === "pickup");
  $("#app")?.classList.toggle("tab-board", state.tab === "board");
  $$(".tab").forEach((s) => s.classList.toggle("hidden", s.id !== "tab-" + state.tab));
  if (state.tab === "board") {
    Promise.all([loadDogs(), loadAttendance(), loadPractice()]).catch(() => {}); // 사진 자동 분류는 보드에 있어도 계속 돌도록
    document.querySelector(".layout")?.classList.remove("with-side");
    await drawTasks();
    return;
  }
  if (state.tab !== "pickup") await Promise.all([loadDogs(), loadAttendance(), loadPractice()]);
  if (state.tab === "photos") { await loadPhotos(); await renderPhotos(); }
  else if (state.tab === "roster") renderRoster();
  else if (state.tab === "kinder") {
    const m = await import(`./kinder.js?v=${HOTEL_V}`);
    await m.renderKinder({ sb, toast, signed, esc, dogs: state.dogs });
  }
  else if (state.tab === "hotel") {
    const m = await import(`./hotel.js?v=${HOTEL_V}`);
    await m.renderHotel({ sb, toast, signed, esc, dogs: state.dogs });
  }
  else if (state.tab === "pickup") {
    const m = await pickupMod();
    await m.renderPickup({ sb, toast, esc, owner: !!state.owner, root: $("#tab-pickup"), onSeen: () => $("#pk-dot")?.classList.add("hidden") });
  }
  else if (state.tab === "admin" && state.owner === false) { state.tab = "board"; return render(); }
  else if (state.tab === "admin") { renderStaff(); renderUpLinks(); renderDdLinks(); loadPractice(); }
  renderSide();
}

/* ================= 사진 화면 ================= */
// 오늘 할 일 보드 (알림장 탭 맨 위)
const TASKS_V = Date.now();
async function drawTasks() {
  try {
    const m = await import(`./tasks.js?v=${TASKS_V}`);
    await m.renderTasks({ sb, toast, root: $("#tasks") });
  } catch (e) { console.error(e); }
}
async function renderPhotos() {
  renderRoll(); // 왼쪽 오늘 명단(장수)도 함께 갱신
  renderFind();
  const P = state.photos;
  const done = P.filter((p) => p.status === "done");
  const unsorted = P.filter((p) => p.status === "review" || p.status === "error");
  const pending = P.filter((p) => p.status === "pending" || p.status === "working");
  const skipped = P.filter((p) => p.status === "skip");

  $("#summary").innerHTML = P.length
    ? `<span><b>${P.length}</b>장</span>
       <span>분류 완료 <b>${done.length}</b></span>
       ${unsorted.length ? `<span class="warn">분류 안 됨 <b>${unsorted.length}</b></span>` : ""}
       ${pending.length && !state.busy ? `<button id="resume" class="btn primary sm">남은 ${pending.length}장 분류하기</button>` : ""}
       ${done.length || unsorted.length ? `<button id="save-all" class="btn primary sm">📥 전체 다운로드</button>` : ""}
       ${done.length && state.day === kstToday() && !state.practice ? `<button id="dd-push" class="btn sm dd-push-btn">📮 다이얼독 알림장</button>` : ""}`
    : "";
  $("#dd-push")?.addEventListener("click", () => {
    if (pending.length || unsorted.length) {
      if (!confirm(`아직 ${pending.length ? `분류 중인 사진 ${pending.length}장` : ""}${pending.length && unsorted.length ? ", " : ""}${unsorted.length ? `분류 안 된 사진 ${unsorted.length}장` : ""}이 있어요.\n지금 넣으면 그 사진은 빠져요. (나중에 다시 누르면 새로 분류된 사진만 따로 넣을 수 있어요)\n\n다이얼독을 열까요?`)) return;
    }
    openDialdogPush();
  });
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
  // 비슷한 사진은 3장까지만 보이고 저장 (펼치면 전부)
  const sets = new Map(dogIds.map((id) => [id, splitSimilar(groups.get(id), id)]));
  const visible = (id) => (state.expanded.has(id) ? [...sets.get(id).shown, ...sets.get(id).extra] : sets.get(id).shown);

  const box = $("#groups");
  if (!P.length) {
    box.innerHTML = `<div class="empty">아직 이 날짜에 올린 사진이 없어요.<br>위에서 사진을 올려 보세요.</div>`;
    return;
  }

  await loadClusters(unsorted);
  const thumb = await signed("photos", P.map((p) => p.thumb_path));
  const ref = await signed("refs", dogIds.map((id) => dogById(id)?.ref_path));
  const covers = new Set(dogIds.map(coverOf).filter(Boolean));
  const img = (p) => `<img loading="lazy" src="${thumb(p.thumb_path)}" data-photo="${p.id}" class="${covers.has(p.id) ? "cover " : ""}rot${p.rotation || 0}${p.status === "done" && p.confidence === "low" ? " unsure" : ""}${state.sel?.ids.has(p.id) ? " picked" : ""}" alt=""${p.status === "done" && p.confidence === "low" ? ' title="AI가 확신하지 못한 사진 — 확인해 주세요"' : ""}>`;

  box.innerHTML = dogIds.map((id) => {
    const dog = dogById(id);
    const { shown, extra } = sets.get(id);
    const open = state.expanded.has(id);
    return `<div class="dog-group" data-list="${id}">
      <div class="dog-head">
        ${dog.ref_path ? `<img class="avatar" src="${ref(dog.ref_path)}" alt="">` : `<span class="avatar"></span>`}
        <div class="grow">
          <button class="dog-name ${dog.auto ? "unnamed" : ""}" data-rename="${id}">${esc(dog.name)}${breedTag(dog)} <span>✎</span></button>
          <small class="muted">${shown.length}장${extra.length ? ` · 비슷한 사진 ${extra.length}장 ${open ? "펼침" : "접힘"}` : ""}</small>
        </div>
        <div class="save-btns">${state.busy ? "" : `<button class="btn ghost sm" data-order="${id}">↕ 순서·대표</button><button class="btn ghost sm" data-verify="${id}">🔍 다시 검수</button>`}${selBtn(id)}${saveButtons(id)}</div>
      </div>
      <div class="grid">${shown.map(img).join("")}</div>
      ${extra.length ? `<button class="more-sim" data-expand="${id}">${open ? "비슷한 사진 접기 ▲" : `비슷한 사진 ${extra.length}장 더 보기 ▼`}</button>
        ${open ? `<div class="grid extra">${extra.map(img).join("")}</div>` : ""}` : ""}
    </div>`;
  }).join("") +
  (skipped.length ? `<div class="dog-group skipped" data-list="skipped">
      <div class="dog-head"><span class="avatar q">🔎</span>
        <div class="grow"><b>찾는 아이가 아닌 사진 ${skipped.length}장</b><small class="muted">'특정 아이만 찾기'로 올린 사진 중 찾는 아이가 없던 사진이에요. 지우지 않고 모아 뒀어요</small></div>
        ${state.showSkipped ? selBtn("skipped") : ""}<button id="skip-toggle" class="btn ghost sm">${state.showSkipped ? "접기" : "보기"}</button>
        ${state.busy ? "" : `<button id="skip-all" class="btn ghost sm">전체 아이로 다시 분류</button>`}</div>
      ${state.showSkipped ? `<div class="grid">${skipped.map(img).join("")}</div>` : ""}
    </div>` : "") +
  (unsorted.length ? `<div class="dog-group unsorted" data-list="unsorted">
      <div class="dog-head"><span class="avatar q">?</span>
        <div class="grow"><b>모르는 아이·분류 안 된 사진 ${unsorted.length}장</b><small class="muted">처음 보는 아이, 뺀 사진, AI가 확신하지 못한 사진을 한곳에 모았어요. 비슷한 사진끼리 묶어 두었으니 묶음째 선택해서 한 번에 넣을 수 있어요</small></div>
        ${selBtn("unsorted")}${state.busy ? "" : `<button id="reclassify" class="btn ghost sm">AI로 다시 분류</button>`}<button id="save-unsorted" class="btn ghost sm">📥 다운로드</button></div>
      <div class="tile-size">사진 크기
        ${[["s", "작게"], ["m", "보통"], ["l", "크게"], ["xl", "아주 크게"]].map(([k, t]) => `<button class="btn ${state.tileSize === k ? "primary" : "ghost"} mini" data-tile="${k}">${t}</button>`).join("")}
        <small class="muted">비슷하게 생긴 사진끼리 붙여서 보여줘요</small></div>
      <div class="grid tiles-${state.tileSize}">${burstGroups(unsortedClusters(unsorted).flat()).map(({ rep: p, members }) => {
        const more = members.length - 1;
        return `<div class="tile">${img(p)}${more ? `<span class="burst" title="거의 같은 사진 ${more}장이 함께 묶여 있어요. 고르면 함께 선택돼요">+${more}</span>` : ""}</div>`;
      }).join("")}</div>
    </div>` : "") +
  (!dogIds.length && !unsorted.length && !skipped.length ? `<div class="empty">분류를 기다리는 사진이 있어요.</div>` : "");

  // 사진 넘겨보기용: 그룹별 사진 순서
  const lists = new Map(dogIds.map((id) => [id, visible(id).map((p) => p.id)]));
  $$("[data-expand]", box).forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.expand;
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
    renderPhotos();
  }));
  lists.set("unsorted", burstGroups(unsortedClusters(unsorted).flat()).map((g) => g.rep.id));
  lists.set("skipped", skipped.map((p) => p.id));
  $("#skip-toggle")?.addEventListener("click", () => { state.showSkipped = !state.showSkipped; renderPhotos(); });
  $("#skip-all")?.addEventListener("click", async () => {
    if (!confirm(`찾는 아이가 아닌 사진 ${skipped.length}장을 오늘 명단의 모든 아이 기준으로 다시 분류할까요?`)) return;
    const ids = skipped.map((p) => p.id);
    for (let i = 0; i < ids.length; i += 200) {
      await sb.from("photos").update({ status: "pending", dog_ids: [], find_dogs: [], ai_note: null }).in("id", ids.slice(i, i + 200));
    }
    await loadPhotos();
    classifyPending();
  });
  $$("[data-photo]", box).forEach((el) => el.addEventListener("click", () => {
    const key = el.closest("[data-list]")?.dataset.list;
    if (state.sel && state.sel.key === key) {
      const id = el.dataset.photo;
      const on = !state.sel.ids.has(id);
      for (const m of burstOf.get(id) || [id]) on ? state.sel.ids.add(m) : state.sel.ids.delete(m);
      el.classList.toggle("picked", on);
      renderSelBar();
      return;
    }
    openSheet(el.dataset.photo, lists.get(key) || [el.dataset.photo], key);
  }));
  $$("[data-tile]", box).forEach((b) => b.addEventListener("click", () => {
    state.tileSize = b.dataset.tile;
    try { localStorage.setItem("tileSize", state.tileSize); } catch { /* 저장 안 돼도 됨 */ }
    renderPhotos();
  }));
  $$("[data-pick-cluster]", box).forEach((b) => b.addEventListener("click", () => {
    state.sel = { key: "unsorted", ids: new Set(b.dataset.pickCluster.split(",")), all: lists.get("unsorted") || [] };
    renderPhotos();
  }));
  $$("[data-order]", box).forEach((b) => b.addEventListener("click", () => openOrder(b.dataset.order, [...groups.get(b.dataset.order)], thumb)));
  $$("[data-verify]", box).forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.verify;
    state.sel = { key, ids: new Set(), all: lists.get(key) || [], mode: "verify" };
    renderPhotos();
  }));
  $$("[data-select]", box).forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.select;
    state.sel = state.sel?.key === key ? null : { key, ids: new Set(), all: lists.get(key) || [] };
    renderPhotos();
  }));
  if (state.sel) state.sel.all = lists.get(state.sel.key) || [];
  renderSelBar();
  // 그룹이 늘어난 뒤 다시 돌리면 대부분 자리를 찾아감
  // 바로 넣지 않고, 어디로 갈지 먼저 보여준 뒤 확인하고 넣음
  $("#reclassify")?.addEventListener("click", () => previewReclassify(unsorted));
  $("#save-unsorted")?.addEventListener("click", (e) => saveAll(e.currentTarget, true));
  $$("[data-rename]", box).forEach((b) => b.addEventListener("click", async () => {
    if (await renameDog(dogById(b.dataset.rename))) renderPhotos();
  }));
  $$("[data-save]", box).forEach((b) => b.addEventListener("click", () =>
    saveDogPhotos(dogById(b.dataset.save), visible(b.dataset.save), b, b.dataset.mode)));
}

// ---- 모르는 아이 사진을 지문이 비슷한 것끼리 묶기 (서버에서 계산, 바뀔 때만 다시)
const clusterCache = { key: "", map: new Map() };
async function loadClusters(unsorted) {
  const key = state.day + "|" + !!state.practice + "|" + unsorted.map((p) => p.id).sort().join(",");
  if (!unsorted.length || clusterCache.key === key) return;
  const { data, error } = await sb.rpc("unsorted_clusters", { p_day: state.day, p_practice: !!state.practice });
  if (error) { console.warn(error); return; }
  clusterCache.key = key;
  clusterCache.map = new Map((data || []).map((r) => [r.photo_id, r.cluster]));
}
// 연속으로 찍은 거의 같은 사진은 한 장만 보이고 나머지는 함께 묶음 (같은 사진이 여러 번 보이지 않게)
const burstOf = new Map(); // 보이는 사진 id → 함께 묶인 사진 id들
function burstGroups(list) {
  const t = (p) => new Date(p.taken_at || p.created_at).getTime();
  const groups = [];
  for (const p of list) {
    const g = groups.slice(-6).find((x) => x.members.some((q) => p.phash && q.phash && hamming(p.phash, q.phash) <= SIM_DIST && Math.abs(t(p) - t(q)) <= SIM_GAP));
    if (g) g.members.push(p); else groups.push({ members: [p] });
  }
  const seen = new Set();
  return groups.map((g) => {
    const members = g.members.filter((p) => !seen.has(p.id) && seen.add(p.id));
    const rep = [...members].sort((a, b) => (b.sharp || 0) - (a.sharp || 0))[0];
    burstOf.set(rep.id, members.map((p) => p.id));
    return { rep, members };
  }).filter((g) => g.rep);
}
function unsortedClusters(unsorted) {
  const by = new Map();
  for (const p of unsorted) {
    const c = clusterCache.map.get(p.id);
    const k = c && c > 0 ? c : "single:" + p.id;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(p);
  }
  const groups = [...by.values()];
  const multi = groups.filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
  const singles = groups.filter((g) => g.length === 1).flat();
  if (singles.length) singles.loose = true;
  return singles.length ? [...multi, singles] : multi;
}

// ---- 여러 장 선택해서 한꺼번에 옮기기·빼기
const selBtn = (key) => `<button class="btn ${state.sel?.key === key ? "primary" : "ghost"} sm" data-select="${key}">${state.sel?.key === key ? "선택 끝" : "☑ 여러 장 선택"}</button>`;
// 화면 옆에 따라다니는 도구: 지금 보고 있는 폴더 기준으로 여러 장 선택·검수·크기
let viewKey = null;
function groupInView() {
  const groups = $$("#groups .dog-group[data-list]");
  const y = Math.min(220, window.innerHeight * 0.3);
  let best = null;
  for (const g of groups) {
    const r = g.getBoundingClientRect();
    if (r.top <= y && r.bottom > y) return g.dataset.list;
    if (r.top > y && !best) best = g.dataset.list;
  }
  return best || groups.at(-1)?.dataset.list || null;
}
const groupName = (key) => dogById(key)?.name || (key === "unsorted" ? "모르는 아이·분류 안 된 사진" : key === "skipped" ? "찾는 아이가 아닌 사진" : "");
let toolTick = null;
window.addEventListener("scroll", () => {
  if (toolTick || state.sel || state.tab !== "photos") return;
  toolTick = requestAnimationFrame(() => { toolTick = null; if (groupInView() !== viewKey) renderSelBar(); });
}, { passive: true });
function renderSelBar() {
  let bar = $("#sel-bar");
  const hasGroups = state.tab === "photos" && $$("#groups .dog-group[data-list]").length > 0;
  if (!hasGroups || (state.busy && !state.sel)) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement("div"); bar.id = "sel-bar"; document.body.appendChild(bar); }
  if (!state.sel) {
    // 선택 전: 지금 보고 있는 폴더용 도구
    viewKey = groupInView();
    if (!viewKey) { bar.remove(); return; }
    const d = dogById(viewKey);
    bar.innerHTML = `<b class="tool-title">${esc(groupName(viewKey))}</b>
      <button class="btn primary sm" data-tool="select">☑ 여러 장 선택</button>
      ${d ? `<button class="btn ghost sm" data-tool="verify">🔍 다시 검수</button>` : ""}
      ${viewKey === "unsorted" ? `<div class="tool-size">${[["s", "작게"], ["m", "보통"], ["l", "크게"], ["xl", "아주 크게"]].map(([k, t]) => `<button class="btn ${state.tileSize === k ? "primary" : "ghost"} mini" data-tile-tool="${k}">${t}</button>`).join("")}</div>` : ""}
      <button class="btn ghost mini" data-tool="top">▲ 맨 위로</button>`;
    $$("[data-tool]", bar).forEach((b) => b.addEventListener("click", () => {
      const k = viewKey, t = b.dataset.tool;
      if (t === "top") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
      const all = [...document.querySelectorAll(`#groups [data-list="${CSS.escape(k)}"] [data-photo]`)].map((el) => el.dataset.photo);
      state.sel = { key: k, ids: new Set(), all, mode: t === "verify" ? "verify" : undefined };
      renderPhotos();
    }));
    $$("[data-tile-tool]", bar).forEach((b) => b.addEventListener("click", () => {
      state.tileSize = b.dataset.tileTool;
      try { localStorage.setItem("tileSize", state.tileSize); } catch { /* 저장 안 돼도 됨 */ }
      renderPhotos();
    }));
    return;
  }
  const key = state.sel.key, n = state.sel.ids.size;
  const dog = dogById(key);
  // 고른 사진을 작은 섬네일로 모아 보여줌 (눌러서 빼기)
  const shownIds = [...state.sel.ids].filter((id) => document.querySelector(`#groups [data-photo="${CSS.escape(id)}"]`));
  const tray = shownIds.length
    ? `<div class="sel-tray">${shownIds.slice(-60).reverse().map((id) => {
        const el = document.querySelector(`#groups [data-photo="${CSS.escape(id)}"]`);
        const more = (burstOf.get(id) || [id]).length - 1;
        return `<button class="sel-thumb" data-unpick="${id}" title="눌러서 선택 빼기"><img src="${el.getAttribute("src")}" class="${el.className.replace(/\b(picked|unsure)\b/g, "")}" alt="">${more ? `<i>+${more}</i>` : ""}<b>×</b></button>`;
      }).join("")}</div>`
    : `<small class="muted">사진을 누르면 여기에 모여요</small>`;
  if (state.sel.mode === "verify") {
    bar.innerHTML = `<b>🔍 ${esc(dog?.name || "")} 다시 검수</b>${tray}
      <small>기준이 될 사진(이 아이가 확실한 사진)을 1~3장 눌러 주세요. 안 골라도 대표 사진으로 검수해요${n ? ` · <b>${n}장</b> 골랐어요` : ""}</small>
      <button class="btn primary sm" data-sb="verify">검수 시작</button>
      <button class="btn ghost sm" data-sb="cancel">취소</button>`;
    $$("[data-sb]", bar).forEach((b) => b.addEventListener("click", () => selAction(b.dataset.sb)));
    bindUnpick(bar);
    return;
  }
  const where = groupName(key);
  bar.innerHTML = `<b class="tool-title">${esc(where)}</b><b class="sel-count">${n}장 선택</b>${tray}
    <button class="btn ghost sm" data-sb="all">${n && n === state.sel.all.length ? "선택 해제" : "전체 선택"}</button>
    ${dog ? `<button class="btn primary sm" data-sb="out" ${n ? "" : "disabled"}>${esc(dog.name)}에서 빼서 아래로</button>` : `<button class="btn primary sm" data-sb="redo" ${n ? "" : "disabled"}>AI로 다시 분류</button>`}
    <button class="btn ghost sm" data-sb="move" ${n ? "" : "disabled"}>다른 아이로 옮기기</button>
    <button class="btn ghost sm danger" data-sb="del" ${n ? "" : "disabled"}>삭제</button>
    <button class="btn ghost sm" data-sb="cancel">취소</button>`;
  $$("[data-sb]", bar).forEach((b) => b.addEventListener("click", () => selAction(b.dataset.sb)));
  bindUnpick(bar);
}
function bindUnpick(bar) {
  $$("[data-unpick]", bar).forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.unpick;
    for (const m of burstOf.get(id) || [id]) state.sel.ids.delete(m);
    document.querySelector(`#groups [data-photo="${CSS.escape(id)}"]`)?.classList.remove("picked");
    renderSelBar();
  }));
}
async function selAction(kind) {
  const sel = state.sel;
  if (!sel) return;
  if (kind === "cancel") { state.sel = null; renderPhotos(); return; }
  if (kind === "all") {
    const every = sel.all.flatMap((id) => burstOf.get(id) || [id]);
    sel.ids = sel.ids.size >= every.length ? new Set() : new Set(every);
    renderPhotos();
    return;
  }
  if (kind === "verify") { state.sel = null; renderSelBar(); verifyFolder(dogById(sel.key), [...sel.ids]); return; }
  const photos = state.photos.filter((p) => sel.ids.has(p.id));
  if (!photos.length) return;
  const from = dogById(sel.key);
  // 폴더에는 비슷한 사진(연속 촬영)이 묶음마다 3장만 보이고 나머지는 접혀 있음.
  // 보이는 사진만 옮기면 접혀 있던 같은 장면 사진이 다시 올라와 '그대로 남은 것'처럼 보이므로 같이 옮김
  if (from && kind !== "del" && !state.expanded.has(from.id)) {
    const t = (p) => new Date(p.taken_at || p.created_at).getTime();
    const inFolder = state.photos.filter((p) => p.status === "done" && p.dog_ids.includes(from.id));
    const { extra } = splitSimilar(inFolder, from.id);
    const picked = new Set(photos.map((p) => p.id));
    for (const q of extra) {
      if (picked.has(q.id)) continue;
      if (photos.some((p) => p.phash && q.phash && hamming(p.phash, q.phash) <= SIM_DIST && Math.abs(t(p) - t(q)) <= SIM_GAP)) {
        photos.push(q); picked.add(q.id);
      }
    }
  }
  if (kind === "del") {
    if (!confirm(`선택한 사진 ${photos.length}장을 완전히 삭제할까요? 되돌릴 수 없어요.`)) return;
    const ids = new Set(photos.map((p) => p.id));
    try {
      await deletePhotos((q) => q.in("id", [...ids]), () => {});
    } catch { toast("다 지우지 못했어요. 다시 눌러 주세요"); }
    state.photos = state.photos.filter((p) => !ids.has(p.id));
    toast(`${photos.length}장을 삭제했어요`);
    state.sel = null;
    await renderPhotos();
    return;
  }
  // 빼고 다시 분류: 이 아이는 후보에서 빼고 AI가 다시 판단
  if (kind === "redo" && !from) { state.sel = null; renderSelBar(); previewReclassify(photos); return; }
  if (kind === "redo") {
    toast(`${photos.length}장을 ${from ? `${from.name}에서 빼고 ` : ""}다시 분류할게요`);
    let i = 0;
    for (const p of photos) {
      const not = from ? [...new Set([...(p.not_dogs || []), from.id])] : (p.not_dogs || []);
      const keep = from ? p.dog_ids.filter((d) => d !== from.id) : [];
      // 다른 아이와 같이 나온 사진은 그 아이는 그대로 두고 빠진 아이만 정리
      const upd = keep.length && from
        ? { dog_ids: keep, status: "done", not_dogs: not }
        : { dog_ids: [], status: "pending", not_dogs: not, ai_note: null, find_dogs: [], claimed_at: null };
      await sb.from("photos").update(upd).eq("id", p.id);
      if (i < 6 && from && !from.auto) learnMistake(p.id, from.id, null);
      Object.assign(p, upd);
      i++;
    }
    state.sel = null;
    await loadPhotos();
    await renderPhotos();
    classifyPending();
    return;
  }
  let to = null;
  if (kind === "move") {
    const typed = prompt(`선택한 ${photos.length}장을 어느 아이로 옮길까요? (이름)`, "");
    if (!typed || !typed.trim()) return;
    to = await findOrCreateDog(typed.trim());
    if (!to) return;
    if (from && to.id === from.id) { toast("같은 아이예요"); return; }
  }
  toast(`${photos.length}장 고치는 중…`);
  const learnLimit = 6; // 실수 기록·학습 사진은 몇 장만 (비용·중복 방지)
  let i = 0;
  for (const p of photos) {
    const before = { status: p.status, ids: [...p.dog_ids], conf: p.confidence };
    let ids = from ? p.dog_ids.filter((d) => d !== from.id) : [];
    if (to) ids = [...new Set([...ids, to.id])];
    const not = from && !to ? [...new Set([...(p.not_dogs || []), from.id])] : (p.not_dogs || []);
    const upd = ids.length ? { dog_ids: ids, status: "done", confidence: "manual", not_dogs: not }
      : { dog_ids: [], status: "review", confidence: null, not_dogs: not, ai_note: from ? `${from.name}에서 뺌` : null };
    await sb.from("photos").update({ ...upd, find_dogs: [] }).eq("id", p.id);
    if (i < learnLimit && from && !from.auto) learnMistake(p.id, from.id, to?.id || null);
    if (i < learnLimit && to) learnFrom(p, [to.id], before);
    Object.assign(p, upd);
    i++;
  }
  // 오늘 명단에 없던 아이로 옮겼으면 명단에 넣어서 AI도 후보로 보게 함
  if (to && state.attendance.size && !state.attendance.has(to.id)) {
    await sb.from("assignments").upsert({ day: state.day, dog_id: to.id }, { onConflict: "day,dog_id", ignoreDuplicates: true });
    state.attendance.add(to.id);
  }
  toast(to ? `${photos.length}장을 ${to.name}(으)로 옮겼어요` : `${photos.length}장을 ${from?.name || ""}에서 빼서 맨 아래 '모르는 아이' 칸으로 보냈어요`);
  state.sel = null;
  await renderPhotos();
  // 다른 사진은 AI가 알아서 옮기지 않음 (다시 검수는 직원이 '폴더 다시 검수'를 눌렀을 때만)
  // 단, '모르는 아이' 칸에서 보낸 거면 칸에 남은 같은 아이 사진은 따라가게
  if (to && !from) followUnsorted(to.id);
}

// ---- 폴더 다시 검수: 기준(대표 사진 + 직원이 고른 사진)과 너무 다른 사진은 빼서 아래로, 누운 사진은 세움
async function verifyFolder(dog, anchors) {
  if (!dog || state.busy) return;
  const list = state.photos.filter((p) => p.status === "done" && p.dog_ids.includes(dog.id) && !anchors.includes(p.id));
  if (!list.length) { toast("검수할 사진이 없어요"); return; }
  state.busy = true;
  const batches = [];
  for (let i = 0; i < list.length; i += 6) batches.push(list.slice(i, i + 6));
  let done = 0, out = 0, fail = 0;
  const title = `${dog.name} 폴더 다시 검수 중… 창을 닫지 마세요`;
  progress(title, 0, list.length, anchors.length ? `기준 사진 ${anchors.length}장과 비교해요` : "대표 사진과 비교해요");
  await pool(batches, 3, async (batch) => {
    try {
      const { data, error } = await sb.functions.invoke("verify-folder", { body: { dog_id: dog.id, photo_ids: batch.map((p) => p.id), anchor_ids: anchors } });
      if (error) throw error;
      for (const r of data?.results || []) {
        const p = state.photos.find((x) => x.id === r.id);
        if (!p) continue;
        const upd = {};
        if (!r.same && p.confidence !== "manual") { // 직원이 확인·수정한 사진은 빼지 않음
          const rest = p.dog_ids.filter((d) => d !== dog.id);
          Object.assign(upd, { dog_ids: rest, not_dogs: [...new Set([...(p.not_dogs || []), dog.id])],
            status: rest.length ? "done" : "review", ai_note: `${dog.name} 검수에서 뺌${r.note ? `: ${r.note}` : ""}`.slice(0, 200) });
          if (!rest.length) upd.confidence = null;
          out++;
        }
        // 방향은 서버가 4방향 비교로 따로 확인 (여기서 대충 정한 각도로 덮어쓰지 않음)
        if (Object.keys(upd).length) {
          await sb.from("photos").update(upd).eq("id", p.id);
          Object.assign(p, upd);
        }
      }
    } catch (e) { console.warn(e); fail += batch.length; }
    done += batch.length;
    progress(title, done, list.length, `뺀 사진 ${out}장${fail ? ` · 확인 못 함 ${fail}장` : ""}`);
  });
  state.busy = false;
  progress(`${dog.name} 검수 끝`, list.length, list.length, `${list.length}장 중 ${out}장을 맨 아래 '모르는 아이' 칸으로 뺐어요${fail ? ` · ${fail}장은 확인하지 못했어요(다시 누르면 이어서)` : ""}`);
  toast(out ? `${dog.name} 폴더에서 다른 아이로 보이는 사진 ${out}장을 뺐어요` : `${dog.name} 폴더는 모두 같은 아이로 보여요`);
  urlCache?.clear?.();
  await renderPhotos();
}

// ---- 사진으로 찾기: 명단에 없는 아이(호텔링 등)는 사진 몇 장을 주면 그 아이를 등록하고 그 아이만 찾음
$("#find-photo-file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const typed = prompt(`이 사진 ${files.length}장의 아이 이름을 적어 주세요.\n모르면 비워 두세요 (예: 호텔 손님으로 등록돼요)`, "");
  if (typed === null) return;
  let dog;
  const name = typed.trim();
  if (name) {
    dog = await findOrCreateDog(name);
    if (!dog) return;
  } else {
    const md = state.day.slice(5).replace("-", "");
    const n = state.dogs.filter((d) => d.name.startsWith(`호텔 손님 ${md}`)).length + 1;
    const { data, error } = await sb.from("dogs").insert({ name: `호텔 손님 ${md}-${n}`, auto: false, active: true, note: "호텔링 (이름 나중에)" })
      .select("*, dog_refs(id, path, created_at)").single();
    if (error || !data) { toast("등록하지 못했어요"); return; }
    state.dogs.push(data);
    state.dogs.sort(dogOrder);
    dog = data;
  }
  toast(`${dog.name} 사진 올리는 중…`);
  const added = await addRefs(dog, files);
  if (!added) { toast("사진을 올리지 못했어요. 다시 시도해 주세요"); return; }
  // 오늘 명단에 호텔링(H)으로 넣어 둠
  if (!state.attendance.has(dog.id)) {
    await sb.from("assignments").upsert({ day: state.day, dog_id: dog.id, hotel: true }, { onConflict: "day,dog_id", ignoreDuplicates: true });
    state.attendance.add(dog.id);
    state.hotel?.add?.(dog.id);
  }
  if (!state.find.includes(dog.id)) state.find.push(dog.id);
  toast(`${dog.name} 얼굴을 기억했어요 (${added}장). 이제 '찾기'를 누르면 이 아이 사진만 모아요`);
  renderFind();
  renderRoll();
});

// ---- 특정 아이만 찾기: 고른 아이만 찾고, 없으면 '찾는 아이가 아닌 사진'으로
// 이미 올려 둔 사진 중 아직 분류 안 된 것(대기·분류 안 됨·찾는 아이 아님)
const findable = () => (state.busy ? 0 : state.photos.filter((p) => p.status !== "done" && p.status !== "working").length);
function renderFind() {
  const box = $("#find-box");
  if (!box) return;
  const named = state.dogs.filter((d) => !d.auto).sort(dogOrder);
  const chips = state.find.map((id) => dogById(id)).filter(Boolean);
  box.classList.toggle("on", chips.length > 0);
  box.innerHTML = chips.length
    ? `<b>🔎 이번에 올리는 사진에서 이 아이만 찾아요:</b>
       ${chips.map((d) => `<span class="find-chip">${esc(d.name)}${breedTag(d)} <small>${refCount(d) ? `대표 ${refCount(d)}장` : "대표 사진 없음"}</small>
         <button class="find-ref" data-find-ref="${d.id}" title="${esc(d.name)} 대표 사진 추가">📷 추가</button><b class="x" data-unfind="${d.id}">×</b></span>`).join("")}
       <input id="find-input" list="find-list" placeholder="아이 더 추가">
       <button class="btn ghost mini find-photo">🏨 사진으로 아이 추가</button>
       ${findable() ? `<button id="find-go" class="btn primary">🔎 올린 사진 ${findable()}장에서 찾기</button>` : ""}
       <button id="find-off" class="btn ghost mini">끄기 (전체 분류)</button>
       <small class="muted find-tip">여러 마리를 같이 찾아도 돼요. 📷 추가로 그 아이 사진을 대표 사진에 더 넣으면 더 잘 찾아요(명단에도 그대로 저장)</small>`
    : `<button id="find-on" class="btn ghost mini">🔎 특정 아이만 찾기</button>
       <button class="btn ghost mini find-photo">🏨 사진으로 찾기 (호텔링·명단에 없는 아이)</button>
       <small class="muted">예: 사진 500장 중 꼬미만 찾기. 명단에 없는 호텔링 아이는 그 아이 사진 몇 장을 주면 그 아이만 모아요</small>`;
  box.insertAdjacentHTML("beforeend", `<datalist id="find-list">${named.map((d) => `<option value="${esc(d.name)}">`).join("")}</datalist>`);
  $("#drop-hint").textContent = chips.length
    ? `올리는 사진에서 ${chips.map((d) => d.name).join(", ")}만 찾아요.`
    : "여러 장을 한 번에 골라도 돼요. 올리면 AI가 강아지별로 묶어줘요.";
  const add = (v) => {
    const name = (v || "").trim();
    if (!name) return;
    const d = named.find((x) => norm(x.name) === norm(name)) || named.find((x) => baseName(x.name) === baseName(name));
    if (!d) { toast(`'${name}'은(는) 명단에 없어요`); return; }
    if (!refCount(d)) toast(`${d.name}은(는) 대표 사진이 없어서 찾기 어려워요. 명단에서 대표 사진을 먼저 넣어 주세요`);
    if (!state.find.includes(d.id)) state.find.push(d.id);
    renderFind();
  };
  $("#find-on")?.addEventListener("click", () => {
    const v = prompt("어떤 아이를 찾을까요? (이름)");
    add(v);
  });
  $("#find-input")?.addEventListener("change", (e) => add(e.target.value));
  $$(".find-photo", box).forEach((b) => b.addEventListener("click", () => $("#find-photo-file").click()));
  $("#find-off")?.addEventListener("click", () => { state.find = []; renderFind(); });
  $("#find-go")?.addEventListener("click", async () => {
    const names = chips.map((d) => d.name).join(", ");
    const ids = state.photos.filter((p) => p.status !== "done" && p.status !== "working").map((p) => p.id);
    if (!ids.length) { toast("찾을 사진이 없어요"); return; }
    if (!confirm(`아직 분류 안 된 사진 ${ids.length}장에서 ${names}만 찾을까요?\n없는 사진은 '찾는 아이가 아닌 사진'에 따로 모아 둬요.`)) return;
    for (let i = 0; i < ids.length; i += 200) {
      await sb.from("photos").update({ status: "pending", dog_ids: [], ai_note: null, find_dogs: state.find })
        .in("id", ids.slice(i, i + 200));
    }
    await loadPhotos();
    classifyPending();
  });
  $$("[data-find-ref]", box).forEach((b) => b.addEventListener("click", () => {
    refTarget = b.dataset.findRef;
    $("#ref-file").click();
  }));
  $$("[data-unfind]", box).forEach((x) => x.addEventListener("click", () => {
    state.find = state.find.filter((id) => id !== x.dataset.unfind);
    renderFind();
  }));
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
        list.map((c, i) => `${i + 1}. ${c.name}${tellApart(c) ? ` (${tellApart(c)})` : ""}`).join("\n"), "1");
      if (v === null) return false;
      same = list[+v - 1] || null;
    } else if (m.similar) {
      const list = m.similar.filter((c) => c.id !== dog.id);
      if (list.length) {
        const got = askSimilar(nm, list);
        if (got === undefined) return false;
        same = got;
      }
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
  // 직원이 뺀 사진(not_dogs)은 '아래로' 보낸 것이니 자동으로 다시 분류하지 않음
  const ids = state.photos.filter((p) => (p.status === "review" || p.status === "error") && p.confidence !== "manual" && !(p.not_dogs || []).length).map((p) => p.id);
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
// 이름 가족: 괄호·띄어쓰기 앞 첫 이름 ("토리 비숑", "토리(푸들)" → "토리")
const famKey = (s) => norm(String(s || "").replace(/\s*\(.*$/, "").trim().split(/\s+/)[0]);
// 앞 글자가 같으면 같은 이름으로 봄: 보드에 "라봉"이라고 써도 다이얼독의 "라봉이", "여름" ↔ "여름이"
//  (짧은 쪽이 2글자 이상일 때만 — "슈"처럼 한 글자는 똑같을 때만)
const famSame = (a, b) => { const x = famKey(a), y = famKey(b); if (!x || !y) return false; if (x === y) return true; const [s, l] = x.length <= y.length ? [x, y] : [y, x]; return s.length >= 2 && l.startsWith(s); };
const familyOf = (n) => (famKey(n) ? state.dogs.filter((d) => !d.auto && famSame(d.name, n)) : []);
// 같은 이름 아이: 이름은 짧게 두고 견종(breed)으로 구분 → 화면에 견종을 작게, 파일·폴더 이름에는 견종을 붙임
const dupName = (d) => !!d && !d.auto && state.dogs.some((x) => x.id !== d.id && !x.auto && x.active !== false && norm(x.name) === norm(d.name));
const breedTag = (d, always = false) => (d?.breed && (always || dupName(d)) ? ` <small class="breed">${esc(d.breed)}</small>` : "");
const breedText = (d) => (d?.breed && dupName(d) ? ` (${d.breed})` : "");
const fileLabel = (d) => (d?.breed && dupName(d) ? `${d.name}_${d.breed}` : d.name);
// 보드 표시: K = 유치원생(다이얼독 아이), H = 호텔링.
//  K → 다이얼독에 있는 아이 중에서만 찾음
//  H만 있고 다이얼독에 같은 이름 아이가 있음 → 유치원생이 호텔링 중인지, 다른 호텔 손님인지 물어봄 (hotelAsk)
//  H만 있고 다이얼독에 없음 → 호텔 손님 (다이얼독 아이와 연결하지 않음)
const isKinderName = (draft, n) => (draft?.kinder || []).some((k) => norm(k) === norm(n));
const sameFamDd = (n) => state.dogs.filter((d) => !d.auto && d.dd_pet_id && famSame(d.name, n));
function matchDog(n, draft = state.draft, usePick = true) {
  const pick = usePick && draft?.pick?.[norm(n)];
  if (pick === NEW_DOG) return { isNew: true };
  if (pick && dogById(pick)) return { dog: dogById(pick) };
  const r = matchDog0(n, draft, usePick);
  if (!draft) return r;
  const K = isKinderName(draft, n), H = isHotelName(draft, n), D = isDaycareName(draft, n);
  if (D && !K && !H) {
    // 데이케어 손님: 다이얼독 유치원생과는 연결하지 않고, 예전에 온 같은 이름 손님이 있으면 그 아이로
    const guests = familyOf(n).filter((d) => !d.dd_pet_id);
    if (guests.length === 1) return { dog: guests[0] };
    if (guests.length > 1) return { choices: guests };
    return {};
  }
  if (K) {
    const dd = (x) => x.filter((d) => d.dd_pet_id);
    if (r.choices) { const c = dd(r.choices); return c.length === 1 ? { dog: c[0] } : c.length ? { choices: c } : r; }
    if (r.similar) { const c = dd(r.similar); return c.length ? { similar: c } : r; }
    if (r.dog && !r.dog.dd_pet_id) { const c = sameFamDd(n); return c.length === 1 ? { dog: c[0] } : c.length ? { choices: c } : r; }
    return r;
  }
  if (H) {
    const ddFam = sameFamDd(n);
    if (ddFam.length && !draft.split?.has(norm(n))) return { hotelAsk: ddFam };
    // 다이얼독에 없는 호텔 손님: 다이얼독 아이와는 연결하지 않음
    const nonDd = (x) => x.filter((d) => !d.dd_pet_id);
    if (r.choices) { const c = nonDd(r.choices); return c.length === 1 ? { dog: c[0] } : c.length ? { choices: c } : {}; }
    if (r.dog?.dd_pet_id) return {};
  }
  return r;
}
function matchDog0(n, draft = state.draft, usePick = true) {
  const pick = usePick && draft?.pick?.[norm(n)];
  if (pick === NEW_DOG) return { isNew: true };
  if (pick && dogById(pick)) return { dog: dogById(pick) };
  const named = state.dogs.filter((d) => !d.auto);
  // 같은 이름 아이가 여럿이면 무조건 모두와 대조해서 고르게 함 (보드에 "토리 비숑"처럼 정확히 쓴 경우만 바로 연결)
  const fam = familyOf(n);
  if (fam.length > 1) {
    const exactOne = fam.filter((d) => norm(d.name) === norm(n));
    // "토리 비숑"처럼 견종까지 붙여 쓴 이름이 명단과 똑같을 때만 바로 연결 ("여름이"처럼 한 단어면 같은 이름 아이 모두 중에서 고르게)
    if (exactOne.length === 1 && /[\s(]/.test(String(n || "").trim())) return { dog: exactOne[0] };
    // 보드에 "구름 포메"처럼 견종까지 썼으면 그 아이로
    const raw = String(n || "");
    const rest = norm(raw.replace(/\s*\(.*$/, "").trim().split(/\s+/).slice(1).join("") + (raw.match(/\(([^)]*)\)/)?.[1] || ""));
    if (rest) {
      const byBreed = fam.filter((d) => d.breed && (norm(d.breed).includes(rest) || rest.includes(norm(d.breed))));
      if (byBreed.length === 1) return { dog: byBreed[0] };
    }
    return { choices: [...fam].sort((a, b) => refCount(b) - refCount(a) || a.name.localeCompare(b.name, "ko")) };
  }
  // 앞 글자가 같은 아이가 하나뿐이면 바로 그 아이 ("라봉" → "라봉이", "쪼복" → "쪼복이")
  if (fam.length === 1) return { dog: fam[0] };
  const exact = named.filter((d) => norm(d.name) === norm(n));
  const withRefs = (arr) => arr.filter((d) => refCount(d) > 0);
  if (withRefs(exact).length === 1) return { dog: withRefs(exact)[0] };
  const same = named.filter((d) => baseName(d.name) === baseName(n));
  const good = withRefs(same);
  if (good.length === 1) return { dog: good[0] };
  if (good.length > 1) return { choices: good };
  if (exact.length) return { dog: exact[0] };
  if (same.length) return same.length === 1 ? { dog: same[0] } : { choices: same };
  // 명단에 없는 이름이라도 비슷한 이름(다복이↔대박이, 장군↔김장군, 가지↔단지)이 있으면 새로 만들지 않고 물어봄
  const sim = similarDogs(n);
  if (sim.length) return { similar: sim };
  return {};
}
const NEW_DOG = "__new__";
// 한글을 자모로 풀어서 비교 (다복이/대박이처럼 모음 하나 다른 이름도 잡음)
const JA_I = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ", JA_M = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ",
  JA_F = ["", ..."ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"];
const jamo = (s) => [...s].map((ch) => {
  const c = ch.charCodeAt(0) - 0xac00;
  if (c < 0 || c > 11171) return ch;
  return JA_I[Math.floor(c / 588)] + JA_M[Math.floor((c % 588) / 28)] + JA_F[c % 28];
}).join("");
function editDist(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return dp[b.length];
}
function similarDogs(n, excludeId = null) {
  const b = baseName(n);
  if (!b) return [];
  const strip = (s) => s.replace(/이$/, "");
  const score = (x) => {
    if (x === b) return 0;
    if (strip(x) === strip(b) && strip(b)) return 1;                       // 다복 ↔ 다복이
    const [s, l] = x.length < b.length ? [x, b] : [b, x];
    if (l.includes(s) && l.length - s.length <= 2) return 2;               // 장군 ↔ 김장군, 슈 ↔ 슈슈
    const d = editDist(jamo(x), jamo(b));
    if (Math.min(x.length, b.length) >= 2 && d <= 2) return 2 + d;          // 가지 ↔ 단지, 다복이 ↔ 대박이
    return 99;
  };
  return state.dogs.filter((d) => !d.auto && d.id !== excludeId)
    .map((d) => [d, score(baseName(d.name))]).filter(([, s]) => s < 99)
    .sort((p, q) => p[1] - q[1] || (q[0].dd_pet_id ? 1 : 0) - (p[0].dd_pet_id ? 1 : 0) || refCount(q[0]) - refCount(p[0]))
    .slice(0, 4).map(([d]) => d);
}
const unresolved = (n, d) => { const m = matchDog(n, d); return !!(m.choices || m.similar || m.hotelAsk); };
// 프롬프트로 고르기: 비슷한 이름이 있으면 번호, 0이면 새 아이
function askSimilar(name, list) {
  const v = prompt(`'${name}'와(과) 이름이 비슷한 아이가 있어요. 같은 아이면 번호를, 다른 아이면 0을 눌러 주세요\n` +
    list.map((c, i) => `${i + 1}. ${c.name}${c.breed ? ` (${c.breed})` : ""}${c.dd_pet_id ? "" : " (다이얼독 없음)"}`).join("\n") + "\n0. 다른 아이 (새로 등록)", "1");
  if (v === null) return undefined;
  return list[+v - 1] || null;
}
const isNewName = (n) => { const m = matchDog(n); return !m.dog && !m.choices && !m.similar && !m.hotelAsk; };
const isHotelName = (draft, n) => (draft.hotel || []).some((h) => norm(h) === norm(n));
// D = 시간제 데이케어 손님 (다이얼독 유치원생 아님)
const isDaycareName = (draft, n) => (draft?.daycare || []).some((h) => norm(h) === norm(n));

async function renderRoll() {
  renderSide();
  const body = $("#roll-body");
  const count = $("#roll-count");

  // ① 보드에서 읽은 명단 확인·수정
  if (state.draft) {
    const d = state.draft;
    count.textContent = `${d.names.length}마리 읽음`;
    // N(처음 오는 아이)으로 켠 이름은 같은 이름 고르기에서 뺌
    const amb = d.names.map((n, i) => ({ n, i, c: matchDog(n, d, false).choices })).filter((x) => x.c && d.pick?.[norm(x.n)] !== NEW_DOG && !d.split?.has(norm(x.n)));
    const sims = d.names.map((n, i) => ({ n, i, c: matchDog(n, d, false).similar })).filter((x) => x.c);
    const ambRef = amb.length || sims.length
      ? await signed("refs", [...amb, ...sims].flatMap((x) => x.c.map((c) => c.ref_path).filter(Boolean))) : null;
    body.innerHTML = `
      ${amb.length ? `<div class="same-name">
        <b>이름이 같은 아이가 있어요 — 오늘 온 아이를 눌러 주세요</b>
        ${amb.map(({ n, i, c }) => `<div class="same-row"><span class="same-label">${esc(n)}${d.guessed?.has(norm(n)) && d.pick?.[norm(n)] ? ` <small class="muted">(최근 자주 온 아이로 골라 둠)</small>` : ""}</span>
          <div class="same-opts">${c.map((x) => `<button class="same-opt ${d.pick?.[norm(n)] === x.id ? "on" : ""}" data-same="${i}" data-id="${x.id}">
            ${x.ref_path ? `<img src="${ambRef(x.ref_path)}" alt="">` : ""}<span>${esc(x.name)}${breedTag(x, true)}</span></button>`).join("")}
            <button class="same-opt both" data-both="${i}"><span>${c.length === 2 ? "둘 다" : "모두"} 왔어요</span></button></div></div>`).join("")}
      </div>` : ""}
      ${sims.length ? `<div class="same-name similar">
        <b>비슷한 이름이 이미 있어요 — 같은 아이인지 골라 주세요</b>
        <small class="muted">보드에 쓴 이름이 명단(다이얼독) 이름과 조금 달라요. 같은 아이를 누르면 그 이름으로 묶이고, 정말 다른 아이면 '다른 아이'를 눌러 주세요.</small>
        ${sims.map(({ n, i, c }) => `<div class="same-row"><span class="same-label">${esc(n)}${isHotelName(d, n) ? ` <i class="tag-h">H</i>` : ""}</span>
          <div class="same-opts">${c.map((x) => `<button class="same-opt ${d.pick?.[norm(n)] === x.id ? "on" : ""}" data-same="${i}" data-id="${x.id}">
            ${x.ref_path ? `<img src="${ambRef(x.ref_path)}" alt="">` : ""}<span>${esc(x.name)}${breedTag(x)}${x.dd_pet_id ? "" : ` <small class="muted">(카톡)</small>`}</span></button>`).join("")}
            <button class="same-opt new ${d.pick?.[norm(n)] === NEW_DOG ? "on" : ""}" data-same="${i}" data-id="${NEW_DOG}"><span>다른 아이 (새로 등록)</span></button></div></div>`).join("")}
      </div>` : ""}
      ${d.img ? `<img class="board-preview" src="${d.img}" alt="출석 보드">${d.more ? `<p class="muted small" style="margin:-4px 0 8px">외 ${d.more}장 함께 읽음</p>` : ""}` : ""}
      <p class="small">읽은 이름이 맞는지 확인해 주세요. <b>이름을 누르면 고칠 수 있고</b>, ×로 뺄 수 있어요.
        <span class="tag-n">N</span>은 <b>처음 오는 아이</b>예요. 명단에 있는 아이와 이름이 같거나 비슷해도 N을 켜면 새 아이로 등록하고, 확정 후 대표 사진을 고를 수 있어요. 명단에 없는 이름은 자동으로 N이 켜져요.
        <span class="tag-k">K</span>는 <b>유치원생</b>(다이얼독 아이)이에요.
        <span class="tag-h">H</span> 표시는 호텔링이에요. H만 있는데 다이얼독에 같은 이름 유치원생이 있으면 <b>유치원생이 호텔링 중인지</b> 물어봐요. 둘 다 눌러서 켜고 끌 수 있어요. 호텔링 아이는 대표 사진 없이 분류하고, AI가 모르는 아이는 '모르는 아이' 칸에 비슷한 사진끼리 모아 둬요.
        ${d.unsure.length ? `<span class="q-legend">?</span> 표시는 글씨가 애매했던 이름이에요.` : ""}</p>
      <div class="chips roll-chips">${d.names.map((n, i) => `
        <span class="${d.unsure.includes(n) ? "unsure" : ""} ${isNewName(n) ? "new" : ""} ${isHotelName(d, n) ? "hotel" : ""}"><b data-k="${i}" class="k-toggle ${isKinderName(d, n) ? "on" : ""}" title="유치원생 켜기/끄기">K</b><b data-h="${i}" class="h-toggle" title="호텔링 켜기/끄기">H</b><b data-n="${i}" class="n-toggle" title="처음 오는 아이 켜기/끄기">N</b><b data-edit="${i}">${esc(n)}</b>${(() => {
          const m = matchDog(n, d);
          if (m.isNew) return "";
          if (m.hotelAsk) return `<select data-hpick="${i}" class="pick-dog ask-h"><option value="">유치원생 호텔링? 확인</option>${m.hotelAsk.map((c) => `<option value="${c.id}">유치원생 ${esc(c.name)}${c.breed ? ` (${esc(c.breed)})` : ""}가 호텔링 중</option>`).join("")}<option value="${NEW_DOG}">유치원생 아님 (호텔 손님)</option></select>`;
          if (m.similar) return `<small class="ask"> 비슷한 이름 확인 ↑</small>`;
          if (m.choices) return `<select data-pick="${i}" class="pick-dog"><option value="">어느 아이?</option>${m.choices.map((c) => `<option value="${c.id}">${esc(c.name)}${c.breed ? ` (${esc(c.breed)})` : ""}</option>`).join("")}</select>`;
          if (m.dog && (norm(m.dog.name) !== norm(n) || dupName(m.dog))) return `<small class="muted"> → ${esc(m.dog.name)}${esc(breedText(m.dog))}</small>`;
          return "";
        })()}<b class="x" data-del="${i}">×</b></span>`).join("")
        || `<span class="muted small">아직 이름이 없어요</span>`}</div>
      <form id="roll-add" class="row">
        <input id="roll-add-name" class="grow" placeholder="빠진 이름 추가">
        <button class="btn ghost" type="submit">추가</button>
      </form>
      <div class="row" style="margin-top:10px">
        <button id="roll-confirm" class="btn primary grow ${d.names.some((n) => unresolved(n, d)) ? "wait" : ""}" ${d.names.length ? "" : "disabled"}>${(() => { const u = d.names.filter((n) => unresolved(n, d)); return u.length ? `${u.map(esc).slice(0, 3).join(", ")}${u.length > 3 ? ` 외 ${u.length - 3}` : ""} — 누구인지 골라 주세요` : `명단 확정 (${d.names.length}마리)`; })()}</button>
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
    $$("[data-k]", body).forEach((el) => el.addEventListener("click", () => {
      const n = d.names[+el.dataset.k];
      d.kinder = isKinderName(d, n) ? (d.kinder || []).filter((k) => norm(k) !== norm(n)) : [...(d.kinder || []), n];
      renderRoll();
    }));
    $$("[data-hpick]", body).forEach((el) => el.addEventListener("change", () => {
      if (!el.value) return;
      const n = d.names[+el.dataset.hpick];
      d.pick = { ...(d.pick || {}), [norm(n)]: el.value === NEW_DOG ? hotelGuestFor(n) : el.value };
      renderRoll();
    }));
    $$("[data-both]", body).forEach((el) => el.addEventListener("click", () => {
      const n = d.names[+el.dataset.both];
      const c = matchDog(n, d, false).choices;
      if (c) splitBoth(d, n, c);
      renderRoll();
    }));
    $$("[data-n]", body).forEach((el) => el.addEventListener("click", () => {
      const n = d.names[+el.dataset.n], k = norm(n);
      d.pick = d.pick || {};
      if (d.pick[k] === NEW_DOG) delete d.pick[k];   // N 끄기 → 명단의 아이와 다시 연결
      else if (isNewName(n)) { toast("명단에 없는 이름이라 처음 오는 아이로 등록돼요"); return; }
      else d.pick[k] = NEW_DOG;                      // N 켜기 → 이름이 같아도 새 아이로
      d.guessed?.delete(k);
      renderRoll();
    }));
    $$("[data-dc]", body).forEach((el) => el.addEventListener("click", () => {
      const n = d.names[+el.dataset.dc];
      d.daycare = isDaycareName(d, n) ? (d.daycare || []).filter((h) => norm(h) !== norm(n)) : [...(d.daycare || []), n];
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
    $("#roll-confirm").addEventListener("click", () => {
      // 아직 고르지 않은 이름이 있으면 그 질문으로 데려가기
      const u = d.names.findIndex((n) => unresolved(n, d));
      if (u < 0) return confirmRoll();
      const n = d.names[u], m = matchDog(n, d);
      const target = m.similar || m.choices ? $(`.same-name [data-same="${u}"]`, body) || $(`[data-pick="${u}"]`, body) : $(`[data-hpick="${u}"]`, body);
      const el = target?.closest(".same-row") || target || body;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
      if (target?.tagName === "SELECT") target.focus();
      toast(`'${n}'이(가) 어느 아이인지 먼저 골라 주세요`);
    });
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
  const hotelDogs = roll.filter((dg) => state.hotel.has(dg.id) && !(state.first.has(dg.id) && refCount(dg) < 3));
  const known = roll.filter((dg) => refCount(dg) && !state.hotel.has(dg.id) && !(state.first.has(dg.id) && refCount(dg) < 3));
  const need = roll.filter((dg) => (!refCount(dg) && !state.hotel.has(dg.id)) || (state.first.has(dg.id) && refCount(dg) < 3));
  count.textContent = `${roll.length}마리${hotelDogs.length ? ` (호텔링 ${hotelDogs.length})` : ""}${need.length ? ` · 대표 사진 필요 ${need.length}` : ""}`;
  const ref = await signed("refs", [...known, ...hotelDogs].map((dg) => dg.ref_path));
  const needRef = await signed("refs", need.map((dg) => dg.ref_path).filter(Boolean));
  body.innerHTML = `
    ${need.length ? `<p class="small"><b>처음 오는 아이</b>예요. <b>대표 사진</b>을 골라 주세요. 오늘 올라온 사진에서 고르거나 파일로 올릴 수 있어요. 정면·옆·뒤 등 <b>3장 이상</b> 고를수록 더 잘 알아봐요.</p>
    <div class="need-list">${need.map((dg) => `
      <div class="need-row">${dg.ref_path ? `<img class="avatar" src="${needRef(dg.ref_path)}" alt="">` : `<span class="avatar"></span>`}
        <b class="grow"><span class="tag-n">N</span>${state.hotel.has(dg.id) ? `<span class="tag-h">H</span>` : ""}<span class="swap-name" data-swap="${dg.id}" title="다른 아이로 바꾸기">${esc(dg.name)}</span>${refCount(dg) ? ` <small class="muted">${refCount(dg)}장</small>` : ""}</b>
        <button class="btn primary sm" data-ref-pick="${dg.id}">오늘 사진에서 고르기</button>
        <button class="btn ghost sm" data-ref-for="${dg.id}">파일</button></div>`).join("")}</div>` : ""}
    ${known.length ? `<div class="known-list">${known.map((dg) => `
      <button class="known" data-swap="${dg.id}" title="눌러서 다른 아이로 바꾸기"><img src="${ref(dg.ref_path)}" alt="">${esc(dg.name)}${familyOf(dg.name).length > 1 ? `<small class="fam-n">${familyOf(dg.name).length}</small>` : `<i>✓</i>`}</button>`).join("")}</div>` : ""}
    ${hotelDogs.length ? `<p class="small" style="margin:10px 0 4px">🏨 <b>호텔링</b> · 대표 사진 없이 분류해요. AI가 모르는 아이는 '모르는 아이' 칸에 모이니, 묶음째 골라 이 이름으로 옮기면 얼굴도 기억해요.</p>
    <div class="known-list">${hotelDogs.map((dg) => `
      <button class="known hotel" data-swap="${dg.id}" title="눌러서 다른 아이로 바꾸기">${dg.ref_path ? `<img src="${ref(dg.ref_path)}" alt="">` : ""}<b class="tag-h">H</b>${esc(dg.name)}</button>`).join("")}</div>` : ""}
    <p class="muted small" style="margin:10px 0 0">이름을 누르면 <b>다른 아이로 바꿀 수 있어요</b>. 오늘 그 아이로 분류된 사진도 함께 옮겨져요.${roll.some((dg) => familyOf(dg.name).length > 1) ? ` 숫자 표시는 이름이 같은 아이가 여럿이라는 뜻이에요.` : ""}</p>
    <div class="row" style="margin-top:10px">
      <button id="roll-edit" class="btn ghost sm">명단 수정</button>
      <button id="roll-board" class="btn ghost sm">보드·캡처 다시 읽기</button>
    </div>`;
  $$("[data-ref-pick]", body).forEach((b) => b.addEventListener("click", () => openRefPicker(dogById(b.dataset.refPick))));
  $$("[data-ref-for]", body).forEach((b) => b.addEventListener("click", () => {
    refTarget = b.dataset.refFor;
    $("#ref-file").click();
  }));
  $$("[data-swap]", body).forEach((b) => b.addEventListener("click", () => openSwap(dogById(b.dataset.swap))));
  $("#roll-edit").addEventListener("click", () => {
    state.draft = { names: roll.map((dg) => dg.name), unsure: [], img: "", hotel: hotelDogs.map((dg) => dg.name),
      pick: Object.fromEntries(roll.map((dg) => [norm(dg.name), dg.id])) };
    renderRoll();
  });
  $("#roll-board").addEventListener("click", () => $("#board-file").click());
}

// 오늘 올라온 사진에서 대표 사진 고르기: 고른 사진은 대표 사진이 되고, 그 사진도 이 아이로 분류
async function openRefPicker(dog) {
  if (!dog) return;
  document.querySelector(".rc-overlay")?.remove();
  const ov = document.createElement("div");
  ov.className = "rc-overlay";
  document.body.appendChild(ov);
  const isOpen = (p) => !p.dog_ids.length || p.status === "review" || p.status === "error";
  const mine = state.photos.filter((p) => p.dog_ids.includes(dog.id));
  const open = state.photos.filter((p) => !p.dog_ids.includes(dog.id) && isOpen(p));
  const rest = state.photos.filter((p) => !p.dog_ids.includes(dog.id) && !isOpen(p)).slice(0, 300);
  const thumb = await signed("photos", [...mine, ...open, ...rest].map((p) => p.thumb_path));
  const picked = new Set();
  const tile = (p) => `<button class="rc-tile" data-rp="${p.id}"><img loading="lazy" src="${thumb(p.thumb_path)}" class="rot${p.rotation || 0}" alt=""><span class="rc-check"></span></button>`;
  const sec = (title, list) => list.length ? `<div class="rc-group"><div class="rc-ghead"><b class="grow">${title} <span class="muted">${list.length}장</span></b></div><div class="rc-grid">${list.map(tile).join("")}</div></div>` : "";
  ov.innerHTML = `<div class="rc-box">
    <div class="rc-head"><div class="grow"><b>${esc(dog.name)} 대표 사진 고르기</b>
      <small class="muted">이 아이가 잘 보이는 사진을 눌러 주세요. 정면·옆·뒤 등 여러 각도로 3장 이상이면 좋아요. 다른 아이가 같이 나온 사진은 피해 주세요.</small></div>
      <button class="btn ghost sm" data-x>닫기</button></div>
    <div class="rc-body">
      ${sec(`이미 ${esc(dog.name)}(으)로 분류된 사진`, mine)}
      ${sec("모르는 아이·분류 안 된 사진", open)}
      ${sec("다른 사진", rest)}
      ${!mine.length && !open.length && !rest.length ? `<p class="muted">오늘 올라온 사진이 없어요. '파일'로 올려 주세요.</p>` : ""}
    </div>
    <div class="rc-foot"><button class="btn ghost sm" data-x>닫기</button>
      <button class="btn primary sm" data-save disabled>대표 사진으로 저장</button></div></div>`;
  const save = ov.querySelector("[data-save]");
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  $$("[data-x]", ov).forEach((b) => b.addEventListener("click", close));
  $$("[data-rp]", ov).forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.rp;
    picked.has(id) ? picked.delete(id) : picked.add(id);
    b.classList.toggle("on", picked.has(id));
    b.querySelector(".rc-check").textContent = picked.has(id) ? "✓" : "";
    save.disabled = !picked.size;
    save.textContent = picked.size ? `${picked.size}장 대표 사진으로 저장` : "대표 사진으로 저장";
  }));
  save.addEventListener("click", async () => {
    save.disabled = true; save.textContent = "저장 중…";
    const list = state.photos.filter((p) => picked.has(p.id));
    const full = await signed("photos", list.map((p) => p.path));
    let n = 0;
    for (const p of list) {
      try {
        let blob = await fetch(full(p.path)).then((r) => r.blob());
        if (p.rotation) blob = await rotateBlob(blob, p.rotation);
        n += await addRefs(dog, [blob]);
        // 그 사진도 이 아이로 (다른 아이가 같이 있으면 그대로 두고 더함)
        const ids = [...new Set([...(isOpen(p) ? [] : p.dog_ids), dog.id])];
        const upd = { dog_ids: ids, status: "done", confidence: "manual", ai_note: "대표 사진으로 고름", not_dogs: (p.not_dogs || []).filter((x) => x !== dog.id) };
        await sb.from("photos").update(upd).eq("id", p.id);
        Object.assign(p, upd);
      } catch (err) { console.error(err); }
    }
    close();
    toast(n ? `${dog.name} 대표 사진 ${n}장 저장! 분류 안 된 사진을 이 얼굴로 다시 살펴볼게요` : "저장하지 못했어요. 다시 시도해 주세요.");
    await renderRoll();
    await renderPhotos();
    if (n) queueRescan();
  });
}
async function rotateBlob(blob, deg) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  const side = deg % 180 !== 0;
  c.width = side ? bmp.height : bmp.width; c.height = side ? bmp.width : bmp.height;
  const g = c.getContext("2d");
  g.translate(c.width / 2, c.height / 2); g.rotate((deg * Math.PI) / 180);
  g.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  bmp.close?.();
  return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
}

// 확정된 명단에서 한 아이를 다른 아이로 바꾸기 (같은 이름 아이·비슷한 이름 먼저 보여 줌)
async function openSwap(from) {
  if (!from) return;
  document.querySelector(".rc-overlay")?.remove();
  const ov = document.createElement("div");
  ov.className = "rc-overlay";
  document.body.appendChild(ov);
  const fam = familyOf(from.name).filter((d) => d.id !== from.id);
  const sim = similarDogs(from.name, from.id).filter((d) => !fam.some((f) => f.id === d.id));
  const cands = [...fam, ...sim];
  const ref = await signed("refs", [from, ...cands].map((d) => d.ref_path));
  const nPhotos = state.photos.filter((p) => p.dog_ids.includes(from.id)).length;
  const opt = (d) => `<button class="same-opt" data-to="${d.id}">${d.ref_path ? `<img src="${ref(d.ref_path)}" alt="">` : `<span class="avatar"></span>`}<span>${esc(d.name)}${breedTag(d)}${state.attendance.has(d.id) ? ` <small class="muted">(이미 명단)</small>` : ""}</span></button>`;
  ov.innerHTML = `<div class="rc-box swap-box">
    <div class="rc-head"><div class="grow"><b>'${esc(from.name)}'을(를) 다른 아이로 바꾸기</b>
      <small class="muted">오늘 ${esc(from.name)}(으)로 분류된 사진 ${nPhotos}장도 바꾼 아이로 함께 옮겨요.</small></div>
      <button class="btn ghost sm" data-x>닫기</button></div>
    <div class="rc-body">
      <div class="swap-from">${from.ref_path ? `<img src="${ref(from.ref_path)}" alt="">` : `<span class="avatar"></span>`}<b>${esc(from.name)}</b><span class="muted">→</span></div>
      ${fam.length ? `<p class="small"><b>이름이 같은 아이</b></p><div class="same-opts">${fam.map(opt).join("")}</div>` : ""}
      ${sim.length ? `<p class="small" style="margin-top:14px"><b>비슷한 이름</b></p><div class="same-opts">${sim.map(opt).join("")}</div>` : ""}
      <form class="row swap-search" style="margin-top:16px">
        <input class="grow" list="swap-names" placeholder="다른 이름 찾기 (예: 토리 비숑)">
        <datalist id="swap-names">${state.dogs.filter((d) => !d.auto && d.id !== from.id).map((d) => `<option value="${esc(d.name)}">`).join("")}</datalist>
        <button class="btn primary sm" type="submit">바꾸기</button>
      </form>
    </div></div>`;
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.querySelector("[data-x]").addEventListener("click", close);
  $$("[data-to]", ov).forEach((b) => b.addEventListener("click", async () => { close(); await swapDog(from, dogById(b.dataset.to)); }));
  ov.querySelector(".swap-search").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = ov.querySelector(".swap-search input").value.trim();
    if (!v) return;
    const to = await findOrCreateDog(v);
    if (!to || to.id === from.id) return;
    close();
    await swapDog(from, to);
  });
}
async function swapDog(from, to) {
  if (!from || !to || from.id === to.id) return;
  toast(`${from.name} → ${to.name} 바꾸는 중…`);
  try {
    const wasHotel = state.hotel.has(from.id);
    await sb.from("assignments").delete().eq("day", state.day).eq("dog_id", from.id);
    if (!state.attendance.has(to.id)) {
      const { error } = await sb.from("assignments").insert({ day: state.day, dog_id: to.id, hotel: wasHotel });
      if (error) throw error;
    }
    state.attendance.delete(from.id); state.attendance.add(to.id);
    if (wasHotel) { state.hotel.delete(from.id); state.hotel.add(to.id); }
    if (!to.active) { await sb.from("dogs").update({ active: true }).eq("id", to.id); to.active = true; }
    // 오늘 그 아이로 분류된 사진을 바꾼 아이로
    const moved = state.photos.filter((p) => p.dog_ids.includes(from.id));
    await pool(moved, 6, async (p) => {
      const ids = [...new Set(p.dog_ids.map((d) => (d === from.id ? to.id : d)))];
      const not = (p.not_dogs || []).filter((d) => d !== to.id);
      await sb.from("photos").update({ dog_ids: ids, not_dogs: not }).eq("id", p.id);
      p.dog_ids = ids; p.not_dogs = not;
    });
    // 오늘 잘못된 아이 이름으로 배운 학습 사진·실수 기록도 옮김 (원래 아이 얼굴이 섞이지 않게)
    const since = new Date(`${state.day}T00:00:00+09:00`).toISOString();
    await sb.from("dog_refs").update({ dog_id: to.id }).eq("dog_id", from.id).like("path", "%-learn-%").gte("created_at", since);
    await sb.from("lessons").update({ right_dog: to.id }).eq("right_dog", from.id).gte("created_at", since);
    await loadDogs();
    toast(`${from.name} → ${to.name}(으)로 바꿨어요${moved.length ? ` · 사진 ${moved.length}장도 옮김` : ""}`);
  } catch (err) {
    console.error(err);
    toast("바꾸지 못했어요. 다시 시도해 주세요.");
  }
  await renderRoll();
  await renderPhotos();
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
    state.draft = { names: data.names || [], unsure: data.unsure || [], hotel: data.hotel || [], kinder: data.kinder || [], daycare: data.daycare || [], img: URL.createObjectURL(blobs[0]), more: blobs.length - 1 };
    if (!state.draft.names.length) toast("이름을 찾지 못했어요. 직접 추가해 주세요.");
    askHotelKids(state.draft);
    await suggestPicks(state.draft);
  } catch (err) {
    toast(err.message || "읽지 못했어요. 다시 시도해 주세요.");
    if (!state.draft) state.draft = { names: [], unsure: [], img: "" };
  }
  renderRoll();
});

// '유치원생 아님 (호텔 손님)': 다이얼독에 없는 같은 이름 아이(예전 호텔 손님)가 하나면 그 아이로, 아니면 새로 등록
function hotelGuestFor(n) {
  const old = state.dogs.filter((d) => !d.auto && !d.dd_pet_id && famSame(d.name, n));
  return old.length === 1 ? old[0].id : NEW_DOG;
}
// 보드를 읽은 뒤: H만 있고 다이얼독에 같은 이름 유치원생이 있으면 번호로 물어봄
function askHotelKids(d) {
  d.pick = d.pick || {};
  for (const n of d.names) {
    if (d.pick[norm(n)]) continue;
    const m = matchDog(n, d);
    if (!m.hotelAsk) continue;
    const list = m.hotelAsk;
    const v = prompt(`'${n}'은(는) H(호텔링)로 적혀 있는데, 다이얼독에 같은 이름 유치원생이 있어요\n` +
      list.map((c, i) => `${i + 1}. 유치원생 ${c.name}${c.breed ? ` (${c.breed})` : ""}가 호텔링 중`).join("\n") +
      `\n0. 유치원생 아님 (호텔 손님)`, "0");
    if (v === null) continue;
    d.pick[norm(n)] = String(v).trim() === "0" ? hotelGuestFor(n) : (list[+v - 1]?.id || d.pick[norm(n)]);
    if (!d.pick[norm(n)]) delete d.pick[norm(n)];
  }
}
// 같은 이름 아이가 둘 다(모두) 온 날: 명단의 그 이름을 아이마다 한 칸씩으로 나눔 ("여름" → "여름 페키니즈", "여름 포메라니안")
function splitBoth(d, n, list) {
  const i = d.names.findIndex((x) => norm(x) === norm(n));
  if (i < 0) return;
  const labels = list.map((c) => (dupName(c) && c.breed ? `${c.name} ${c.breed}` : c.name));
  d.pick = d.pick || {};
  delete d.pick[norm(n)];
  const hotel = isHotelName(d, n);
  d.names.splice(i, 1, ...labels.filter((l) => !d.names.some((x, j) => j !== i && norm(x) === norm(l))));
  list.forEach((c, k) => { d.pick[norm(labels[k])] = c.id; });
  d.split = new Set([...(d.split || []), ...labels.map(norm)]); // 둘 다 고른 이름은 다시 묻지 않음
  if (hotel) d.hotel = [...(d.hotel || []).filter((h) => norm(h) !== norm(n)), ...labels];
}
// 같은 이름 아이 고르기 창에 쓰는 구분 (견종, 없으면 생김새 메모)
// 이름이 다르면 이름도 함께 (뽀송 / 뽀송 비숑), 다이얼독에 없는 아이는 '다이얼독 없음'
const tellApart = (c, asked) => {
  const bits = [];
  if (asked && norm(c.name) !== norm(asked)) bits.push(c.name);
  if (c.breed) bits.push(c.breed); else if (c.note) bits.push(String(c.note).slice(0, 24));
  if (!c.dd_pet_id) bits.push("다이얼독 없음");
  return bits.join(" · ");
};
// 이름이 같은 아이가 여럿이면: 하나씩 번호로 물어봄 ("1. 페키니즈 2. 포메라니안"). 최근 자주 온 아이를 1번(기본값)으로
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
    const list = [...c].sort((a, b) => (score.get(b.id) || 0) - (score.get(a.id) || 0));
    const all = list.length + 1;
    const v = prompt(`'${n}' 이름의 아이가 ${list.length}마리예요. 오늘 온 아이 번호를 눌러 주세요\n` +
      list.map((x, i) => `${i + 1}. ${tellApart(x, n) || x.name}${score.get(x.id) ? ` (최근 ${score.get(x.id)}번 옴)` : ""}`).join("\n") +
      `\n${all}. ${list.length === 2 ? "둘 다" : "모두"} 왔어요` +
      `\n0. ${list.length === 2 ? "둘 다" : "모두"} 아님 (처음 오는 아이)`, "1");
    if (v === null) continue; // 취소하면 아래 명단에서 직접 고르게
    if (String(v).trim() === "0") { d.pick[norm(n)] = NEW_DOG; continue; }
    if (+v === all) { splitBoth(d, n, list); continue; }
    const got = list[+v - 1];
    if (got) d.pick[norm(n)] = got.id;
  }
}

// 명단 확정 → 아는 아이는 연결, 처음 보는 이름은 새로 등록
async function confirmRoll() {
  let hadRoll = true;
  const btn = $("#roll-confirm");
  btn.disabled = true;
  btn.textContent = "저장 중…";
  try {
    const ids = [];
    const hotelIds = new Set();
    const daycareIds = new Set();
    const firstIds = new Set();
    for (const name of state.draft.names) {
      let dog = matchDog(name).dog;
      if (!dog) {
        let nm = name;
        // 오늘 이미 '처음 오는 아이'로 등록한 같은 이름 아이가 있으면 또 만들지 않고 그 아이로 (다시 확정해도 두 번 생기지 않게)
        const todayNew = state.dogs.find((x) => !x.auto && !x.dd_pet_id && norm(x.name) === norm(nm) &&
          x.created_at && new Date(Date.parse(x.created_at) + 9 * 3600e3).toISOString().slice(0, 10) === kstToday());
        if (todayNew) { dog = todayNew; ids.push(dog.id); if (isHotelName(state.draft, name)) hotelIds.add(dog.id); if (isDaycareName(state.draft, name)) daycareIds.add(dog.id); continue; }
        const dayGuest = isDaycareName(state.draft, name) && !isKinderName(state.draft, name) && !isHotelName(state.draft, name);
        const guest = (isHotelName(state.draft, name) || dayGuest) && !isKinderName(state.draft, name);
        if (!guest && state.dogs.some((x) => !x.auto && norm(x.name) === norm(nm))) {
          const v = prompt(`'${name}' 이름의 아이가 이미 명단에 있어요.\n처음 오는 아이를 구분할 이름을 적어 주세요 (예: ${name} 푸들)`, `${name} `);
          if (v === null || !v.trim()) throw new Error("cancel");
          nm = v.trim();
        }
        const { data, error } = await sb.from("dogs").insert({ name: nm, auto: false, active: true, ...(guest ? { breed: dayGuest ? "데이케어 손님" : "호텔 손님" } : {}) }).select().single();
        if (error) throw error;
        dog = data;
        state.dogs.push(dog);
        firstIds.add(dog.id);
      } else if (!dog.active) {
        await sb.from("dogs").update({ active: true }).eq("id", dog.id);
        dog.active = true;
      }
      ids.push(dog.id);
      if (isHotelName(state.draft, name)) hotelIds.add(dog.id);
      if (isDaycareName(state.draft, name)) daycareIds.add(dog.id);
    }
    hadRoll = state.attendance.size > 0;
    // 사진으로 넣어 둔 호텔링 아이(보드에 없음)는 명단을 확정해도 그대로 둠
    for (const id of state.hotel) if (state.attendance.has(id) && !ids.includes(id) && !dogById(id)?.dd_pet_id) { ids.push(id); hotelIds.add(id); }
    await sb.from("assignments").delete().eq("day", state.day);
    const uniq = [...new Set(ids)];
    if (uniq.length) {
      // 다시 확정해도 오늘 처음 온 아이 표시는 유지
      for (const id of state.first) if (uniq.includes(id)) firstIds.add(id);
      const { error } = await sb.from("assignments").insert(uniq.map((dog_id) => ({ day: state.day, dog_id, hotel: hotelIds.has(dog_id), daycare: daycareIds.has(dog_id), first: firstIds.has(dog_id) })));
      if (error) throw error;
    }
    state.attendance = new Set(uniq);
    state.hotel = hotelIds;
    state.first = firstIds;
    state.draft = null;
    state.dogs.sort(dogOrder);
    const need = uniq.filter((id) => !dogById(id)?.ref_path && !hotelIds.has(id) && !daycareIds.has(id)).length;
    toast(need ? `명단 저장! 대표 사진이 필요한 아이 ${need}마리` : "명단 저장! 모두 아는 얼굴이에요");
  } catch (err) {
    if (err?.message === "cancel") { btn.disabled = false; renderRoll(); return; }
    console.error(err);
    toast("저장하지 못했어요. 다시 시도해 주세요.");
  }
  // 명단 없이 먼저 분류됐던 사진(직원이 고친 건 빼고)은 명단 기준으로 다시 분류
  try {
    if (!hadRoll) {
      const { data: redo } = await sb.from("photos").select("id").eq("day", state.day).in("status", ["done", "review", "error"]).neq("confidence", "manual");
      let ids = (redo || []).map((x) => x.id);
      // 이미 분류된 사진은 물어보고 나서만 다시 분류
      if (ids.length && !confirm(`명단 없이 먼저 분류된 사진 ${ids.length}장이 있어요.\n명단 기준으로 다시 분류할까요?\n\n(취소하면 지금 분류 그대로 둬요. 직원이 고친 사진은 어느 쪽이든 그대로예요)`)) ids = [];
      for (let i = 0; i < ids.length; i += 200) await sb.from("photos").update({ status: "pending", dog_ids: [] }).in("id", ids.slice(i, i + 200));
      if (ids.length) toast(`명단 없이 분류됐던 사진 ${ids.length}장을 명단 기준으로 다시 분류할게요`);
    }
  } catch { /* 무시 */ }
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
  renderFind();
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
      st.vec = await fingerprint(small);
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
      const ins = await sb.from("photos").insert({ id, day, path, thumb_path: thumbPath, taken_at: taken, practice: !!state.practice, find_dogs: state.find, ...st });
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
// 사진에 지문이 없으면 만들어서 저장 (학습 모드에서 후보를 추리는 데 필요)
async function ensureVec(id) {
  try {
    const { data: p } = await sb.from("photos").select("thumb_path, vec").eq("id", id).single();
    if (!p || p.vec) return;
    const { data: blob } = await sb.storage.from("photos").download(p.thumb_path);
    const v = blob && await fingerprint(blob);
    if (v) await sb.from("photos").update({ vec: v }).eq("id", id);
  } catch (e) { console.warn(e); }
}
async function classifyPending() {
  if (state.busy) return;
  const { count: waiting } = await sb.from("photos").select("id", { count: "exact", head: true }).eq("day", state.day).eq("practice", !!state.practice).eq("status", "pending");
  if (!waiting) { $("#progress").classList.add("hidden"); await render(); return; }
  // 명단부터: 오늘 온 아이들 안에서만 찾아야 빠르고 정확함
  if (state.draft && !state.find.length) {
    progress(`사진 ${waiting}장이 기다리고 있어요`, 0, waiting,
      "위의 '명단 확정'을 먼저 눌러 주세요. 확정하면 오늘 온 아이들 안에서만 찾아서 훨씬 빠르고 정확해요. 누르면 바로 이어서 분류해요.");
    await render();
    return;
  }
  // 명단 없음 = 학습 모드: 사진 지문으로 전체 아이 중 닮은 10마리를 추려서 비교 (지문이 없으면 먼저 만듦)
  state.busy = true;
  await loadPractice();
  const noRoll = !state.attendance.size || state.practice;
  lastError = "";
  // 서버 작업자와 나눠서 처리: 12장씩 '가져가서' 처리하므로 같은 사진을 두 번 분류하지 않음
  let total = waiting, ok = 0, fail = 0, done = 0, stop = false, saved = 0, first = true;
  // 폰: 업로드가 끝나면 분류는 서버 작업자가 이어서 하므로 화면을 내려도 됨
  const phone = matchMedia("(max-width: 760px), (pointer: coarse)").matches;
  const tick = () => progress(phone ? "AI가 강아지별로 묶는 중… 화면을 내려도 계속 분류돼요" : "AI가 강아지별로 묶는 중… 창을 닫지 마세요", Math.min(done, total), total,
    phone ? "올리기는 끝났어요. 폰 화면을 꺼도 분류는 자동으로 이어져요." :
    state.find.length ? `${state.find.map((id) => dogById(id)?.name).filter(Boolean).join(", ")}만 찾는 중이에요. 없는 사진은 아래 '찾는 아이가 아닌 사진'에 모여요.`
    : noRoll ? "학습 모드(명단 없음): 사진 지문으로 닮은 아이 10마리를 추려서 비교해요. 틀린 건 고쳐 주면 그대로 학습해요."
           : `아래 목록이 조금씩 채워져요${saved ? ` · 연속 사진 ${saved}장은 같은 장면이라 함께 처리` : ""}`);
  tick();
  while (!stop) {
    const { data: batch, error } = await sb.rpc("claim_pending", { p_day: state.day, p_n: first ? 4 : 12 });
    if (error || !batch?.length) break;
    // 연속으로 찍은 거의 같은 사진(5초 안, 이미지 거의 같음)은 가장 선명한 1장만 판단하고 결과를 나머지에 적용
    const sorted = [...batch].sort((a, b) => String(a.taken_at || "").localeCompare(String(b.taken_at || "")));
    const groups = [];
    for (const p of sorted) {
      const g = groups[groups.length - 1];
      const last = g?.[g.length - 1];
      if (g && p.taken_at && last?.taken_at && Math.abs(new Date(p.taken_at) - new Date(last.taken_at)) <= 5000 && hamming(g[0].phash, p.phash) <= 12) g.push(p);
      else groups.push([p]);
    }
    const runGroup = async (g) => {
      if (stop) { await sb.from("photos").update({ status: "pending", claimed_at: null }).in("id", g.map((x) => x.id)); return; }
      const rep = g.reduce((m, x) => ((x.sharp || 0) > (m.sharp || 0) ? x : m), g[0]);
      const sibs = g.filter((x) => x.id !== rep.id).map((x) => x.id);
      if (noRoll) await ensureVec(rep.id);
      if (await classifyOne(rep.id)) {
        ok++;
        if (sibs.length) {
          // 분류만 복사 (방향은 사진마다 서버가 따로 확인). 직원이 고친 사진은 건드리지 않음
          const { data: r } = await sb.from("photos").select("dog_ids, status, confidence").eq("id", rep.id).single();
          if (r) { await sb.from("photos").update({ ...r, ai_note: "연속 사진: 바로 앞 사진과 같은 분류", claimed_at: null }).in("id", sibs).or("confidence.is.null,confidence.neq.manual"); ok += sibs.length; saved += sibs.length; }
        }
      } else {
        await sb.from("photos").update({ status: "pending", claimed_at: null }).in("id", g.map((x) => x.id)).eq("status", "working");
        if (++fail >= 3 && !ok) stop = true;    // 설정 문제면 바로 멈춤
      }
      done += g.length;
      tick();
    };
    // 처음 몇 장은 한 장씩(새 아이 그룹이 겹치지 않게), 그다음은 6장씩 동시에
    if (first) { for (const g of groups) await runGroup(g); first = false; }
    else await pool(groups, 6, runGroup);
    if (state.tab === "photos") { await loadDogs(); await loadPhotos(); await renderPhotos(); }
    const { count: left } = await sb.from("photos").select("id", { count: "exact", head: true }).eq("day", state.day).eq("practice", !!state.practice).in("status", ["pending", "working"]);
    total = done + (left || 0);
  }
  state.busy = false;
  if (rescanAgain) { rescanAgain = false; queueRescan(); }
  if (fail && lastError) {
    progress("분류를 멈췄어요", ok, total, lastError);
  } else {
    progress(`완료! ${ok}장 분류했어요`, total, total, saved ? `연속 사진 ${saved}장은 함께 처리해서 시간을 줄였어요` : "");
    setTimeout(() => $("#progress").classList.add("hidden"), 4000);
  }
  await render();
}

/* ---------- 다시 분류 미리보기: 어디 넣을지 보여주고 확인 후 넣기 ---------- */
async function classifyPreview(photoId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await Promise.race([
      sb.functions.invoke("classify", { body: { photo_id: photoId, preview: true } }),
      sleep(120000).then(() => ({ error: { context: { status: 504 } } })),
    ]);
    if (!res.error && res.data?.preview) return res.data;
    const status = res.error?.context?.status;
    if (status === 503 || status === 429 || status === 504 || status === 546) { await sleep(2000 * 2 ** attempt); continue; }
    return null;
  }
  return null;
}
async function previewReclassify(list) {
  if (state.busy || !list?.length) return;
  state.busy = true;
  await render();
  // 거의 같은 연속 사진은 한 장만 물어보고 같이 처리
  const groups = burstGroups(list).map((g) => ({ rep: g.rep, members: g.members }));
  let done = 0, failed = 0;
  const total = groups.length;
  const tick = () => progress("AI가 어디 넣을지 살펴보는 중… 아직 넣지 않아요", done, total, "다 보고 나면 어디로 갈지 보여드려요. 확인하고 넣으면 돼요.");
  tick();
  const results = [];
  await pool(groups, 6, async (g) => {
    const r = await classifyPreview(g.rep.id);
    if (r) results.push({ ...g, ids: r.dog_ids || [], aiIds: [...(r.dog_ids || [])], sure: new Set(r.sure || []), note: r.note || "", rotation: r.rotation, keep: true, manual: false });
    else failed++;
    done++;
    tick();
  });
  state.busy = false;
  $("#progress").classList.add("hidden");
  await render();
  if (!results.length) { toast(failed ? "AI가 바빠서 살펴보지 못했어요. 잠시 후 다시 눌러 주세요" : "다시 분류할 사진이 없어요"); return; }
  openReclassifyReview(results, failed);
}
async function openReclassifyReview(results, failed) {
  document.querySelector(".rc-overlay")?.remove();
  const ov = document.createElement("div");
  ov.className = "rc-overlay";
  document.body.appendChild(ov);
  const thumb = await signed("photos", results.flatMap((r) => r.members.map((p) => p.thumb_path)));
  const draw = async () => {
    const found = results.filter((r) => r.ids.length);
    const none = results.filter((r) => !r.ids.length);
    const byKey = new Map();
    for (const r of found) {
      const k = [...r.ids].sort().join(",");
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
    const blocks = [...byKey.entries()].sort((a, b) => b[1].length - a[1].length);
    const refs = await signed("refs", blocks.map(([k]) => dogById(k.split(",")[0])?.ref_path));
    const cnt = (rs) => rs.reduce((n, r) => n + r.members.length, 0);
    const picked = cnt(found.filter((r) => r.keep));
    const tile = (r, i) => `<button class="rc-tile ${r.keep ? "on" : ""} ${!r.manual && !r.ids.every((id) => r.sure.has(id)) ? "unsure" : ""}" data-rc="${i}" title="${esc(r.note)}">
        <img src="${thumb(r.rep.thumb_path)}" class="rot${r.rep.rotation || 0}" alt="">
        <span class="rc-check">${r.keep ? "✓" : ""}</span>
        ${r.members.length > 1 ? `<span class="burst">+${r.members.length - 1}</span>` : ""}</button>`;
    ov.innerHTML = `<div class="rc-box">
      <div class="rc-head"><div class="grow"><b>AI가 이렇게 넣으려고 해요</b>
        <small class="muted">아직 넣지 않았어요. 틀린 사진은 눌러서 체크를 빼면 그대로 남아요. 주황 점선은 AI가 확신하지 못한 사진이에요.</small></div>
        <button class="btn ghost sm" data-rc-act="close">닫기</button></div>
      <div class="rc-body">
      ${blocks.map(([k, rs]) => {
        const ids = k.split(",");
        const d0 = dogById(ids[0]);
        const allOn = rs.every((r) => r.keep);
        return `<div class="rc-group">
          <div class="rc-ghead">${d0?.ref_path ? `<img class="avatar" src="${refs(d0.ref_path)}" alt="">` : `<span class="avatar"></span>`}
            <b class="grow">→ ${esc(ids.map((id) => dogById(id)?.name || "?").join(" · "))} <span class="muted">${cnt(rs)}장</span></b>
            <button class="btn ghost mini" data-rc-all="${k}">${allOn ? "모두 빼기" : "모두 넣기"}</button>
            <button class="btn ghost mini" data-rc-move="${k}">다른 아이로</button></div>
          <div class="rc-grid">${rs.map((r) => tile(r, results.indexOf(r))).join("")}</div></div>`;
      }).join("")}
      ${none.length ? `<div class="rc-group none"><div class="rc-ghead"><span class="avatar q">?</span>
          <b class="grow">AI도 못 찾은 사진 <span class="muted">${cnt(none)}장 · 그대로 둬요</span></b></div>
          <div class="rc-grid">${none.map((r) => `<div class="rc-tile off"><img src="${thumb(r.rep.thumb_path)}" class="rot${r.rep.rotation || 0}" alt=""></div>`).join("")}</div></div>` : ""}
      ${failed ? `<p class="muted small">${failed}장은 AI가 바빠서 살펴보지 못했어요. 그대로 남아 있어요.</p>` : ""}
      </div>
      <div class="rc-foot"><button class="btn ghost sm" data-rc-act="close">넣지 않고 닫기</button>
        <button class="btn primary sm" data-rc-act="apply" ${picked ? "" : "disabled"}>체크한 ${picked}장 넣기</button></div>
    </div>`;
    $$("[data-rc]", ov).forEach((b) => b.addEventListener("click", () => { const r = results[+b.dataset.rc]; r.keep = !r.keep; draw(); }));
    $$("[data-rc-all]", ov).forEach((b) => b.addEventListener("click", () => {
      const rs = byKey.get(b.dataset.rcAll); const on = !rs.every((r) => r.keep);
      rs.forEach((r) => (r.keep = on)); draw();
    }));
    $$("[data-rc-move]", ov).forEach((b) => b.addEventListener("click", async () => {
      const rs = byKey.get(b.dataset.rcMove);
      const typed = prompt(`이 ${cnt(rs)}장을 어느 아이로 넣을까요? (이름)`, "");
      if (!typed || !typed.trim()) return;
      const to = await findOrCreateDog(typed.trim());
      if (!to) return;
      rs.forEach((r) => { r.ids = [to.id]; r.manual = true; r.keep = true; });
      draw();
    }));
    $$("[data-rc-act]", ov).forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.rcAct === "apply") applyReclassify(results.filter((r) => r.keep && r.ids.length), ov, results.filter((r) => !r.keep && r.aiIds.length));
      else ov.remove();
    }));
  };
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  draw();
}
async function applyReclassify(chosen, ov, rejected = []) {
  const btn = ov.querySelector('[data-rc-act="apply"]');
  if (btn) { btn.disabled = true; btn.textContent = "넣는 중…"; }
  let n = 0, learnN = 0, mistakeN = 0;
  const named = (id) => { const d = dogById(id); return d && !d.auto; };
  // 체크를 뺀 사진 = AI가 틀린 사진: 그 아이는 이 사진 후보에서 빼고, 실수로 기록해서 다음부터 덜 헷갈리게
  for (const r of rejected) {
    for (const p of r.members) {
      const not = [...new Set([...(p.not_dogs || []), ...r.aiIds])];
      await sb.from("photos").update({ not_dogs: not }).eq("id", p.id);
      p.not_dogs = not;
    }
    if (mistakeN < 8 && r.aiIds.length === 1 && named(r.aiIds[0])) { learnMistake(r.rep.id, r.aiIds[0], null); mistakeN++; }
  }
  for (const r of chosen) {
    for (const p of r.members) {
      // 직원이 이 화면에서 직접 고른 것·원래 직원이 확인했던 사진은 '직원 확인'으로 유지
      const conf = r.manual || p.confidence === "manual" ? "manual" : r.ids.every((id) => r.sure.has(id)) ? "high" : "low";
      const before = { status: p.status, ids: [...p.dog_ids], conf: p.confidence };
      const upd = { dog_ids: r.ids, status: "done", confidence: conf, ai_note: r.manual ? "직원이 확인 후 넣음" : `확인 후 넣음: ${r.note}`.slice(0, 200), find_dogs: [], claimed_at: null };
      await sb.from("photos").update(upd).eq("id", p.id);
      Object.assign(p, upd);
      // 직원이 확인한 사진은 학습: 직접 고른 아이 + AI가 확신 못 했는데 맞힌 아이 (확신해서 맞힌 건 이미 아는 것)
      if (p.id === r.rep.id && conf !== "high" && learnN < 16) { learnFrom(p, r.ids, before); learnN++; }
      // AI가 A라고 했는데 직원이 B로 바꿨으면 "A 아니고 B" 실수 기록
      if (p.id === r.rep.id && r.manual && mistakeN < 8 && r.aiIds.length === 1 && named(r.aiIds[0]) && !r.ids.includes(r.aiIds[0])) {
        learnMistake(p.id, r.aiIds[0], r.ids[0]); mistakeN++;
      }
      n++;
    }
  }
  // 오늘 명단에 없던 아이면 명단에 추가
  const newIds = [...new Set(chosen.flatMap((r) => r.ids))].filter((id) => state.attendance.size && !state.attendance.has(id));
  for (const id of newIds) {
    await sb.from("assignments").upsert({ day: state.day, dog_id: id }, { onConflict: "day,dog_id", ignoreDuplicates: true });
    state.attendance.add(id);
  }
  ov.remove();
  toast(`${n}장을 넣었어요`);
  await loadPhotos();
  await renderPhotos();
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
    `<button data-dog="${d.id}" data-name="${esc(norm(d.name))}" class="${p.dog_ids.includes(d.id) ? "on" : ""}">${esc(d.name)}${breedTag(d)}</button>`).join("")
    || `<span class="muted small">아직 등록된 아이가 없어요. '이 사진으로 아이 등록'을 눌러 주세요.</span>`;
  $$("#sheet-chips button").forEach((b) => b.addEventListener("click", () => { b.classList.toggle("on"); renderPicked(); }));
  $("#sheet-search").value = "";
  filterChips();
  renderPicked();
  const inGroup = sheetKey && sheetKey !== "unsorted" && p.dog_ids.includes(sheetKey);
  $("#sheet-out").classList.toggle("hidden", !inGroup);
  $("#sheet-out").textContent = inGroup ? `${dogById(sheetKey)?.name || ""}에서 빼기 (아래로)` : "여기서 빼기";
  $("#sheet-del").classList.remove("hidden"); // 어디서 보든 삭제 가능
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
// 직원이 고친 사진과 거의 똑같은 사진(같은 장면·같은 옷, 지문 0.93 이상)이 고치기 전 분류 그대로면 같이 고쳐 줌
async function followCorrection(p, before, ids) {
  try {
    if (!p.vec) {
      const { data: blob } = await sb.storage.from("photos").download(p.thumb_path);
      const v = blob && await fingerprint(blob);
      if (v) await sb.from("photos").update({ vec: v }).eq("id", p.id);
      else return;
    }
    if (before.conf === "manual" || (before.ids.length === ids.length && before.ids.every((x) => ids.includes(x)))) return;
    const { data: sim } = await sb.rpc("fp_similar", { p_photo: p.id, min_sim: 0.93 });
    const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    const targets = (sim || []).filter((x) => x.confidence !== "manual" && same(x.dog_ids || [], before.ids));
    if (!targets.length) return;
    await sb.from("photos").update({ dog_ids: ids, status: "done", confidence: "high", ai_note: "직원이 고친 비슷한 사진을 따라 고침" })
      .in("id", targets.map((x) => x.id));
    toast(`거의 같은 사진 ${targets.length}장도 똑같이 고쳤어요`);
    await loadPhotos();
    renderPhotos();
  } catch (e) { console.warn(e); }
}
// '모르는 아이' 칸에서 직원이 사진을 어떤 아이로 보내면: 칸에 남은 사진 중 지문이 그 아이와 확실히 맞는 사진도 따라감
//  (직원이 확인한 사진은 건드리지 않음 — '모르는 아이' 칸에 있는, 아직 아무도 확인 안 한 사진만)
const following = new Set();
async function followUnsorted(toId) {
  if (following.has(toId)) return;
  following.add(toId);
  try {
    const to = dogById(toId);
    if (!to || to.auto) return;
    const rest = state.photos.filter((p) => p.vec && p.confidence !== "manual" && (p.status === "review" || p.status === "error") && !(p.not_dogs || []).includes(toId));
    if (!rest.length) return;
    const pool0 = state.attendance.size ? [...state.attendance] : state.dogs.filter((d) => !d.auto).map((d) => d.id);
    const cands = [...new Set([...pool0, toId])].filter((id) => !dogById(id)?.auto);
    const hit = [];
    await pool(rest, 4, async (p) => {
      const { data: m } = await sb.rpc("fp_match", { q: p.vec, dogs: cands, p_day: state.day, p_photo: p.id });
      const top = m?.[0], second = m?.[1];
      if (top?.dog_id === toId && top.sim >= 0.7 && (!second || top.sim - second.sim >= 0.08)) hit.push(p);
    });
    if (!hit.length) return;
    for (const p of hit) {
      const upd = { dog_ids: [toId], status: "done", confidence: "low", ai_note: `직원이 ${to.name}(으)로 보낸 사진과 닮아서 따라감` };
      await sb.from("photos").update(upd).eq("id", p.id).or("confidence.is.null,confidence.neq.manual");
      Object.assign(p, upd);
    }
    toast(`'모르는 아이' 칸에서 ${to.name} 사진 ${hit.length}장을 더 찾아서 같이 보냈어요`, 5000);
    if (state.tab === "photos") await renderPhotos();
  } catch (e) { console.warn(e); } finally { following.delete(toId); }
}
const reviewing = new Set();
async function reviewFolder(aId, bId, exceptId) {
  const key = `${aId}>${bId}`;
  if (reviewing.has(key)) return;
  reviewing.add(key);
  const A = dogById(aId), B = dogById(bId);
  const list = state.photos.filter((p) => p.id !== exceptId && p.status === "done" && p.confidence !== "manual" && p.dog_ids.includes(aId));
  if (!list.length || !A || !B) { reviewing.delete(key); return; }
  toast(`${A.name} 폴더의 다른 사진 ${list.length}장도 ${B.name}인지 확인하고 있어요…`);
  let moved = 0;
  await pool(list, 4, async (p) => {
    try {
      const { data } = await sb.functions.invoke("classify", { body: { photo_id: p.id, only: [aId, bId] } });
      if (data?.dog_ids && data.dog_ids.includes(bId) && !data.dog_ids.includes(aId)) moved++;
    } catch { /* 다음 기회에 */ }
  });
  reviewing.delete(key);
  await loadPhotos();
  if (state.tab === "photos") await renderPhotos();
  toast(moved ? `${A.name} 폴더에서 ${moved}장을 ${B.name}(으)로 옮겼어요` : `${A.name} 폴더에 ${B.name} 사진은 더 없어요`);
}
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
    const vec = await fingerprint(blob);
    const { data: row } = await sb.from("dog_refs").insert({ dog_id: id, path, vec }).select("id, path, created_at").single();
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
  const { error } = await sb.from("photos").update({ rotation: p.rotation, rotation_checked: true }).eq("id", p.id);
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
  // 접혀 있던 같은 장면(연속 촬영) 사진이 빠진 아이 폴더에 '그대로 남은 것'처럼 다시 올라오지 않게 같이 옮김
  {
    const t = (p) => new Date(p.taken_at || p.created_at).getTime();
    const sp = sheetPhoto, same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    for (const w of before.ids.filter((id) => !ids.includes(id))) {
      if (state.expanded.has(w)) continue;
      const { extra } = splitSimilar(state.photos.filter((p) => p.status === "done" && p.dog_ids.includes(w)), w);
      for (const q of extra) {
        if (q.id === sp.id || !same(q.dog_ids, before.ids)) continue;
        if (!(sp.phash && q.phash && hamming(sp.phash, q.phash) <= SIM_DIST && Math.abs(t(sp) - t(q)) <= SIM_GAP)) continue;
        await sb.from("photos").update({ dog_ids: ids, status: "done", confidence: "manual" }).eq("id", q.id);
        Object.assign(q, { dog_ids: [...ids], status: "done", confidence: "manual" });
      }
    }
  }
  // 고친 사진 한 장만 바꿈. 비슷한 사진·같은 폴더 나머지 사진은 AI가 알아서 옮기지 않음 (시킬 때만 다시 검수)
  // 단, '모르는 아이' 칸에서 보낸 사진이면 그 칸에 남은 같은 아이 사진은 따라가게
  if ((before.status === "review" || before.status === "error" || !before.ids.length) && ids.length === 1) setTimeout(() => followUnsorted(ids[0]), 300);
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

// 이 사진으로 아이 등록 (이름은 꼭 적음)
$("#sheet-new").addEventListener("click", async () => {
  const p = sheetPhoto;
  const name = prompt("이 아이 이름을 적어 주세요 (호텔링 아이도 이름으로 등록해요)", "");
  if (name === null) return;
  if (!name.trim()) { toast("이름을 적어 주세요. 모르는 아이는 '모르는 아이' 칸에 그대로 두면 돼요"); return; }
  const { data: dog, error } = await sb.from("dogs")
    .insert({ name: name.trim(), auto: false }).select().single();
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

// 잘못 들어간 사진: 지우지 않고 이 강아지에서만 빼서 다시 분류 (몇 장 연달아 빼면 모아서 한 번에)
$("#sheet-out").addEventListener("click", async () => {
  const p = sheetPhoto, dogId = sheetKey;
  const rest = p.dog_ids.filter((d) => d !== dogId);
  // 이 아이는 이 사진의 후보에서 빼고, 남은 아이가 없으면 AI가 다시 분류
  const not = [...new Set([...(p.not_dogs || []), dogId])];
  const status = rest.length ? "done" : "review";
  const wasAi = p.confidence !== "manual";
  const { error } = await sb.from("photos").update({ dog_ids: rest, status, not_dogs: not, confidence: rest.length ? "manual" : null, ai_note: `${dogById(dogId)?.name || ""}에서 뺌`, claimed_at: null }).eq("id", p.id);
  if (error) { toast("옮기지 못했어요"); return; }
  if (wasAi && !dogById(dogId)?.auto) learnMistake(p.id, dogId, null);
  Object.assign(p, { dog_ids: rest, status, not_dogs: not, confidence: rest.length ? "manual" : null });
  toast(rest.length ? `${dogById(dogId)?.name}에서 뺐어요` : `${dogById(dogId)?.name}에서 빼서 맨 아래 '모르는 아이' 칸으로 보냈어요`);
  const i = sheetList.indexOf(p.id);
  sheetList = sheetList.filter((id) => id !== p.id);
  if (sheetList.length) openSheet(sheetList[Math.min(i, sheetList.length - 1)]); else closeSheet();
  renderPhotos();
});

$("#sheet-del").addEventListener("click", async () => {
  if (!confirm("이 사진을 완전히 삭제할까요? 되돌릴 수 없어요.")) return;
  const p = sheetPhoto;
  await sb.storage.from("photos").remove([p.path, p.thumb_path]);
  await sb.from("photos").delete().eq("id", p.id);
  state.photos = state.photos.filter((x) => x.id !== p.id);
  toast("사진을 삭제했어요");
  // 다음 사진으로 넘어감
  const i = sheetList.indexOf(p.id);
  sheetList = sheetList.filter((id) => id !== p.id);
  if (sheetList.length) openSheet(sheetList[Math.min(i, sheetList.length - 1)]); else closeSheet();
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
// 순서를 정한 아이는 파일 이름 앞에 번호(01, 02…)를 붙여서 폴더에서도 그 순서로 보이게 (01 = 대표 사진)
function photoFileName(dog, p, i) {
  const tm = new Date(p.taken_at || p.created_at);
  const t = isNaN(tm) ? "" : `${String(tm.getHours()).padStart(2, "0")}${String(tm.getMinutes()).padStart(2, "0")}${String(tm.getSeconds()).padStart(2, "0")}_`;
  const n = i != null && state.order.get(dog.id)?.length ? `${String(i + 1).padStart(2, "0")}_` : "";
  return `${safeName(fileLabel(dog))}_${state.day}_${n}${t}${p.id.slice(0, 6)}.jpg`;
}
const namedFor = (dog, photos) => sortForDog(dog.id, photos).map((p, i) => ({ p, name: photoFileName(dog, p, i) }));
async function photoFiles(dog, photos, onEach, skip = new Set()) {
  const out = [];
  const list = namedFor(dog, photos).filter((x) => !skip.has(x.name));
  await pool(list, 4, async ({ p, name }, i) => {
    const { data } = await sb.storage.from("photos").download(p.path);
    out[i] = new File([await rotated(data, p.rotation || 0)], name, { type: "image/jpeg" });
    onEach?.();
  });
  return out.filter(Boolean);
}
// 폴더 맞추기: 이미 받은 사진은 건너뛰고 새 사진만 받아서 넣음.
// 이 아이에게서 빠진 사진(다른 아이로 옮겨짐 등)의 파일만 정리
async function syncFolder(dir, dog, photos, onEach) {
  const named = namedFor(dog, photos);
  const want = new Set(named.map((x) => x.name));
  const byId = new Map(named.map((x) => [x.p.id.slice(0, 6), x.name])); // 순서만 바뀐 파일은 이름만 바꿈
  const have = new Set();
  let removed = 0;
  const mine = `${safeName(fileLabel(dog))}_${state.day}_`;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== "file") continue;
    if (want.has(name)) { have.add(name); continue; }
    if (!name.startsWith(mine) || !/\.jpe?g$/i.test(name)) continue;
    const to = byId.get(name.replace(/\.jpe?g$/i, "").slice(-6));
    if (to && !have.has(to) && h.move) { try { await h.move(to); have.add(to); continue; } catch { /* 새로 받음 */ } }
    try { await dir.removeEntry(name); removed++; } catch { /* 무시 */ }
  }
  named.filter((x) => have.has(x.name)).forEach(() => onEach?.(true));
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

// 다운로드·다이얼독 임시저장이 끝난 사진 = 검수 끝 → 그 아이들 새로 학습 (서버에서, 하루 아이당 한 번)
function learnVerified(dogIds) {
  const ids = [...new Set(dogIds)].filter((id) => { const d = dogById(id); return d && !d.auto; });
  if (!ids.length || state.practice) return;
  sb.functions.invoke("learn-verified", { body: { day: state.day, dog_ids: ids } })
    .then(({ data }) => { if (data?.refs_added) toast(`검수 끝난 사진으로 ${ids.length}마리 학습했어요 (새 모습 ${data.refs_added}장)`); })
    .catch(() => {});
}
async function saveDogPhotos(dog, photos, btn, mode) {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    let root = null;
    if (mode === "folder") {
      root = await (await saveFolder()).getDirectoryHandle(state.day, { create: true });
      const dir = await root.getDirectoryHandle(safeName(fileLabel(dog)), { create: true });
      let n = 0;
      const r = await syncFolder(dir, dog, photos, () => { btn.textContent = `${++n}/${photos.length}`; });
      doneBanner(`'${state.day}/${dog.name}' 폴더 · 새로 받은 사진 ${r.added}장${r.kept ? ` (이미 받은 ${r.kept}장은 건너뜀)` : ""}`);
      learnVerified([dog.id]);
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
      downloadBlob(await zip.generateAsync({ type: "blob" }), `${safeName(fileLabel(dog))}_${state.day}.zip`);
      doneBanner(`${dog.name} ${files.length}장 ZIP 다운로드 완료`);
    }
    learnVerified([dog.id]);
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

const UNSORTED_DIR = { id: "__unsorted", name: "분류 안 됨" };
const isUnsortedPhoto = (p) => p.status === "review" || p.status === "error" || (p.status === "done" && !p.dog_ids.some((d) => dogById(d)));
async function saveAll(btn, onlyUnsorted = false) {
  const groups = new Map();
  if (!onlyUnsorted) state.photos.filter((p) => p.status === "done").forEach((p) => p.dog_ids.forEach((d) => {
    const dog = dogById(d);
    if (!dog) return;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(p);
  }));
  for (const [id, list] of groups) {
    const { shown, extra } = splitSimilar(list, id);
    groups.set(id, state.expanded.has(id) ? [...shown, ...extra] : shown);
  }
  // 분류 안 된 사진은 '분류 안 됨' 폴더로
  const loose = state.photos.filter(isUnsortedPhoto);
  if (loose.length) groups.set(UNSORTED_DIR.id, loose);
  if (!groups.size) { toast("받을 사진이 없어요"); return; }
  const dogOf = (id) => (id === UNSORTED_DIR.id ? UNSORTED_DIR : dogById(id));
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
      const dog = dogOf(id);
      if (root) {
        const r = await syncFolder(await root.getDirectoryHandle(safeName(fileLabel(dog)), { create: true }), dog, photos,
          (skipped) => { skipped ? kept++ : added++; tick(); });
      } else {
        const files = await photoFiles(dog, photos, () => { added++; tick(); });
        files.forEach((f) => zip.file(`${state.day}/${safeName(fileLabel(dog))}/${f.name}`, f));
      }
    }
    if (zip) {
      downloadBlob(await zip.generateAsync({ type: "blob" }), `${state.day}.zip`);
      learnVerified([...groups.keys()].filter((id) => id !== UNSORTED_DIR.id));
      doneBanner(`${state.day}.zip · ${onlyUnsorted ? "분류 안 된 사진" : `강아지 ${groups.size - (loose.length ? 1 : 0)}마리`}, ${total}장${loose.length && !onlyUnsorted ? ` (분류 안 됨 ${loose.length}장 포함)` : ""}`);
    } else {
      learnVerified([...groups.keys()].filter((id) => id !== UNSORTED_DIR.id));
      doneBanner(`'${window.__saveDirName || "다운로드"}/${state.day}' 폴더 · ${onlyUnsorted ? "'분류 안 됨' 폴더" : `강아지 ${groups.size - (loose.length ? 1 : 0)}마리${loose.length ? ` + '분류 안 됨' ${loose.length}장` : ""}`} · 새로 받은 사진 ${added}장${kept ? ` (이미 받은 ${kept}장은 건너뜀)` : ""}`);
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
  if (!dog && m.similar) {
    const got = askSimilar(name, m.similar);
    if (got === undefined) return;
    dog = got;
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
    const today = state.practice ? [] : state.dogs.filter((d) => state.attendance.has(d.id)).sort(dogOrder);
    const hasAny = state.photos.some((p) => p.status === "done" && p.dog_ids.length);
    layout?.classList.toggle("with-side", today.length > 0 || (state.practice && hasAny));
    if (!today.length && !(state.practice && hasAny)) return;
    const count = new Map();
    const per = new Map();
    let done = 0, unsorted = 0, pending = 0;
    state.photos.forEach((p) => {
      if (p.status === "done") { done++; p.dog_ids.forEach((d) => { if (!per.has(d)) per.set(d, []); per.get(d).push(p); }); }
      else if (p.status === "pending" || p.status === "working") pending++;
      else if (p.status !== "skip") unsorted++;
    });
    for (const [d, list] of per) count.set(d, splitSimilar(list).shown.length); // 비슷한 사진 정리 후 장수
    const zero = today.filter((d) => !count.get(d.id)).length;
    // 명단 밖인데 사진이 분류된 아이 (자동 그룹 등)
    const extra = [...count.keys()].filter((id) => (state.practice || !state.attendance.has(id)) && dogById(id)).map(dogById).sort(dogOrder);

    $("#side-head-label").innerHTML = state.practice ? `🧪 학습 결과 <b id="side-count">${extra.length}</b>마리` : `📋 오늘 <b id="side-count">${today.length}</b>마리`;
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
        <span class="nm">${state.hotel.has(d.id) ? `<b class="tag-h">H</b>` : ""}${esc(d.name)}${breedTag(d)}</span>
        <b class="cnt ${up ? "bump" : ""}">${n}<small>장</small>${up ? `<i class="plus">+${up}</i>` : ""}</b>
      </button>${inToday ? `<button class="side-x" data-unroll="${d.id}" title="오늘 명단에서 빼기">×</button>` : ""}</div>`;
    };
    const keyDay = state.day;
    if (sideCountsDay !== keyDay) { sideCounts.clear(); sideCountsDay = keyDay; }
    const html = today.map(row).join("") +
      (extra.length ? (state.practice ? "" : `<p class="side-sec">명단 밖 ${extra.length}</p>`) + extra.map(row).join("") : "") +
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
      <span class="nm">${esc(d.name)}${breedTag(d)}</span>
      ${state.attendance.has(d.id) ? `<i class="dot" title="오늘 출석"></i>` : ""}
      <small>${refCount(d)}</small>
    </button>`;
  $("#side-list").innerHTML =
    (named.length ? named.map(row).join("") : `<p class="muted small side-empty">아직 등록된 강아지가 없어요</p>`) +
    "";
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
          <b class="nm">${esc(d.name)}${breedTag(d, true)}</b>
          ${d.auto ? `<span class="tag">이름 필요</span>` : ""}
          ${!d.auto && !d.dd_pet_id ? `<span class="tag kakao">카톡</span>` : ""}
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
          ${d.auto ? `<button class="btn ghost mini danger" data-delete-dog>삭제</button>` : ""}
          <button class="btn ghost mini" data-toggle>${d.active ? "숨기기" : "표시"}</button>
        </div>
      </div>
      <div class="ref-strip">
        ${refs.map((r, i) => `<span class="ref-thumb ${r.path.includes("-learn-") ? "learned" : ""}"><img src="${ref(r.path)}" alt="" data-view-ref="${i}" title="크게 보기">${r.path.includes("-learn-") ? `<i class="lb">학습</i>` : ""}${r.id ? `<b class="x" data-del-ref="${r.id}" title="이 아이가 아니면 빼기">×</b>` : ""}</span>`).join("")}
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
    <div class="stat"><b>${allNamed.filter((d) => !d.dd_pet_id).length}</b><span>다이얼독 없음(카톡)</span></div>

    ${fewPhoto ? `<p class="stats-note">사진이 3장 미만인 아이가 ${fewPhoto}마리 있어요. 더 올리면 정확해져요.</p>` : ""}`;

  // 다이얼독에 있는 아이 / 다이얼독에 없는 아이(호텔링 등 알림장 대신 카톡으로 사진을 보내는 아이)
  const ddDogs = named.filter((d) => d.dd_pet_id);
  const kakao = named.filter((d) => !d.dd_pet_id);
  $("#roster-list").innerHTML = named.length
    ? (ddDogs.length ? `<h3 class="sec">다이얼독 명단 ${ddDogs.length}마리 <small class="muted">이름은 다이얼독과 같게 맞춰요</small></h3>` + ddDogs.map(card).join("") : "") +
      (kakao.length ? `<h3 class="sec kakao-sec">다이얼독에 없는 아이 ${kakao.length}마리 <small class="muted">호텔링·데이케어로 와서 알림장 대신 카톡으로 사진을 보내는 아이예요. 사진이 쌓이면 대표 사진을 직접 골라 주세요</small></h3>` + kakao.map(card).join("") : "")
    : `<div class="empty">${q ? "찾는 이름이 없어요." : "아직 명단이 없어요. 위에서 등록하거나, 알림장 탭에서 출석 보드를 올려 보세요."}</div>`;
  $("#roster-auto").innerHTML = autos.length
    ? `<h3 class="sec">이름 없는 그룹 ${autos.length}개 <button class="btn ghost mini danger" id="del-all-auto">모두 삭제</button> <small class="muted">AI가 만든 그룹이에요. 이름을 붙이면 명단에 들어가요 (같은 이름이 있으면 합쳐져요). 삭제해도 사진은 지워지지 않고 '분류 안 된 사진'으로 돌아가요</small></h3>` + autos.map(card).join("")
    : "";

  $("#del-all-auto")?.addEventListener("click", async () => {
    const ids = state.dogs.filter((d) => d.auto).map((d) => d.id);
    if (!ids.length) return;
    if (!confirm(`이름 없는 그룹 ${ids.length}개를 모두 삭제할까요?\n사진은 지워지지 않고 '분류 안 된 사진'으로 돌아가요.`)) return;
    await deleteDogs(ids);
  });

  $$(".dog-card").forEach((row) => {
    const dog = dogById(row.dataset.id);
    $("[data-add-ref]", row).addEventListener("click", () => { refTarget = dog.id; $("#roster-file").click(); });
    $$("[data-view-ref]", row).forEach((im) => im.addEventListener("click", () => openRefView(dog, +im.dataset.viewRef)));
    $$("[data-del-ref]", row).forEach((x) => x.addEventListener("click", async () => {
      const r = dog.dog_refs.find((y) => y.id === x.dataset.delRef);
      const v = prompt(`${dog.name}에서 이 사진을 뺄게요.\n다른 아이 사진이면 그 아이 이름을 써 주세요 (그 아이 대표 사진으로 옮겨요).\n그냥 빼려면 비워 두고 확인`, "");
      if (v === null) return;
      if (v.trim()) {
        const to = await findOrCreateDog(v.trim());
        if (!to || to.id === dog.id) return;
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
        renderRoster();
        moveSimilarRefs(dog, to);
        return;
      } else {
        await removeRef(dog, r);
      }
      renderRoster();
    }));
    $("[data-edit]", row).addEventListener("click", async () => {
      if (dog.auto) { if (await renameDog(dog)) renderRoster(); return; }
      const name = prompt("이름", dog.name);
      if (name === null) return;
      if (dog.dd_pet_id && name.trim() && baseName(name) !== baseName(dog.name) &&
        !confirm(`'${dog.name}'은(는) 다이얼독에 등록된 이름이에요.\n이름을 바꾸면 다이얼독 명단과 달라져서 헷갈릴 수 있어요.\n보드에 다르게 쓰는 것뿐이라면 바꾸지 않아도 돼요(명단 확정 때 같은 아이로 묶어 드려요).\n\n그래도 '${name.trim()}'(으)로 바꿀까요?`)) return;
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
    $("[data-delete-dog]", row)?.addEventListener("click", async () => {
      if (!confirm(`'${dog.name}' 그룹을 삭제할까요?\n이 그룹의 사진은 지워지지 않고 '분류 안 된 사진'으로 돌아가요.`)) return;
      await deleteDogs([dog.id]);
    });
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

// 아이 등록 (이름 + 여러 각도 사진)
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

// ---- 관리자 탭 왼쪽 메뉴
function admSecSaved() { try { return localStorage.getItem("adm-sec"); } catch { return null; } }
var admSec = admSecSaved() || "clean";
function showAdmSec(sec, save) {
  admSec = sec;
  $$("#tab-admin [data-sec].card").forEach((c) => c.classList.toggle("adm-hide", c.dataset.sec !== sec));
  $$("#adm-nav [data-sec]").forEach((b) => b.classList.toggle("on", b.dataset.sec === sec));
  if (save) { try { localStorage.setItem("adm-sec", sec); } catch { /* 괜찮음 */ } }
}
$$("#adm-nav [data-sec]").forEach((b) => b.addEventListener("click", () => { showAdmSec(b.dataset.sec, true); window.scrollTo({ top: 0, behavior: "smooth" }); }));
showAdmSec(admSec);

// ---- 선생님 업로드 링크
const upUrl = (t) => `${location.origin}${location.pathname.replace(/[^/]*$/, "")}up.html?k=${t}`;
async function renderUpLinks() {
  const { data } = await sb.from("upload_links").select("*").order("created_at", { ascending: false });
  const list = data || [];
  $("#up-links").innerHTML = list.length ? list.map((l) => `<div class="up-link ${l.active ? "" : "off"}">
      <div class="grow"><b>${esc(l.label || "선생님 링크")}</b>${l.active ? "" : ` <span class="tag off">꺼짐</span>`}<br><small class="muted">${esc(upUrl(l.token))}</small></div>
      ${l.active ? `<button class="btn primary mini" data-copy="${l.token}">링크 복사</button>` : ""}
      <button class="btn ghost mini" data-onoff="${l.token}">${l.active ? "끄기" : "켜기"}</button>
      <button class="btn ghost mini danger" data-del="${l.token}">삭제</button>
    </div>`).join("") : `<p class="muted small">아직 링크가 없어요.</p>`;
  $$("#up-links [data-del]").forEach((b) => b.addEventListener("click", async () => {
    const l = list.find((x) => x.token === b.dataset.del);
    if (!confirm(`'${l.label || "선생님 링크"}' 링크를 삭제할까요?\n이 링크로는 더 이상 사진을 올릴 수 없어요. (이미 올라온 사진은 그대로예요)`)) return;
    const { error } = await sb.from("upload_links").delete().eq("token", l.token);
    if (error) { toast("삭제하지 못했어요"); return; }
    toast("링크를 삭제했어요");
    renderUpLinks();
  }));
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

// ---- 직원 계정 (최고 관리자만)
async function staffCall(body) {
  const { data, error } = await sb.functions.invoke("staff-admin", { body });
  if (error) {
    let msg = "잠시 후 다시 해 주세요";
    try { msg = (await error.context?.json())?.error || msg; } catch { /* 무시 */ }
    throw new Error(msg);
  }
  return data;
}
async function renderStaff() {
  const card = $("#staff-card");
  if (!card) return;
  const { data: { user } } = await sb.auth.getUser();
  const { data: me } = await sb.from("staff_roles").select("role").eq("user_id", user?.id).maybeSingle();
  if (me?.role !== "owner") { card.classList.add("hidden"); $("#adm-nav-staff")?.classList.add("hidden"); if (admSec === "staff") showAdmSec("clean"); return; }
  card.classList.remove("hidden");
  $("#adm-nav-staff")?.classList.remove("hidden");
  if (!admSecSaved()) showAdmSec("staff");
  const box = $("#staff-list");
  let list;
  try { ({ users: list } = await staffCall({ action: "list" })); }
  catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const when = (t) => t ? new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) : "아직 로그인 안 함";
  box.innerHTML = list.map((u) => `<div class="staff-row">
      <div class="grow"><b>${esc(u.name || u.email.split("@")[0])}</b>${u.role === "owner" ? ` <span class="tag-owner">최고 관리자</span>` : ""}${u.id === user.id ? ` <small class="muted">(나)</small>` : ""}
        <br><small class="muted">${esc(u.email)} · 마지막 로그인 ${when(u.last_sign_in_at)}</small></div>
      <button class="btn ghost mini" data-st-name="${u.id}">이름</button>
      <button class="btn ghost mini" data-st-pw="${u.id}">비밀번호</button>
      ${u.role === "owner" ? "" : `<button class="btn ghost mini danger" data-st-del="${u.id}">빼기</button>`}
    </div>`).join("");
  const find = (id) => list.find((u) => u.id === id);
  const label = (u) => u.name || u.email;
  $$("[data-st-name]", box).forEach((b) => b.addEventListener("click", async () => {
    const u = find(b.dataset.stName);
    const v = prompt(`${u.email}의 이름`, u.name || "");
    if (v === null) return;
    try { await staffCall({ action: "rename", user_id: u.id, name: v }); renderStaff(); } catch (e) { toast(e.message); }
  }));
  $$("[data-st-pw]", box).forEach((b) => b.addEventListener("click", async () => {
    const u = find(b.dataset.stPw);
    const v = prompt(`${label(u)}의 새 비밀번호 (6자 이상)\n바꾼 뒤 직원에게 알려 주세요.`, "");
    if (v === null) return;
    if (v.length < 6) { toast("6자 이상으로 정해 주세요"); return; }
    try { await staffCall({ action: "reset", user_id: u.id, password: v }); toast(`${label(u)} 비밀번호를 바꿨어요`, 3500); } catch (e) { toast(e.message, 3500); }
  }));
  $$("[data-st-del]", box).forEach((b) => b.addEventListener("click", async () => {
    const u = find(b.dataset.stDel);
    if (!confirm(`${label(u)}(${u.email}) 계정을 뺄까요?\n이 계정으로는 더 이상 로그인할 수 없어요. 사진과 명단은 그대로 남아요.`)) return;
    try { await staffCall({ action: "remove", user_id: u.id }); toast(`${label(u)} 계정을 뺐어요`); renderStaff(); } catch (e) { toast(e.message, 3500); }
  }));
}
$("#staff-new")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#sn-name").value.trim(), email = $("#sn-email").value.trim(), password = $("#sn-pw").value;
  if (password.length < 6) { toast("비밀번호는 6자 이상으로 정해 주세요"); return; }
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    await staffCall({ action: "create", name, email, password });
    $("#sn-name").value = ""; $("#sn-email").value = ""; $("#sn-pw").value = "";
    toast(`${name || email} 계정을 만들었어요. 이메일과 처음 비밀번호를 알려 주세요`, 4500);
    renderStaff();
  } catch (err) { toast(err.message, 3500); }
  if (btn) btn.disabled = false;
});

// ---- 내 비밀번호 바꾸기
sb.auth.getUser().then(({ data }) => { if ($("#me-email")) $("#me-email").textContent = data?.user?.email || ""; });
$("#pw-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const a = $("#pw-new").value, b = $("#pw-new2").value;
  if (a.length < 6) { toast("6자 이상으로 정해 주세요"); return; }
  if (a !== b) { toast("두 칸이 서로 달라요"); return; }
  const btn = e.submitter; if (btn) btn.disabled = true;
  const { error } = await sb.auth.updateUser({ password: a });
  if (btn) btn.disabled = false;
  if (error) { toast(/same/i.test(error.message) ? "지금 비밀번호와 같아요" : /weak|short/i.test(error.message) ? "더 길거나 복잡한 비밀번호로 정해 주세요" : "바꾸지 못했어요. 다시 로그인한 뒤 해 주세요", 4000); return; }
  $("#pw-new").value = ""; $("#pw-new2").value = "";
  $("#pw-dialog").classList.add("hidden");
  toast("비밀번호를 바꿨어요. 다음 로그인부터 새 비밀번호로 들어와요", 4000);
});

// ---- 다이얼독 알림장 임시저장 북마크
const siteBase = () => `${location.origin}${location.pathname.replace(/[^/]*$/, "")}`;
const ddBookmarklet = (t) => `javascript:(()=>{window.__DDG_TOKEN='${t}';var s=document.createElement('script');s.src='${siteBase()}dd-push.js?v='+Date.now();document.body.appendChild(s)})()`;
async function renderDdLinks() {
  const box = $("#dd-links");
  if (!box) return;
  const { data } = await sb.from("dd_push_links").select("*").eq("active", true).order("created_at", { ascending: false }).limit(1);
  const l = data?.[0];
  box.innerHTML = l ? `<div class="dd-mark"><a class="dd-bm" href="${esc(ddBookmarklet(l.token))}" onclick="event.preventDefault();alert('이 버튼은 누르는 게 아니라 북마크바로 끌어다 놓는 거예요.')">📮 댕겨올개 알림장</a>
      <small class="muted">${l.last_used ? `마지막 사용 ${new Date(l.last_used).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "아직 안 써 봤어요"}</small>
      <button class="btn ghost mini" data-dd-copy>주소 복사</button></div>
      <p class="muted small">끌어다 놓기가 안 되면 ‘주소 복사’ 후 북마크를 하나 만들고 URL 칸에 붙여 넣어 주세요.</p>`
    : `<p class="muted small">아직 북마크가 없어요. 아래 버튼으로 만들어 주세요.</p>`;
  $("#dd-new").textContent = l ? "북마크 새로 만들기 (예전 것은 꺼짐)" : "북마크 만들기";
  box.querySelector("[data-dd-copy]")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(ddBookmarklet(l.token)); toast("복사했어요. 북마크 URL 칸에 붙여 넣어 주세요"); }
    catch { prompt("이 주소를 복사해 주세요", ddBookmarklet(l.token)); }
  });
}
$("#dd-new")?.addEventListener("click", async () => {
  const { data: old } = await sb.from("dd_push_links").select("token").eq("active", true);
  if (old?.length && !confirm("새로 만들면 예전 북마크는 더 이상 작동하지 않아요. 새로 만들까요?")) return;
  const b = crypto.getRandomValues(new Uint8Array(18));
  const token = btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]));
  if (old?.length) await sb.from("dd_push_links").update({ active: false }).eq("active", true);
  const { error } = await sb.from("dd_push_links").insert({ token, label: "다이얼독 북마크" });
  if (error) { toast("만들지 못했어요"); return; }
  await renderDdLinks();
  toast("노란 버튼을 북마크바로 끌어다 놓아 주세요");
});
// 사진 탭의 '다이얼독 알림장' 버튼: 다이얼독을 열고 북마크를 누르라고 안내
// 다이얼독 알림장 버튼: 모든 아이 알림장에 똑같이 붙일 글을 먼저 붙여 넣고 → 다이얼독 열기
async function openDialdogPush() {
  document.querySelector(".dd-note-ov")?.remove();
  const ov = document.createElement("div");
  ov.className = "rc-overlay dd-note-ov";
  ov.innerHTML = `<div class="rc-box dd-note-box">
    <div class="rc-head"><div style="flex:1"><b>📮 다이얼독 알림장 보내기</b><small class="muted">아래 글과 분류된 사진이 오늘 출석부 아이들에게 똑같이 전송돼요 (H 호텔링 제외)</small></div><button class="icon" data-x aria-label="닫기">×</button></div>
    <div class="rc-body">
      <textarea id="dd-note-text" maxlength="1000" rows="9" placeholder="여기에 알림장 글을 붙여 넣어 주세요"></textarea>
      <div class="dd-note-meta"><small class="muted">비워 두면 사진만 넣어요 · 다음에도 이 글이 그대로 남아 있어요</small><small id="dd-note-n" class="muted">0 / 1000</small></div>
    </div>
    <div class="rc-foot"><button class="btn" data-x>취소</button><button class="btn primary" id="dd-note-go">저장하고 다이얼독 열기</button></div>
  </div>`;
  document.body.appendChild(ov);
  const ta = $("#dd-note-text", ov), n = $("#dd-note-n", ov);
  const count = () => { n.textContent = `${ta.value.length} / 1000`; };
  ta.addEventListener("input", count);
  const close = () => ov.remove();
  ov.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", close));
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  const { data } = await sb.from("app_settings").select("value").eq("name", "dd_note").maybeSingle();
  if (!ta.value) ta.value = data?.value?.text || "";
  count();
  ta.focus();
  $("#dd-note-go", ov).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const w = window.open("https://dialodog.com/partners/#reports", "dialodog"); // 팝업 막힘 방지: 먼저 열기
    btn.disabled = true; btn.textContent = "저장 중…";
    const { error } = await sb.from("app_settings").update({ value: { text: ta.value.trim().slice(0, 1000) } }).eq("name", "dd_note");
    if (error) { btn.disabled = false; btn.textContent = "저장하고 다이얼독 열기"; toast("글을 저장하지 못했어요. 다시 눌러 주세요."); return; }
    close();
    if (!w) toast("팝업이 막혔어요. 다이얼독을 직접 열어 주세요.", 6000);
    toast("다이얼독에서 북마크 ‘댕겨올개 알림장’을 누르고 ‘전송’을 눌러 주세요. 아직 없으면 관리자 탭에서 만들어요.", 6000);
  });
}

// 새로 추가되는 사진 알림: 다른 사람(선생님 링크·다른 직원 계정)이 올린 오늘 사진을 세어서,
// 원장님이 ×(확인)을 누를 때까지 계속 띄워 둠. 사이트를 닫아 둔 동안 올라온 사진도 열면 알려 줌.
const live = { n: 0, timer: null, last: 0, me: null };
const baseTitle = document.title;
const seenKey = () => `ddgog-seen-${kstToday()}`;
function getSeen() { try { return localStorage.getItem(seenKey()); } catch (e) { return null; } }
function setSeen(t) { try { localStorage.setItem(seenKey(), t); } catch (e) {} }
function showLive(away = false) {
  if (!live.n) return;
  const bar = $("#live-bar");
  const receiving = !away && Date.now() - live.last < 15000;
  const tail = state.attendance.size ? " · 분류 시작" : " · 명단을 확정하면 분류해요";
  $("#live-text").innerHTML = receiving
    ? `📲 새 사진이 올라오고 있어요… <b>${live.n}장</b> 추가됨`
    : `📲 새 사진 <b>${live.n}장</b>이 추가됐어요${away ? " (자리 비운 동안)" : ""}${tail} · 확인하면 ×`;
  bar.classList.toggle("receiving", receiving);
  bar.classList.remove("hidden");
  document.title = `(${live.n}) ${baseTitle}`;
}
function ackLive() {
  $("#live-bar").classList.add("hidden");
  live.n = 0;
  document.title = baseTitle;
  setSeen(new Date().toISOString());
}
$("#live-x").addEventListener("click", ackLive);
const notMine = (p) => !live.me || p.uploaded_by !== live.me;
sb.channel("teacher-photos")
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "photos" }, (msg) => {
    const p = msg.new || {};
    if (p.day !== kstToday() || p.practice || !notMine(p)) return;
    live.n++;
    live.last = Date.now();
    showLive();
    clearTimeout(live.timer);
    live.timer = setTimeout(async () => {
      showLive();
      if (state.day === kstToday()) { await loadPhotos(); if (state.tab === "photos") await renderPhotos(); }
      if (!state.busy && !state.draft && state.attendance.size && state.day === kstToday()) classifyPending();
    }, 20000);
  })
  .subscribe();
// 사이트를 열 때·다른 창에서 돌아올 때: 마지막으로 확인한 뒤 올라온 사진이 있으면 알림
async function checkMissed() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  live.me = session.user.id;
  const seen = getSeen();
  if (!seen) { setSeen(new Date().toISOString()); return; }
  const { count } = await sb.from("photos").select("id", { count: "exact", head: true })
    .eq("day", kstToday()).eq("practice", false).gt("created_at", seen)
    .or(`uploaded_by.is.null,uploaded_by.neq.${live.me}`);
  if (count && count > live.n) { live.n = count; showLive(true); }
}
setTimeout(checkMissed, 1500);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkMissed(); });

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

// ---- 사진 지문 채우기: 대표 사진·지난 60일 분류된 사진 중 지문이 없는 것을 화면이 켜져 있는 동안 조금씩
const fpJob = { running: false, done: 0, total: 0 };
async function backfillFingerprints(manual = false) {
  if (fpJob.running) return;
  fpJob.running = true;
  const msg = (t) => { const el = $("#fp-msg"); if (el) el.textContent = t; };
  try {
    await loadFingerprint((t) => t && msg(t));
    const since = shiftDay(kstToday(), -60);
    const { data: refs } = await sb.from("dog_refs").select("id, path").is("vec", null).limit(5000);
    const { data: photos } = await sb.from("photos").select("id, thumb_path, rotation").is("vec", null).gte("day", since).limit(5000);
    const { data: les } = await sb.from("lessons").select("id, path").is("vec", null).limit(2000);
    // 대표 사진 먼저 (명단 없이 학습할 때 후보를 추리는 기준), 그다음 실수 기록·분류된 사진
    const todo = [...(refs || []).map((r) => ({ kind: "r", ...r })), ...(les || []).map((l) => ({ kind: "l", ...l })), ...(photos || []).map((p) => ({ kind: "p", ...p }))];
    fpJob.total = todo.length; fpJob.done = 0;
    if (!todo.length) { msg("모든 사진에 지문이 있어요 ✓"); return; }
    for (const it of todo) {
      if (document.hidden && !manual) await new Promise((r) => setTimeout(r, 2000));
      try {
        const { data: blob } = await sb.storage.from(it.kind === "p" ? "photos" : "refs").download(it.kind === "p" ? it.thumb_path : it.path);
        if (blob) {
          const v = await fingerprint(blob);
          if (v) await sb.from({ p: "photos", r: "dog_refs", l: "lessons" }[it.kind]).update({ vec: v }).eq("id", it.id);
        }
      } catch (e) { console.warn(e); }
      fpJob.done++;
      if (fpJob.done % 5 === 0 || fpJob.done === fpJob.total) msg(`사진 지문 만드는 중 ${fpJob.done} / ${fpJob.total} (이 화면을 켜 두면 계속 진행돼요)`);
    }
    msg(`사진 지문 ${fpJob.total}장 완료 ✓`);
  } catch (e) {
    msg("사진 지문 기능을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.");
  } finally { fpJob.running = false; }
}
$("#fp-run").addEventListener("click", () => backfillFingerprints(true));

// ---- 학습 모드 스위치
async function loadPractice() {
  const { data } = await sb.from("app_settings").select("value").eq("name", "practice").maybeSingle();
  state.practice = data?.value?.on === true;
  const cb = $("#practice-on");
  if (cb) cb.checked = state.practice;
  document.body.classList.toggle("practice", state.practice);
}
$("#practice-on").addEventListener("change", async (e) => {
  const on = e.target.checked;
  const { error } = await sb.from("app_settings").update({ value: { on } }).eq("name", "practice");
  if (error) { toast("바꾸지 못했어요"); e.target.checked = !on; return; }
  state.practice = on;
  document.body.classList.toggle("practice", on);
  urlCache.clear();
  await render();
  toast(on ? "학습 모드를 켰어요. 기존 사진은 숨기고, 새로 올리는 사진만 모든 아이 중에서 찾아 분류해요" : "학습 모드를 껐어요. 원래 사진과 출석 명단 기준 분류로 돌아왔어요");
});
// 학습 모드 사진 싹 비우기 (운영 사진·다이얼독 대표 사진은 그대로)
$("#practice-clear").addEventListener("click", async () => {
  const { count } = await sb.from("photos").select("id", { count: "exact", head: true }).eq("practice", true);
  const withLearn = $("#practice-clear-learn").checked;
  if (!count && !withLearn) { toast("지울 학습 모드 사진이 없어요"); return; }
  if (!confirm(`학습 모드로 올린 사진 ${count || 0}장을 모두 지울까요?${withLearn ? "\n학습 모드에서 배운 학습 사진·실수 기록도 함께 지워요." : ""}\n지운 사진은 되돌릴 수 없어요.`)) return;
  const btn = $("#practice-clear"), msg = $("#practice-clear-msg");
  btn.disabled = true;
  try {
    let since = null;
    if (withLearn) {
      // 학습 모드 사진이 처음 올라온 시점 이후에 생긴 학습 사진·실수 기록 = 학습 모드에서 배운 것
      const { data: first } = await sb.from("photos").select("created_at").eq("practice", true).order("created_at").limit(1);
      since = first?.[0]?.created_at || null;
    }
    const n = await deletePhotos((q) => q.eq("practice", true), (k) => { msg.textContent = `${k}장 지움…`; });
    let learned = 0;
    if (withLearn && since) {
      const { data: refs } = await sb.from("dog_refs").select("id, path").like("path", "%-learn-%").gte("created_at", since);
      const { data: les } = await sb.from("lessons").select("id, path").gte("created_at", since);
      for (let i = 0; i < (refs || []).length; i += 200) {
        const part = refs.slice(i, i + 200);
        await sb.from("dog_refs").delete().in("id", part.map((r) => r.id));
        await sb.storage.from("refs").remove(part.map((r) => r.path));
      }
      for (let i = 0; i < (les || []).length; i += 200) {
        const part = les.slice(i, i + 200);
        await sb.from("lessons").delete().in("id", part.map((r) => r.id));
        await sb.storage.from("refs").remove(part.map((r) => r.path));
      }
      learned = (refs || []).length + (les || []).length;
      await loadDogs();
    }
    msg.textContent = `학습 모드 사진 ${n}장${learned ? `, 학습 기록 ${learned}개` : ""}를 지웠어요. 이제 새로 올려서 다시 해보세요.`;
    toast("학습 모드를 깨끗이 비웠어요");
    urlCache.clear();
    await render();
  } catch (e) {
    console.error(e);
    toast("다 지우지 못했어요. 다시 눌러 주세요");
  } finally { btn.disabled = false; }
});
// 로그인되어 있으면 1분 뒤 조용히 시작 (분류에 방해되지 않게)
setTimeout(async () => { const { data } = await sb.auth.getSession(); if (data.session) backfillFingerprints(); }, 60000);
setInterval(async () => { const { data } = await sb.auth.getSession(); if (data.session) backfillFingerprints(); }, 30 * 60000);

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
    msg.textContent = "초기화했어요. 알림장 탭에서 새로 올려 보세요.";
    await render();
  } catch { msg.textContent = "초기화 중 오류가 났어요. 다시 눌러 주세요."; }
});

/* ================= 새 버전 알림 ================= */
// 화면 파일이 바뀌면(제가 수정해서 올리면) 위에 알림 띄우기
async function siteVersion() {
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
  const fp = await siteVersion();
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
