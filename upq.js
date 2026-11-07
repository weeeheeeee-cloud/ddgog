// 선생님 사진 올리기: 휴대폰에 저장해 둔 사진을 차례로 올리는 공용 코드
// up.html(화면)과 sw.js(백그라운드)가 같이 씀. 둘이 동시에 올리지 않도록 잠금(lock)을 씀.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const FN = `${SUPABASE_URL}/functions/v1/teacher-upload`;
const HEADERS = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
export const LOCK = "ddg-upload";
export const SYNC_TAG = "ddg-upload";
export const CHANNEL = "ddg-upload";

/* ---------- 휴대폰 저장소 (IndexedDB) ---------- */
let dbp = null;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open("ddg-upload", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("q", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("q", mode);
    const req = fn(t.objectStore("q"));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
export const qPut = (item) => tx("readwrite", (st) => st.put(item));
export const qDel = (ids) => tx("readwrite", (st) => { ids.forEach((id) => st.delete(id)); });
export const qAll = async (token) => {
  const all = (await tx("readonly", (st) => st.getAll())) || [];
  return (token ? all.filter((x) => x.token === token) : all).sort((a, b) => a.at - b.at);
};

/* ---------- 서버 ---------- */
export async function call(token, body) {
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(FN, { method: "POST", headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY }, body: JSON.stringify({ token, ...body }) });
      const j = await r.json();
      if (r.status >= 500 && t < 3) { await sleep(1500 * (t + 1)); continue; }
      if (!r.ok) throw new Error(j.error || "오류");
      return j;
    } catch (e) { if (t === 3) throw e; await sleep(1500 * (t + 1)); }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// supabase-js 의 uploadToSignedUrl 과 같은 방식 (백그라운드에서도 쓰려고 직접 보냄)
async function putSigned(path, token, blob) {
  const url = new URL(`${SUPABASE_URL}/storage/v1/object/upload/sign/photos/${path.replace(/^\/+|\/+$/g, "")}`);
  url.searchParams.set("token", token);
  const body = new FormData();
  body.append("cacheControl", "3600");
  body.append("", blob);
  const res = await fetch(url, { method: "PUT", body, headers: { ...HEADERS, "x-upsert": "false" } });
  if (res.ok) return;
  let msg = `HTTP ${res.status}`;
  try { const j = await res.json(); msg = j.message || j.error || msg; } catch { /* 무시 */ }
  if (/exist|duplicate/i.test(msg)) return; // 이미 올라간 사진 (끊겼다 다시 올리는 경우)
  throw new Error(msg);
}
async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

/* ---------- 차례로 올리기 ----------
   stop(): true 를 돌려주면 지금 묶음까지만 하고 멈춤 (화면이 꺼졌을 때, 시간이 다 됐을 때)
   onBatch({added, skipped, failed}): 한 묶음 끝날 때마다
   wait: true 면 다른 쪽(화면/백그라운드)이 올리는 중일 때 끝날 때까지 기다렸다가 이어서 (백그라운드용)
   돌려주는 값: { added, skipped, failed, left, busy } — busy 면 다른 쪽이 올리는 중 */
export async function drain({ stop = () => false, onBatch = () => {}, wait = false } = {}) {
  const run = async () => {
    const sum = { added: 0, skipped: 0, failed: 0 };
    for (;;) {
      if (stop()) break;
      const all = await qAll();
      if (!all.length) break;
      const token = all[0].token;
      const next = all.filter((x) => x.token === token).slice(0, 10);
      const { urls } = await call(token, { action: "sign", items: next.map((p) => ({ id: p.id })) });
      const ok = [], bad = [];
      await pool(next, 4, async (p) => {
        const u = urls.find((x) => x.id === p.id);
        try {
          if (!u) throw new Error("no url");
          await putSigned(u.fullPath, u.full, p.full);
          await putSigned(u.thumbPath, u.thumb, p.small);
          ok.push(p);
        } catch {
          p.tries = (p.tries || 0) + 1;
          if (p.tries >= 4) bad.push(p.id); else await qPut(p);
        }
      });
      const res = { added: 0, skipped: 0, failed: bad.length };
      if (ok.length) {
        const r = await call(token, { action: "done", items: ok.map(({ id, taken_at, phash, sharp, vec }) => ({ id, taken_at, phash, sharp, vec })) });
        res.added = r.added || 0; res.skipped = r.skipped || 0;
      }
      await qDel([...ok.map((p) => p.id), ...bad]);
      sum.added += res.added; sum.skipped += res.skipped; sum.failed += res.failed;
      onBatch(res);
      if (!ok.length && !bad.length) break; // 전부 실패(연결 끊김 등): 나중에 다시
    }
    return { ...sum, left: (await qAll()).length };
  };
  const locks = (typeof navigator !== "undefined" && navigator.locks) || null;
  if (!locks) return run();
  if (wait) return locks.request(LOCK, run);
  return locks.request(LOCK, { ifAvailable: true }, async (lock) => (lock ? run() : { added: 0, skipped: 0, failed: 0, left: (await qAll()).length, busy: true }));
}
