/**
 * GET  /api/zalo/forward-rules?account_id=shop-owner
 *   → danh sách rule "nhóm chính → nhóm đích" (kèm targets) của 1 account.
 * POST /api/zalo/forward-rules
 *   body: { account_id, name?, master_thread_id, master_thread_name?,
 *           targets: [{ target_thread_id, target_thread_name? }], is_enabled? }
 *   → tạo rule mới. Yêu cầu admin hoặc staff có can_broadcast trên account đó.
 *
 * Lưu trực tiếp Supabase (bảng zalo_forward_rules/targets — xem migration
 * 2026-07-09). Bridge chỉ ĐỌC (cache 8s) qua forwardEngine.js, không cần biết
 * CRUD — giống pattern app/api/zalo/staff/route.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentStaff, canViewAccount, canBroadcastTo } from "@/lib/zalo/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "";

function sb(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      ...(init?.headers ?? {})
    }
  });
}

type TargetInput = { target_thread_id: string; target_thread_name?: string | null };

/**
 * Chặn cấu hình có thể gây lặp vô hạn (A forward sang B, B forward ngược lại A,
 * hoặc 1 nhóm vừa là master vừa là target của rule khác).
 * Chỉ kiểm tra ở phạm vi 1-hop (đủ cho mọi kịch bản thực tế) — không phải full
 * cycle-detection nhiều bước.
 */
function validateNoLoop(
  masterThreadId: string,
  targets: TargetInput[],
  existingMasters: Set<string>,
  existingTargetsFlat: Set<string>
): string | null {
  const targetIds = targets.map((t) => t.target_thread_id);
  if (targetIds.includes(masterThreadId)) {
    return "Nhóm đích không được trùng nhóm chính.";
  }
  for (const t of targetIds) {
    if (existingMasters.has(t)) {
      return `Nhóm "${t}" đang là nhóm chính của một luật khác — không thể đặt làm nhóm đích (sẽ gây lặp vô hạn).`;
    }
  }
  if (existingTargetsFlat.has(masterThreadId)) {
    return `Nhóm "${masterThreadId}" đang là nhóm đích của một luật khác — không thể đặt làm nhóm chính (sẽ gây lặp vô hạn).`;
  }
  return null;
}

async function loadExistingRuleGraph(accountId: string, excludeRuleId?: number) {
  const rulesRes = await sb(
    `/zalo_forward_rules?account_id=eq.${encodeURIComponent(accountId)}&is_enabled=eq.true&select=id,master_thread_id`
  );
  const rules: Array<{ id: number; master_thread_id: string }> = rulesRes.ok
    ? await rulesRes.json()
    : [];
  const filteredRules = rules.filter((r) => r.id !== excludeRuleId);
  const existingMasters = new Set(filteredRules.map((r) => r.master_thread_id));

  const existingTargetsFlat = new Set<string>();
  if (filteredRules.length > 0) {
    const ruleIds = filteredRules.map((r) => r.id).join(",");
    const targetsRes = await sb(
      `/zalo_forward_targets?is_enabled=eq.true&rule_id=in.(${ruleIds})&select=target_thread_id`
    );
    const rows: Array<{ target_thread_id: string }> = targetsRes.ok ? await targetsRes.json() : [];
    rows.forEach((r) => existingTargetsFlat.add(r.target_thread_id));
  }
  return { existingMasters, existingTargetsFlat };
}

