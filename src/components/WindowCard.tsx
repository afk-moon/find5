import { sessionTimeline, type Pause, type PlayWindow } from "@/engine";
import { fmtDay, fmtDuration, fmtRange, fmtTime, zoneAbbr } from "@/lib/format";
import type { GameContext } from "@/server/context";
import { Avatar } from "./Avatar";
import { LateTag } from "./LateTag";

/** Play (green) and dinner-pause (orange) segments across the window. */
export function TimelineBar({ startMs, endMs, pauses }: { startMs: number; endMs: number; pauses: Pause[] }) {
  const total = endMs - startMs;
  const segments: Array<{ from: number; to: number; pause: boolean }> = [];
  let cursor = startMs;
  for (const p of pauses) {
    if (p.startMs > cursor) segments.push({ from: cursor, to: p.startMs, pause: false });
    segments.push({ from: p.startMs, to: p.endMs, pause: true });
    cursor = p.endMs;
  }
  if (cursor < endMs) segments.push({ from: cursor, to: endMs, pause: false });
  return (
    <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-ink-2">
      {segments.map((s, i) => (
        <div
          key={i}
          className={s.pause ? "bg-quick" : "bg-free"}
          style={{ width: `${((s.to - s.from) / total) * 100}%` }}
        />
      ))}
    </div>
  );
}

/** Session plan in the viewer's zone: last queue, dinner pauses, wrap-up. */
export function SessionPlan({
  ctx,
  w,
  zone,
}: {
  ctx: GameContext;
  w: Pick<PlayWindow, "startMs" | "endMs" | "pauses">;
  zone: string;
}) {
  const nameOf = (id: string) => ctx.byId.get(id)?.name ?? "someone";
  const events = sessionTimeline(w, ctx.game.matchMinutes).filter(
    (e) => e.kind === "last-queue" || e.kind === "pause",
  );
  if (!events.length) return null;
  return (
    <ul className="space-y-0.5 text-sm text-muted">
      {events.map((e, i) =>
        e.kind === "pause" ? (
          <li key={i}>
            🍔 <span className="text-bone">{fmtRange(e.atMs, e.untilMs, zone)}</span> pause while{" "}
            {e.who.map(nameOf).join(" & ")} {e.who.length === 1 ? "eats" : "eat"}
          </li>
        ) : (
          <li key={i}>
            ⏰ <span className="text-bone">{fmtTime(e.atMs, zone)}</span> last queue
            {e.kind === "last-queue" && e.reason === "pause" ? " before dinner" : ""}
          </li>
        ),
      )}
    </ul>
  );
}

export function WindowCard({
  ctx,
  w,
  zone,
  action,
}: {
  ctx: GameContext;
  w: PlayWindow;
  zone: string;
  action?: React.ReactNode;
}) {
  const P = ctx.game.partySize;
  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="label">{fmtDay(w.startMs, zone)}</div>
          <div className="text-xl font-bold">
            {fmtRange(w.startMs, w.endMs, zone)} <span className="text-sm font-medium text-muted">{zoneAbbr(zone, w.startMs)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="chip">🎮 {fmtDuration(w.playMinutes)} of play</span>
          {w.pauses.length > 0 && <span className="chip">🍔 {w.pauses.length} pause{w.pauses.length > 1 ? "s" : ""}</span>}
          {w.subs > 0 && <span className="chip text-free">+{w.subs} sub{w.subs > 1 ? "s" : ""}</span>}
          {action}
        </div>
      </div>
      <TimelineBar startMs={w.startMs} endMs={w.endMs} pauses={w.pauses} />
      <SessionPlan ctx={ctx} w={w} zone={zone} />
      <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-3">
        {w.party.map((id) => {
          const m = ctx.byId.get(id);
          if (!m) return null;
          return (
            <div key={id} className="flex items-center gap-2 text-sm">
              <Avatar name={m.name} color={m.color} image={m.image} size={24} />
              <span>
                <span className="font-semibold">{m.name}</span>{" "}
                {m.lateness.frequentlyLate && (
                  <>
                    <LateTag stats={m.lateness} />{" "}
                  </>
                )}
                <span className="text-muted">
                  {fmtRange(w.startMs, w.endMs, m.timezone)} {zoneAbbr(m.timezone, w.startMs)}
                </span>
                {w.ifNeeded.includes(id) && <span className="ml-1 text-xs text-maybe">if needed</span>}
              </span>
            </div>
          );
        })}
        {w.party.length > P && <span className="self-center text-xs text-muted">{w.party.length} available, need {P}</span>}
      </div>
    </div>
  );
}
