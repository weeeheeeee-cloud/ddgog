// 백그라운드 사진 올리기 (안드로이드 크롬): 화면을 닫거나 다른 앱을 써도 남은 사진을 계속 올림
// 화면 가로채기(fetch)는 하지 않음. 사진함 화면에는 영향 없음.
import { drain, qAll, SYNC_TAG, CHANNEL } from "./upq.js";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("sync", (e) => {
  if (e.tag !== SYNC_TAG) return;
  e.waitUntil(runSync(e.lastChance));
});

async function runSync(lastChance) {
  const started = Date.now();
  const ch = new BroadcastChannel(CHANNEL);
  const r = await drain({
    wait: true, // 화면이 마지막 묶음을 올리는 중이면 끝나길 기다렸다가 이어서
    stop: () => Date.now() - started > 150000, // 백그라운드 허용 시간 안에서만 (약 2분 30초)
    onBatch: (b) => ch.postMessage({ type: "batch", ...b }),
  });
  ch.postMessage({ type: "end", ...r });
  ch.close();
  if (r.busy) return; // 화면에서 올리는 중
  if (r.left && !lastChance) throw new Error("남은 사진 있음"); // 실패로 끝내야 브라우저가 잠시 뒤 다시 깨워 줌
  await notify(r);
}

async function notify(r) {
  if (!r.added && !r.left) return;
  // 화면을 보고 있으면 알림 대신 화면에 표시
  const wins = await self.clients.matchAll({ type: "window" });
  if (wins.some((w) => w.visibilityState === "visible" && w.url.includes("up.html"))) return;
  if (self.Notification?.permission !== "granted") return;
  const left = (await qAll()).length;
  await self.registration.showNotification(left ? "사진을 다 올리지 못했어요" : "사진 올리기 끝", {
    body: left ? `${left}장이 남았어요. 사진 올리기 링크를 다시 열면 이어서 올려요.` : `${r.added}장을 올렸어요${r.skipped ? ` (똑같은 사진 ${r.skipped}장은 건너뜀)` : ""}`,
    icon: "logo-180.png",
    badge: "logo-180.png",
    tag: "ddg-upload",
  });
}

// 폰 알림 (픽드랍 변경 등): 서버(pd 함수)가 보낸 내용을 띄움
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "댕겨올개", {
    body: d.body || "",
    icon: "logo-192.png",
    badge: "logo-192.png",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || "./" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (url) {
      // 열려 있는 댕겨올개 화면이 있으면 그 화면에서 탭만 바꿈
      const tab = new URL(url, self.location.href).hash.slice(1);
      const w = wins.find((x) => !x.url.includes("up.html") && !x.url.includes("pd.html"));
      if (w) { await w.focus(); if (tab) w.postMessage({ type: "open-tab", tab }); return; }
      return self.clients.openWindow(url);
    }
    const w = wins.find((x) => x.url.includes("up.html"));
    if (w) return w.focus();
  })());
});
