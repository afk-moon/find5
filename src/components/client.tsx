"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

const LINKS = [
  { href: "/", label: "Windows", short: "Windows", icon: "📅" },
  { href: "/live", label: "Live", short: "Live", icon: "🎮" },
  { href: "/availability", label: "My availability", short: "My times", icon: "🖌️" },
  { href: "/wfh", label: "WFH sync", short: "WFH", icon: "🏠" },
  { href: "/settings", label: "Settings", short: "Settings", icon: "⚙️" },
];

/** Top links on tablets and up; on phones, `variant="bottom"` is a tab bar fixed to the bottom of the screen. */
export function NavLinks({ variant = "top" }: { variant?: "top" | "bottom" }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

  if (variant === "bottom") {
    return (
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-ink-2/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
        <div className="grid grid-cols-5">
          {LINKS.map((l) => {
            const active = isActive(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${active ? "text-bone" : "text-muted"}`}
              >
                <span className={`rounded-full px-3 py-0.5 text-base leading-tight ${active ? "bg-panel-2" : ""}`}>{l.icon}</span>
                {l.short}
              </Link>
            );
          })}
        </div>
      </nav>
    );
  }

  return (
    <nav className="hidden flex-wrap gap-1 sm:flex">
      {LINKS.map((l) => {
        const active = isActive(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-2.5 py-1 text-sm font-medium ${active ? "bg-panel-2 text-bone" : "text-muted hover:text-bone"}`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Re-fetch server data every few seconds (live lobby). */
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}

const noSubscribe = () => () => {};

/** The browser's IANA zone (null during server render and hydration). */
export function useBrowserZone(): string | null {
  return useSyncExternalStore(
    noSubscribe,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => null,
  );
}