export async function GET(req: NextRequest) {
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ rules: [], error: "supabase_unconfigured" });
  }
  const accountId = req.nextUrl.searchParams.get("account_id") || "shop-owner";
  const staff = await getCurrentStaff(req);
  if (!canViewAccount(staff, accountId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const rulesRes = await sb(
      `/zalo_forward_rules?account_id=eq.${encodeURIComponent(accountId)}&select=*&order=created_at.desc`
    );
    const rules = rulesRes.ok ? await rulesRes.json() : [];
    if (!Array.isArray(rules) || rules.length === 0) {
      return NextResponse.json({ rules: [] });
    }
    const ruleIds = rules.map((r: { id: number }) => r.id).join(",");
    const targetsRes = await sb(
      `/zalo_forward_targets?rule_id=in.(${ruleIds})&select=*&order=created_at.asc`
    );
    const targets = targetsRes.ok ? await targetsRes.json() : [];
    const byRule = new Map<number, unknown[]>();
    for (const t of targets as Array<{ rule_id: number }>) {
      const list = byRule.get(t.rule_id) || [];
      list.push(t);
      byRule.set(t.rule_id, list);
    }
    const result = rules.map((r: { id: number }) => ({
      ...r,
      targets: byRule.get(r.id) || []
    }));
    return NextResponse.json({ rules: result });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ rules: [], error: err?.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  const body = await req.json().catch(() => ({}));
  const accountId = String(body?.account_id || "").trim();
  const masterThreadId = String(body?.master_thread_id || "").trim();
  const targets: TargetInput[] = Array.isArray(body?.targets)
    ? body.targets
        .map((t: TargetInput) => ({
          target_thread_id: String(t?.target_thread_id || "").trim(),
          target_thread_name: t?.target_thread_name ?? null
        }))
        .filter((t: TargetInput) => t.target_thread_id)
    : [];

  if (!accountId || !masterThreadId) {
    return NextResponse.json({ error: "account_id và master_thread_id là bắt buộc" }, { status: 400 });
  }
  if (targets.length === 0) {
    return NextResponse.json({ error: "Cần chọn ít nhất 1 nhóm đích" }, { status: 400 });
  }

  const staff = await getCurrentStaff(req);
  if (staff.role !== "admin" && !canBroadcastTo(staff, accountId)) {
    return NextResponse.json(
      { error: "Bạn không có quyền cấu hình chuyển tiếp cho tài khoản này" },
      { status: 403 }
    );
  }

  try {
    const { existingMasters, existingTargetsFlat } = await loadExistingRuleGraph(accountId);
    const loopError = validateNoLoop(masterThreadId, targets, existingMasters, existingTargetsFlat);
    if (loopError) {
      return NextResponse.json({ error: loopError }, { status: 400 });
    }

    const ruleRow = {
      account_id: accountId,
      name: body?.name ? String(body.name).trim() : null,
      master_thread_id: masterThreadId,
      master_thread_name: body?.master_thread_name ? String(body.master_thread_name).trim() : null,
      is_enabled: body?.is_enabled !== false,
      created_by: staff.id || null
    };
    const ruleRes = await sb("/zalo_forward_rules", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(ruleRow)
    });
    if (!ruleRes.ok) {
      const text = await ruleRes.text();
      return NextResponse.json({ error: text || `supabase ${ruleRes.status}` }, { status: 500 });
    }
    const [rule] = await ruleRes.json();

    const targetRows = targets.map((t) => ({
      rule_id: rule.id,
      target_thread_id: t.target_thread_id,
      target_thread_name: t.target_thread_name,
      is_enabled: true
    }));
    const targetsRes = await sb("/zalo_forward_targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(targetRows)
    });
    if (!targetsRes.ok) {
      // Rollback rule — nếu không, rule mồ côi (is_enabled=true, 0 target) sẽ
      // âm thầm không forward gì (view v_zalo_forward_rules_active INNER JOIN
      // targets) trong khi UI vẫn báo "tạo thành công".
      const text = await targetsRes.text();
      await sb(`/zalo_forward_rules?id=eq.${rule.id}`, { method: "DELETE" });
      return NextResponse.json(
        { error: `Tạo nhóm đích thất bại, đã hủy rule: ${text || targetsRes.status}` },
        { status: 500 }
      );
    }
    const createdTargets = await targetsRes.json();

    return NextResponse.json({ rule: { ...rule, targets: createdTargets } });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
