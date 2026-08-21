import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "楽天管理システム MVP",
  description: "Rakuten operations MVP dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
