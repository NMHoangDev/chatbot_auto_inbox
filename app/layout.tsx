import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppProvider } from "@/components/providers/AppProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zalo Forward Demo",
  description: "Demo tính năng chuyển tiếp tin nhắn Zalo tự động"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
