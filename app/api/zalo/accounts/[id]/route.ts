/**
 * GET    /api/zalo/accounts/[id]
 * PUT    /api/zalo/accounts/[id]
 * DELETE /api/zalo/accounts/[id]
 *
 * Proxy tới zalo-bridge + mirror Supabase.
 * PHASE 3: authorize theo staff — chỉ admin mới được PUT/DELETE.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentStaff, canViewAccount, canSendToAccount } from "@/lib/zalo/auth";

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

function paramName(id: string): string | null {
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(id) ? id : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!paramName(id)) return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
  const staff = await getCurrentStaff(req);
  if (!canViewAccount(staff, id)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const res = await proxy(`/auth/accounts/${id}`);
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message ?? "Bridge unreachable" }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!paramName(id)) return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
  const staff = await getCurrentStaff(req);
  if (staff.role !== "admin") {
    return NextResponse.json(
      { error: "Chỉ admin mới được cập nhật tài khoản" },
      { status: 403 }
    );
  }
  const body = await req.json().catch(() => ({}));
  try {
    const res = await proxy(`/auth/accounts/${id}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error ?? `bridge ${res.status}` },
        { status: res.status }
      );
    }
    return NextResponse.json(data);
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message ?? "Bridge unreachable" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!paramName(id)) return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
  const staff = await getCurrentStaff(req);
  if (staff.role !== "admin") {
    return NextResponse.json(
      { error: "Chỉ admin mới được xoá tài khoản" },
      { status: 403 }
    );
  }
  try {
    const res = await proxy(`/auth/accounts/${id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error ?? `bridge ${res.status}` },
        { status: res.status }
      );
    }
    return NextResponse.json(data);
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message ?? "Bridge unreachable" }, { status: 500 });
  }
}