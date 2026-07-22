import Link from "next/link";
import { MessageCircle, Send, ShoppingBag, Users2 } from "lucide-react";

const links = [
  {
    href: "/thong-bao-zalo",
    icon: MessageCircle,
    title: "Thông báo Zalo",
    description: "Đọc / trả lời tin nhắn, gửi broadcast."
  },
  {
    href: "/zalo/accounts",
    icon: Users2,
    title: "Quản lý tài khoản Zalo",
    description: "Kết nối tài khoản Zalo (quét QR), quản lý nhân viên."
  },
  {
    href: "/zalo/forward-rules",
    icon: Send,
    title: "Chuyển tiếp tin nhắn tự động",
    description: "Cấu hình nhóm chính → nhóm đích để tự động forward."
  },
  {
    href: "/zalo/shopee-shops",
    icon: ShoppingBag,
    title: "Kho tri thức sản phẩm Shopee",
    description: "Thêm shop Shopee để crawl sản phẩm — nguồn dữ liệu cho chatbot tư vấn."
  }
];

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 p-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Zalo Forward Demo</h1>
        <p className="mt-1 text-sm text-slate-500">
          Demo tính năng chuyển tiếp tin nhắn Zalo tự động (tách từ InvoiceFlowManager).
        </p>
      </div>
      <div className="grid gap-3">
        {links.map(({ href, icon: Icon, title, description }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-primary/40 hover:bg-primary/5"
          >
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold text-slate-900">{title}</div>
              <div className="text-xs text-slate-500">{description}</div>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
