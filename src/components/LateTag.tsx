import type { LateStats } from "@/engine/lateness";
import { MENACE_TAG, type Reputation } from "@/engine/reputation";
import type { MemberView } from "@/server/context";

/** "⏰ Frequently late" chip: voted late in more than half of their recent locked-in sessions. */
export function LateTag({ stats, className = "" }: { stats: LateStats; className?: string }) {
  if (!stats.frequentlyLate) return null;
  return (
    <span
      className={`chip shrink-0 whitespace-nowrap bg-quick/15 text-quick ${className}`}
      title={`Voted late in ${stats.late} of their last ${stats.sessions} sessions`}
    >
      ⏰ Frequently late
    </span>
  );
}

/** "🚨 Certified Menace": a comic sticker for 3 bannable offenses (each one is 3 teammates reporting them in a lobby). */
export function MenaceTag({ rep }: { rep: Reputation }) {
  if (!rep.menace) return null;
  return (
    <span
      className="inline-block shrink-0 -rotate-3 whitespace-nowrap rounded border-2 border-ink bg-maybe px-1.5 py-0.5 text-[10px] font-black uppercase italic tracking-wider text-ink shadow-[2px_2px_0_0_var(--color-val)]"
      title={`${rep.offenses} bannable offenses: in ${rep.offenses} lobbies, 3+ teammates reported them`}
    >
      {MENACE_TAG}
    </span>
  );
}

/** A member's name followed by their tags (frequently late, certified menace), if they have any. */
export function MemberName({ m, className = "font-semibold" }: { m: MemberView; className?: string }) {
  return (
    <>
      <span className={className}>{m.name}</span>
      <LateTag stats={m.lateness} />
      <MenaceTag rep={m.rep} />
    </>
  );
}
