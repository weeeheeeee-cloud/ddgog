// 명단 정리: A의 대표 사진 하나를 B로 옮기면, A의 나머지 대표 사진 중 B인 사진을 찾아 함께 옮김
// body: { from_id, to_id }  →  { moved: number, names: { from, to } }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("SPLIT_MODEL") ?? "claude-sonnet-5-5";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `You clean up reference photos at a dog daycare. Dog A's reference set accidentally contains photos of dog B.
You get dog B's confirmed photos first, then dog A's description and A's numbered reference photos.
For each numbered photo, decide whether the MAIN dog in it is dog B (not dog A). Compare coat colour/pattern, breed type,
ears, face, size and build; ignore clothes. Only list a photo when you are confident it shows dog B.
Reply with JSON only: {"b_photos":[<numbers>]}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "",
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "로그인이 필요해요" }, 401);
  let fromId = "", toId = "";
  try { ({ from_id: fromId, to_id: toId } = await req.json()); } catch { return json({ error: "bad request" }, 400); }
  if (!fromId || !toId || fromId === toId) return json({ error: "bad request" }, 400);

  const { data: dogs } = await supa.from("dogs").select("id, name, note, features, ref_path, dog_refs(id, path, created_at)").in("id", [fromId, toId]);
  const A = dogs?.find((d) => d.id === fromId), B = dogs?.find((d) => d.id === toId);
  if (!A || !B) return json({ error: "no dog" }, 404);
  const aRefs = (A.dog_refs ?? []).slice(0, 60);
  if (!aRefs.length) return json({ moved: 0 });
  const bRefs = (B.dog_refs ?? []).sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 6);
  if (!bRefs.length) return json({ moved: 0 });

  const img = async (path: string) => {
    const { data } = await supa.storage.from("refs").download(path);
    return data ? encodeBase64(new Uint8Array(await data.arrayBuffer())) : null;
  };
  const content: Record<string, unknown>[] = [{ type: "text", text: `Dog B: ${B.name}${B.note ? ` — ${B.note}` : ""}. Confirmed photos of B:` }];
  for (const r of bRefs) { const b = await img(r.path); if (b) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b } }); }
  content.push({ type: "text", text: `Dog A: ${A.name}${A.note ? ` — ${A.note}` : ""}. A's reference photos (some may be B):` });
  const idx: string[] = [];
  const loaded = await Promise.all(aRefs.map((r) => img(r.path)));
  aRefs.forEach((r, i) => {
    if (!loaded[i]) return;
    idx.push(r.id);
    content.push({ type: "text", text: `Photo ${idx.length}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: loaded[i] } });
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: SYSTEM, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) return json({ error: `AI ${res.status}` }, 503);
  const out = await res.json();
  const text: string = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  let nums: number[] = [];
  try { nums = (m ? JSON.parse(m[0]).b_photos : []) ?? []; } catch { /* 없음 */ }
  const ids = [...new Set(nums.map(Number).filter((n) => n >= 1 && n <= idx.length).map((n) => idx[n - 1]))];
  // 전부 다 B라고 하면 뭔가 이상한 것: 안전하게 멈춤
  if (!ids.length || ids.length >= idx.length) return json({ moved: 0 });
  await supa.from("dog_refs").update({ dog_id: B.id }).in("id", ids);
  const movedPaths = aRefs.filter((r) => ids.includes(r.id)).map((r) => r.path);
  if (A.ref_path && movedPaths.includes(A.ref_path)) {
    const next = aRefs.find((r) => !ids.includes(r.id))?.path ?? null;
    await supa.from("dogs").update({ ref_path: next }).eq("id", A.id);
  }
  if (!B.ref_path) await supa.from("dogs").update({ ref_path: movedPaths[0] }).eq("id", B.id);
  return json({ moved: ids.length, ids, names: { from: A.name, to: B.name } });
});
