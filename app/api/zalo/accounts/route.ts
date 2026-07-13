/**
 * GET /api/zalo/accounts
 * POST /api/zalo/accounts
 *
 * Proxy tới zalo-bridge. Bridge là source-of-truth về runtime status;
 * Supabase chỉ mirror metadata để UI web đọc nhanh mà không cần trực tiếp
 * gọi bridge.
 *
 * Backward compat: FE cũ hardcode "shop-owner" vẫn chạy — endpoint này trả
 * về cả account đó.
 *
 * PHASE 3: Authorize theo staff session.
 *   - Admin xem tất cả.
 *   - Staff chỉ thấy account trong staff_zalo_assignments.
 *   - POST yêu cầu admin (chỉ admin mới tạo TK mới).
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentStaff, canViewAccount } from "@/lib/zalo/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function bridgeBase(): string {
  return (
    process.env.ZALO_BRIDGE_URL ||
    process.env.NEXT_PUBLIC_ZALO_BRIDGE_URL ||
    "http://localhost:3001"
  ).replace(/\/+$/, "");
}

async function proxy(path: string, init?: RequestInit): Promise<Response> {
  const url = `${bridgeBase()}${path}`;
  const apiKey = process.env.BRIDGE_API_KEY || process.env.ZALO_BRIDGE_API_KEY || "";
  return fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      ...(init?.headers ?? {})
    }
  });
}

async function mirrorToSupabase(account: Record<string, unknown> | undefined) {
  if (!account) return;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !key) return;
  const row = {
    account_id: String(account.account_id),
    display_name: String(account.display_name ?? account.account_id),
    status: String(account.status ?? "disconnected"),
    zalo_user_id: (account.zalo_user_id as string | null) || null,
    zalo_display_name: (account.zalo_display_name as string | null) || null,
    last_seen_at: (account.last_seen_at as string | null) || null,
    updated_at: new Date().toISOString()
  };
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/zalo_accounts`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify(row)
    });
    // fetch() only throws on network errors, not HTTP 4xx/5xx — log those so a
    // schema mismatch (e.g. wrong column name) doesn't fail silently again.
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[zalo accounts] mirrorToSupabase failed for ${row.account_id}: ${res.status} ${text}`);
    }
  } catch (e) {
    console.warn(`[zalo accounts] mirrorToSupabase network error for ${row.account_id}:`, e);
  }
}

export async function GET(req: NextRequest) {
  try {
    const staff = await getCurrentStaff(req);
    const res = await proxy("/auth/accounts");
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { accounts: [], error: text || `bridge ${res.status}` },
        { status: res.status }
      );
    }
    const data = await res.json();
    let accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    // Self-heal: bridge là source-of-truth, nhưng account có thể tồn tại ở
    // bridge (auto-bootstrap "shop-owner", hoặc connect thẳng qua /connect
    // của bridge) mà CHƯA từng đi qua POST /api/zalo/accounts (nơi duy nhất
    // trước đây mirror sang Supabase) → thiếu row zalo_accounts → mọi FK
    // tham chiếu account_id (vd zalo_forward_rules) sẽ lỗi 23503. Mirror lại
    // mỗi account mỗi lần GET (fire-and-forget, không block response) để
    // Supabase luôn có đủ row cho FK, bất kể account được tạo/kết nối bằng
    // cách nào.
    for (const acc of accounts) {
      void mirrorToSupabase(acc).catch(() => undefined);
    }
    // PHASE 3: Filter theo quyền staff.
    if (staff.role !== "admin") {
      accounts = accounts.filter((a: { account_id: string }) =>
        canViewAccount(staff, a.account_id)
      );
    }
    return NextResponse.json({ accounts });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json(
      { accounts: [], error: err?.message ?? "Bridge unreachable" },
      { status: 200 } // 200 để FE fallback an toàn khi bridge down
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const staff = await getCurrentStaff(req);
    if (staff.role !== "admin") {
      return NextResponse.json(
        { error: "Chỉ admin mới có thể tạo tài khoản Zalo" },
        { status: 403 }
      );
    }
    const body = await req.json().catch(() => ({}));
    const res = await proxy("/auth/accounts", {
      method: "POST",
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error ?? `bridge ${res.status}` },
        { status: res.status }
      );
    }
    // Đồng thời upsert vào Supabase để lần sau GET trực tiếp Supabase vẫn thấy.
    // Best-effort, không block response.
    void mirrorToSupabase(data.account).catch(() => undefined);
    return NextResponse.json(data);
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message ?? "Bridge unreachable" }, { status: 500 });
  }
}