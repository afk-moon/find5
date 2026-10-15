import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Receptionist: Valorant party planner",
  description: "Find times for a full Valorant party across time zones, plan around dinner, and sync WFH days.",
};

/** Phone browsers tint their toolbar with this color. */
export const viewport: Viewport = { themeColor: "#0f1923", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
