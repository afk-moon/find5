import type { LateStats } from "@/engine/lateness";
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

/** A member's name followed by their late tag, if they have one. */
export function MemberName({ m, className = "font-semibold" }: { m: MemberView; className?: string }) {
  return (
    <>
      <span className={className}>{m.name}</span>
      <LateTag stats={m.lateness} />
    </>
  );
}
