"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

const LINKS = [
  { href: "/", label: "Windows" },
  { href: "/live", label: "Live" },
  { href: "/availability", label: "My availability" },
  { href: "/wfh", label: "WFH sync" },
  { href: "/settings", label: "Settings" },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="flex flex-wrap gap-1">
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
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
