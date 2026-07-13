"use client";

import dynamic from "next/dynamic";
import { Download } from "lucide-react";
import ZaloAccountSwitcher from "@/components/zalo/ZaloAccountSwitcher";

const ZaloPageContent = dynamic(
  () => import("@/components/zalo/ZaloPageContent").then((m) => m.ZaloPageContent),
  {
    ssr: false,
    loading: () => (
      <div className="grid h-full place-items-center p-8 text-sm text-slate-500">
        Đang tải Zalo...
      </div>
    ),
  }
);

// Trang cài extension tự-host bởi bridge (services/zalo-bridge/src/public/extension-install.html),
// thay cho link Google Drive cá nhân của bản gốc.
const BRIDGE_URL =
  process.env.NEXT_PUBLIC_ZALO_BRIDGE_URL || "http://localhost:3001";
const EXTENSION_INSTALL_URL = `${BRIDGE_URL.replace(/\/+$/, "")}/extension-install`;

/**
 * Trang thông báo Zalo. Bản gốc gate sau 1 hệ thống login nhân viên
 * (current_staff_id cookie) — demo này bỏ gate đó (mọi request coi như admin
 * hệ thống, xem lib/zalo/auth.ts#getCurrentStaff fallback), vào thẳng
 * ZaloPageContent.
 */
export default function ZaloPage() {
  return (
    <div className="flex h-screen flex-col p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h1 className="text-sm font-semibold text-slate-700">
          Thông báo Zalo
        </h1>
        <div className="flex items-center gap-2">
          <a
            href={EXTENSION_INSTALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
            title="Cài extension Chrome đăng nhập Zalo"
          >
            <Download className="h-3.5 w-3.5" />
            Tải extension
          </a>
          <ZaloAccountSwitcher />
        </div>
      </div>

      <ZaloPageContent />
    </div>
  );
}
