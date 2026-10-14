import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FiveStack: Valorant party planner",
  description: "Find times for a full Valorant party across time zones, plan around dinner, and sync WFH days.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
