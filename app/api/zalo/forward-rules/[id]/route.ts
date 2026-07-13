/**
 * PATCH  /api/zalo/forward-rules/[id]
 *   body: { name?, is_enabled?, master_thread_id?, master_thread_name?,
 *           targets?: [{ target_thread_id, target_thread_name? }] }
 *   → cập nhật rule. Nếu `targets` có mặt → thay thế TOÀN BỘ danh sách target
 *     cũ bằng danh sách mới (đơn giản hoá UI: 1 nút Lưu = 1 PATCH).
 * DELETE /api/zalo/forward-rules/[id]
 *   → xoá rule (targets + logs cascade theo FK).
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentStaff, canBroadcastTo } from "@/lib/zalo/auth";

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

function ruleIdOf(id: string): number | null {
  return /^\d+$/.test(id) ? Number(id) : null;
}

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

async function loadExistingRuleGraph(accountId: string, excludeRuleId: number) {
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ruleId = ruleIdOf(id);
  if (ruleId == null) return NextResponse.json({ error: "Invalid rule id" }, { status: 400 });
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }

  const existingRes = await sb(`/zalo_forward_rules?id=eq.${ruleId}&select=*`);
  const [existingRule] = existingRes.ok ? await existingRes.json() : [];
  if (!existingRule) return NextResponse.json({ error: "Rule not found" }, { status: 404 });

  const staff = await getCurrentStaff(req);
  if (staff.role !== "admin" && !canBroadcastTo(staff, existingRule.account_id)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const masterThreadId =
    body?.master_thread_id != null ? String(body.master_thread_id).trim() : existingRule.master_thread_id;
  const targets: TargetInput[] | undefined = Array.isArray(body?.targets)
    ? body.targets
        .map((t: TargetInput) => ({
          target_thread_id: String(t?.target_thread_id || "").trim(),
          target_thread_name: t?.target_thread_name ?? null
        }))
        .filter((t: TargetInput) => t.target_thread_id)
    : undefined;

  if (targets && targets.length === 0) {
    return NextResponse.json({ error: "Cần chọn ít nhất 1 nhóm đích" }, { status: 400 });
  }

  try {
    if (targets || body?.master_thread_id != null) {
      const { existingMasters, existingTargetsFlat } = await loadExistingRuleGraph(
        existingRule.account_id,
        ruleId
      );
      const checkTargets = targets ?? [];
      // Nếu chỉ đổi master_thread_id mà không gửi targets mới, vẫn cần đảm bảo
      // master mới không trùng targets hiện có của chính rule này.
      if (!targets) {
        const currentTargetsRes = await sb(
          `/zalo_forward_targets?rule_id=eq.${ruleId}&select=target_thread_id`
        );
        const rows: Array<{ target_thread_id: string }> = currentTargetsRes.ok
          ? await currentTargetsRes.json()
          : [];
        checkTargets.push(...rows.map((r) => ({ target_thread_id: r.target_thread_id })));
      }
      const loopError = validateNoLoop(masterThreadId, checkTargets, existingMasters, existingTargetsFlat);
      if (loopError) return NextResponse.json({ error: loopError }, { status: 400 });
    }

    const updateRow: Record<string, unknown> = {};
    if (body?.name !== undefined) updateRow.name = body.name ? String(body.name).trim() : null;
    if (body?.is_enabled !== undefined) updateRow.is_enabled = !!body.is_enabled;
    if (body?.master_thread_id !== undefined) updateRow.master_thread_id = masterThreadId;
    if (body?.master_thread_name !== undefined) {
      updateRow.master_thread_name = body.master_thread_name
        ? String(body.master_thread_name).trim()
        : null;
    }

    if (Object.keys(updateRow).length > 0) {
      const res = await sb(`/zalo_forward_rules?id=eq.${ruleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updateRow)
      });
      if (!res.ok) {
        const text = await res.text();
        return NextResponse.json({ error: text || `supabase ${res.status}` }, { status: 500 });
      }
    }

    if (targets) {
      const delRes = await sb(`/zalo_forward_targets?rule_id=eq.${ruleId}`, { method: "DELETE" });
      if (!delRes.ok) {
        const text = await delRes.text();
        return NextResponse.json({ error: text || `supabase ${delRes.status}` }, { status: 500 });
      }
      const targetRows = targets.map((t) => ({
        rule_id: ruleId,
        target_thread_id: t.target_thread_id,
        target_thread_name: t.target_thread_name,
        is_enabled: true
      }));
      const insRes = await sb("/zalo_forward_targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(targetRows)
      });
      if (!insRes.ok) {
        const text = await insRes.text();
        return NextResponse.json({ error: text || `supabase ${insRes.status}` }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ruleId = ruleIdOf(id);
  if (ruleId == null) return NextResponse.json({ error: "Invalid rule id" }, { status: 400 });
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }

  const existingRes = await sb(`/zalo_forward_rules?id=eq.${ruleId}&select=account_id`);
  const [existingRule] = existingRes.ok ? await existingRes.json() : [];
  if (!existingRule) return NextResponse.json({ ok: true }); // đã xoá rồi

  const staff = await getCurrentStaff(req);
  if (staff.role !== "admin" && !canBroadcastTo(staff, existingRule.account_id)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const res = await sb(`/zalo_forward_rules?id=eq.${ruleId}`, { method: "DELETE" });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: text || `supabase ${res.status}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
