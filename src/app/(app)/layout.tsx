import Link from "next/link";
import { logoutAction } from "@/app/actions";
import { Avatar } from "@/components/Avatar";
import { NavLinks } from "@/components/client";
import { zoneAbbr } from "@/lib/format";
import { requireViewer } from "@/server/context";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, ctx } = await requireViewer();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-ink-2/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="text-base font-black tracking-[0.18em] text-val sm:text-lg">
            RECEPTIONIST
          </Link>
          <NavLinks />
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="hidden text-muted lg:inline">{ctx.group.name}</span>
            <Avatar name={me.name} color={me.color} image={me.image} size={26} />
            <span className="hidden font-semibold sm:inline">{me.name}</span>
            <span className="chip hidden sm:inline-flex">{zoneAbbr(me.timezone)}</span>
            <form action={logoutAction}>
              <button className="btn btn-ghost px-2 py-1 text-xs">Switch</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pt-6 pb-28 sm:pb-6">{children}</main>
      <NavLinks variant="bottom" />
    </div>
  );
}
