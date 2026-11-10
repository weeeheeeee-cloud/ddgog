// 댕겨올개 사진함 → 다이얼독 알림장 바로 전송
// 다이얼독 파트너 화면(dialodog.com/partners)에서 북마크를 누르면 실행돼요.
// 다이얼독 오늘 출석부(유치원 예약)에 있는 아이만, 사진함에서 분류된 사진 + 정해 둔 글을 아이별 알림장으로 보호자에게 바로 전송해요.
// 보내기 전에 한 번 더 물어봐요. H(호텔링) 아이는 넣지 않고, 출석부에 없어서 못 넣은 아이는 따로 알려 줘요.
(async () => {
  const FN = "https://urvtilhpvzcczcxedeim.supabase.co/functions/v1/dd-push";
  const TOKEN = window.__DDG_TOKEN || "";
  const MAX = 50; // 다이얼독 알림장 한 건에 사진 최대 50장

  if (!/(^|\.)dialodog\.com$/.test(location.hostname) || !location.pathname.startsWith("/partners")) {
    alert("다이얼독 파트너 화면(dialodog.com/partners)에 로그인한 뒤 눌러 주세요.");
    return;
  }
  document.getElementById("ddg-panel")?.remove();

  /* ---------- 화면 ---------- */
  const css = `
  #ddg-panel{position:fixed;top:16px;right:16px;z-index:2147483000;width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    background:#f0ede6;color:#0f1b2d;border-radius:22px;box-shadow:0 24px 60px rgba(0,0,0,.28);font:14px/1.45 Pretendard,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;overflow:hidden}
  #ddg-panel *{box-sizing:border-box}
  #ddg-panel .hd{background:#003B89;color:#f0ede6;padding:16px 18px;display:flex;align-items:center;gap:10px}
  #ddg-panel .hd b{font-size:16px;flex:1}
  #ddg-panel .hd small{display:block;font-weight:500;opacity:.75;font-size:12px}
  #ddg-panel .x{background:none;border:0;color:#f0ede6;font-size:22px;cursor:pointer;line-height:1}
  #ddg-panel .bd{padding:14px 16px;overflow:auto}
  #ddg-panel .row{display:flex;align-items:center;gap:10px;background:#fff;border-radius:14px;padding:10px 12px;margin-bottom:8px}
  #ddg-panel .row.off{opacity:.55}
  #ddg-panel .row input{width:18px;height:18px;accent-color:#003B89}
  #ddg-panel .nm{flex:1;font-weight:700}
  #ddg-panel .nm small{display:block;font-weight:500;color:#6c7280;font-size:12px}
  #ddg-panel .n{font-weight:800;color:#003B89}
  #ddg-panel .ft{padding:12px 16px 16px;display:flex;gap:8px;border-top:1px solid #e4dfd4}
  #ddg-panel button.go{flex:1;border:0;border-radius:999px;background:#FCCC00;color:#003B89;font-weight:800;font-size:15px;padding:12px;cursor:pointer;box-shadow:0 4px 0 -1px #d8ae00}
  #ddg-panel button.go:disabled{opacity:.5;cursor:default}
  #ddg-panel button.sub{border:0;border-radius:999px;background:#fff;color:#0f1b2d;font-weight:700;padding:12px 16px;cursor:pointer}
  #ddg-panel .msg{color:#6c7280;font-size:13px;margin:0 0 10px}
  #ddg-panel .bar{height:10px;background:#fff;border-radius:99px;overflow:hidden;margin:6px 0 12px}
  #ddg-panel .bar i{display:block;height:100%;width:0;background:#FCCC00;transition:width .2s}
  #ddg-panel .err{color:#b91c1c;font-weight:700}
  #ddg-panel .ok{color:#15803d;font-weight:700}
  #ddg-panel .note{background:#fff;border-radius:14px;padding:10px 12px;margin-bottom:10px}
  #ddg-panel .note b{display:block;font-size:13px;margin-bottom:6px}
  #ddg-panel .note textarea{width:100%;min-height:96px;border:1px solid #e4dfd4;border-radius:10px;padding:8px 10px;font:inherit;resize:vertical;background:#fbfaf7;color:#0f1b2d}
  #ddg-panel .note small{display:block;color:#6c7280;font-size:12px;margin-top:4px}
  #ddg-panel .miss{background:#fff4e5;border:1px solid #f5c58a;border-radius:14px;padding:10px 12px;margin-bottom:10px;color:#8a4b00}
  #ddg-panel .miss b{display:block;margin-bottom:2px}
  #ddg-panel .sec{font-size:12px;font-weight:800;color:#6c7280;margin:12px 2px 6px}
  #ddg-panel .mem{background:rgba(255,255,255,.14);border:0;color:#f0ede6;border-radius:999px;padding:7px 11px;font-weight:700;font-size:12.5px;cursor:pointer;white-space:nowrap}
  #ddg-panel .mem:disabled{opacity:.6;cursor:default}
  #ddg-panel .mbar{display:none;padding:10px 16px;font-size:13px;font-weight:700;background:#e9f7ee;color:#15803d}
  #ddg-panel .mbar.on{display:block}
  #ddg-panel .mbar.bad{background:#fde8e6;color:#b91c1c}`;
  const panel = document.createElement("div");
  panel.id = "ddg-panel";
  panel.innerHTML = `<style>${css}</style>
    <div class="hd"><b>댕겨올개 → 알림장<small>다이얼독 오늘 출석부 아이만 · 호텔링(H) 제외</small></b><button class="mem" title="다이얼독 회원 명단을 댕겨올개 유치원 탭으로">👥 회원 명단 가져오기</button><button class="x" title="닫기">×</button></div>
    <div class="mbar"></div>
    <div class="bd"><p class="msg">불러오는 중…</p></div>
    <div class="ft"></div>`;
  document.body.appendChild(panel);
  const $bd = panel.querySelector(".bd"), $ft = panel.querySelector(".ft");
  panel.querySelector(".x").onclick = () => panel.remove();
  // 다이얼독 회원 명단 → 댕겨올개 유치원 탭 (알림장 보내기와 상관없이 따로)
  panel.querySelector(".mem").onclick = async (e) => {
    const btn = e.currentTarget, bar = panel.querySelector(".mbar");
    btn.disabled = true; btn.textContent = "가져오는 중…"; bar.className = "mbar on"; bar.textContent = "다이얼독 회원 명단을 읽고 있어요…";
    try {
      const j = await dd("pets?perPage=3000");
      const pets = j?.pets || [];
      if (!pets.length) throw new Error("다이얼독 회원 명단이 비어 있어요");
      const r = await fn({ action: "members", pets });
      bar.textContent = `✅ 유치원 탭에 ${r.total}마리 넣었어요 (새로 ${r.added} · 갱신 ${r.updated}${r.gone ? ` · 그만 다님 ${r.gone}` : ""})`;
    } catch (err) { bar.className = "mbar on bad"; bar.textContent = `⚠️ ${err.message}`; }
    btn.disabled = false; btn.textContent = "👥 회원 명단 가져오기";
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fail = (m) => { $bd.innerHTML = `<p class="err">${esc(m)}</p>`; $ft.innerHTML = `<button class="sub">닫기</button>`; $ft.querySelector("button").onclick = () => panel.remove(); };

  /* ---------- 요청 ---------- */
  // 다이얼독 (같은 사이트, 로그인 쿠키 사용)
  const dd = (url) => new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open("GET", `/partners/${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`);
    x.setRequestHeader("X-Client-Type", "WEB");
    x.setRequestHeader("Accept", "application/json");
    x.onload = () => (x.status === 200 ? res(JSON.parse(x.responseText || "null")) : rej(new Error(x.status === 401 ? "다이얼독에 다시 로그인해 주세요." : `다이얼독 ${x.status}`)));
    x.onerror = () => rej(new Error("다이얼독에 연결하지 못했어요"));
    x.send();
  });
  // 사진함 서버 (로그인 쿠키 없이)
  const fn = (body) => new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open("POST", FN);
    x.setRequestHeader("content-type", "application/json");
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch { /* 무시 */ } x.status === 200 ? res(j) : rej(new Error(j.error || `댕겨올개 ${x.status}`)); };
    x.onerror = () => rej(new Error("댕겨올개 사이트에 연결하지 못했어요"));
    x.send(JSON.stringify({ token: TOKEN, ...body }));
  });
  const getBlob = (url) => new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open("GET", url); x.responseType = "blob";
    x.onload = () => (x.status === 200 ? res(x.response) : rej(new Error(`사진 ${x.status}`)));
    x.onerror = () => rej(new Error("사진을 받지 못했어요"));
    x.send();
  });
  async function rotate(blob, deg) {
    if (!deg) return blob;
    const img = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    const side = deg % 180 !== 0;
    c.width = side ? img.height : img.width; c.height = side ? img.width : img.height;
    const g = c.getContext("2d");
    g.translate(c.width / 2, c.height / 2); g.rotate((deg * Math.PI) / 180); g.drawImage(img, -img.width / 2, -img.height / 2);
    img.close?.();
    return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  }
  // 다이얼독 알림장 화면과 똑같은 방식: 사진 먼저 올리고(attachments), 알림장 모델로 전송 (임시저장 표시 없이 저장 = 전송)
  async function uploadAttachment(blob, name) {
    const fd = new FormData();
    fd.append("file", new File([blob], name, { type: "image/jpeg" }));
    const r = await window.fetch("attachments", { method: "POST", body: fd });
    if (r.status !== 200) throw new Error(`사진 올리기 실패 (${r.status})`);
    const t = await r.text();
    const a = JSON.parse(t);
    if (!a?.id) throw new Error("사진 올리기 실패");
    return a.id;
  }
  const appP = new Promise((res) => window.require(["app"], res));
  async function sendReport(petId, attachmentIds, content) {
    const app = await appP;
    const now = new Date().toISOString();
    const model = new app.report.ReportModel();
    await new Promise((res, rej) => model.save(
      { reportingDate: now, content: content || "", recipients: [petId], attachments: attachmentIds },
      { success: res, error: (m, r) => rej(new Error(`전송 실패 (${r?.status})`)) },
    ));
  }
  async function pool(items, limit, f) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; await f(items[k], k); } }));
  }

  /* ---------- 목록 ---------- */
  if (!TOKEN) return fail("북마크에 열쇠가 없어요. 댕겨올개 관리자 탭에서 북마크를 다시 만들어 주세요.");
  let daycare, unsent, drafts, mine;
  try {
    [daycare, unsent, drafts, mine] = await Promise.all([
      dd("reports/pets?daycare=true&hotel=false&unsent=false"),
      dd("reports/pets?daycare=true&hotel=false&unsent=true"),
      dd("reports/drafts").catch(() => []),
      fn({ action: "list" }),
    ]);
  } catch (e) { return fail(e.message); }
  const unsentIds = new Set((unsent || []).map((p) => String(p.id)));
  const draftText = JSON.stringify(drafts || []);
  const photosOf = new Map((mine.dogs || []).map((d) => [String(d.petId), d]));
  let noteText = mine.note || "";
  const rollIds = new Set((daycare || []).map((p) => String(p.id)));
  // 사진은 분류됐는데 다이얼독 오늘 출석부에 없는 아이 (H 호텔링은 원래 안 넣으니 빼고)
  const missing = [
    ...(mine.dogs || []).filter((d) => !rollIds.has(String(d.petId)) && !d.hotel && d.photos.some((x) => !x.pushed)).map((d) => d.name),
    ...(mine.others || []).filter((o) => !o.hotel).map((o) => o.name),
  ].sort((a, b) => a.localeCompare(b, "ko"));
  const rows = (daycare || []).map((p) => {
    const d = photosOf.get(String(p.id));
    const fresh = (d?.photos || []).filter((x) => !x.pushed);
    let state = "ready", note = "";
    if (d?.hotel) { state = "hotel"; note = "호텔링(H)이라 넣지 않아요"; }
    else if (!unsentIds.has(String(p.id))) { state = "sent"; note = "오늘 알림장 이미 보냄"; }
    else if (draftText.includes(String(p.id))) { state = "draft"; note = "임시보관함에 이 아이 알림장이 있어요 (겹치지 않게 빼요)"; }
    else if (!fresh.length) { state = "none"; note = d?.photos?.length ? "사진을 이미 넣었어요" : "댕겨올개에 분류된 사진이 없어요"; }
    else if (fresh.length > MAX) note = `${fresh.length}장 중 ${MAX}장만 (다이얼독 최대)`;
    return { pet: p, photos: fresh.slice(0, MAX), state, note, on: state === "ready" };
  }).sort((a, b) => (a.state === "ready" ? 0 : 1) - (b.state === "ready" ? 0 : 1) || a.pet.name.localeCompare(b.pet.name, "ko"));

  const missHtml = () => missing.length
    ? `<div class="miss"><b>⚠️ 출석부에 없어서 못 넣는 아이 ${missing.length}마리</b>${missing.map(esc).join(", ")}<br><small>다이얼독 오늘 출석부에 없어요. 예약을 넣거나 직접 알림장을 써 주세요.</small></div>` : "";
  function drawList() {
    const ready = rows.filter((r) => r.on);
    $bd.innerHTML = `<p class="msg">${+mine.day.slice(5, 7)}월 ${+mine.day.slice(8, 10)}일 출석부 ${rows.length}마리 · 분류된 사진과 아래 글을 아이별 알림장으로 <b>보호자에게 바로 전송</b>해요.</p>`
      + `<div class="note"><b>✍️ 알림장 글 (모든 아이 똑같이 들어가요)</b><textarea id="ddg-note" maxlength="1000" placeholder="글 없음 — 사진만 넣어요">${esc(noteText)}</textarea><small>댕겨올개 사이트의 📮 다이얼독 알림장 버튼에서 붙여 넣은 글이에요 · 여기서 고쳐도 돼요</small></div>`
      + missHtml()
      + `<div class="sec">출석부 아이</div>`
      + (rows.length ? rows.map((r, i) => `<label class="row ${r.state === "ready" ? "" : "off"}">
          <input type="checkbox" data-i="${i}" ${r.on ? "checked" : ""} ${r.state === "ready" ? "" : "disabled"}>
          <span class="nm">${esc(r.pet.name)}${r.note ? `<small>${esc(r.note)}</small>` : ""}</span>
          <span class="n">${r.state === "ready" ? `${r.photos.length}장` : ""}</span></label>`).join("")
        : `<p class="msg">오늘 유치원 예약이 없어요.</p>`);
    $ft.innerHTML = `<button class="sub">닫기</button><button class="go" ${ready.length ? "" : "disabled"}>${ready.length ? `${ready.length}마리 전송` : "넣을 아이가 없어요"}</button>`;
    $ft.querySelector(".sub").onclick = () => panel.remove();
    $ft.querySelector(".go").onclick = run;
    $bd.querySelector("#ddg-note").oninput = (e) => { noteText = e.target.value; };
    $bd.querySelectorAll("input[data-i]").forEach((el) => (el.onchange = () => { rows[+el.dataset.i].on = el.checked; drawList(); }));
  }
  drawList();

  /* ---------- 전송 ---------- */
  async function run() {
    const todo = rows.filter((r) => r.on);
    if (!confirm(`${todo.length}마리 알림장을 보호자에게 바로 전송할까요?\n보낸 뒤에는 되돌릴 수 없어요.${noteText.trim() ? "" : "\n(글 없이 사진만 가요)"}`)) return;
    const content = noteText.trim();
    if (content !== (mine.note || "").trim()) await fn({ action: "note", text: content }).catch(() => {}); // 다음에도 같은 글
    const total = todo.reduce((n, r) => n + r.photos.length, 0);
    let sent = 0, okDogs = 0;
    const errs = [];
    $ft.innerHTML = "";
    const draw = (now) => {
      $bd.innerHTML = `<p class="msg">${esc(now)}</p><div class="bar"><i style="width:${total ? (sent / total) * 100 : 0}%"></i></div>
        <p class="msg">사진 ${sent} / ${total}장 · 알림장 ${okDogs} / ${todo.length}건 · 끝날 때까지 이 화면을 닫지 말아 주세요</p>`;
    };
    for (const r of todo) {
      draw(`${r.pet.name} 사진 올리는 중…`);
      try {
        const ids = new Array(r.photos.length);
        await pool(r.photos, 3, async (p, k) => {
          const blob = await rotate(await getBlob(p.url), p.rotation);
          ids[k] = await uploadAttachment(blob, `${r.pet.name}-${k + 1}.jpg`);
          sent++; draw(`${r.pet.name} 사진 올리는 중…`);
        });
        draw(`${r.pet.name} 알림장 보내는 중…`);
        await sendReport(r.pet.id, ids, content);
        okDogs++;
        await fn({ action: "mark", items: r.photos.map((p) => ({ photo_id: p.id, pet_id: String(r.pet.id) })) }).catch(() => {});
      } catch (e) {
        errs.push(`${r.pet.name}: ${e.message}`);
      }
    }
    $bd.innerHTML = `<p class="${errs.length ? "err" : "ok"}">${okDogs}건을 보호자에게 보냈어요${errs.length ? ` · ${errs.length}건 실패` : ""}</p>`
      + (errs.length ? `<p class="msg">${errs.map(esc).join("<br>")}</p>` : "")
      + missHtml()
      + `<p class="msg">알림장 목록에서 보낸 알림장을 볼 수 있어요.</p>`;
    $ft.innerHTML = `<button class="sub">닫기</button><button class="go">알림장 목록 보기</button>`;
    $ft.querySelector(".sub").onclick = () => panel.remove();
    $ft.querySelector(".go").onclick = () => { location.hash = "#reports"; panel.remove(); };
  }
})();
