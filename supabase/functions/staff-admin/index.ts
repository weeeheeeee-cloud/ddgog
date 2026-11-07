// 직원 계정 관리 (최고 관리자만): 사이트 관리 탭에서 호출
//  list                                  → { users: [{ id, email, name, role, last_sign_in_at, created_at }] }
//  create { email, password, name? }     → 새 직원 계정 (바로 로그인 가능)
//  reset  { user_id, password }          → 그 직원 비밀번호를 새로 정함
//  remove { user_id }                    → 직원 계정 삭제 (최고 관리자 계정은 못 지움)
//  rename { user_id, name }

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 부른 사람이 최고 관리자인지 확인
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "로그인이 필요해요" }, 401);
  const { data: me } = await admin.from("staff_roles").select("role").eq("user_id", user.id).maybeSingle();
  if (me?.role !== "owner") return json({ error: "최고 관리자만 할 수 있어요" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const isOwner = async (id: string) => (await admin.from("staff_roles").select("role").eq("user_id", id).maybeSingle()).data?.role === "owner";

  try {
    if (body.action === "list") {
      const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) throw error;
      const { data: roles } = await admin.from("staff_roles").select("user_id, role, name");
      const r = new Map((roles ?? []).map((x) => [x.user_id, x]));
      return json({
        me: user.id,
        users: data.users.map((u) => ({
          id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at ?? null,
          role: r.get(u.id)?.role ?? "staff", name: r.get(u.id)?.name ?? null,
        })).sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : a.created_at.localeCompare(b.created_at))),
      });
    }

    if (body.action === "create") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const name = String(body.name ?? "").trim() || null;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "이메일 주소를 확인해 주세요" }, 400);
      if (password.length < 6) return json({ error: "비밀번호는 6자 이상이어야 해요" }, 400);
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) return json({ error: /already|registered|exists/i.test(error.message) ? "이미 등록된 이메일이에요" : error.message }, 400);
      await admin.from("staff_roles").upsert({ user_id: data.user.id, role: "staff", name });
      return json({ ok: true, id: data.user.id });
    }

    if (body.action === "reset") {
      const id = String(body.user_id ?? ""), password = String(body.password ?? "");
      if (password.length < 6) return json({ error: "비밀번호는 6자 이상이어야 해요" }, 400);
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) throw error;
      return json({ ok: true });
    }

    if (body.action === "remove") {
      const id = String(body.user_id ?? "");
      if (id === user.id || await isOwner(id)) return json({ error: "최고 관리자 계정은 뺄 수 없어요" }, 400);
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (body.action === "rename") {
      const id = String(body.user_id ?? "");
      const name = String(body.name ?? "").trim() || null;
      const { data: row } = await admin.from("staff_roles").select("role").eq("user_id", id).maybeSingle();
      await admin.from("staff_roles").upsert({ user_id: id, role: row?.role ?? "staff", name });
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
  return json({ error: "unknown action" }, 400);
});
