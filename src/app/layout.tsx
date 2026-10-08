import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KIS VTS PAPER 안전 대시보드",
  description: "실전 주문이 없는 한국투자증권 모의투자 PAPER 자동매매 대시보드",
  // iOS Safari/WKWebView (KakaoTalk in-app) data detectors wrap numbers, times and
  // prices in tel:/date links before React hydrates, which breaks hydration.
  formatDetection: { telephone: false, date: false, email: false, address: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning is a supplement only (one level deep): in-app
    // browsers/extensions may add attributes to <html>/<body> before hydration.
    <html
      lang="ko"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>{children}</body>
    </html>
  );
}
