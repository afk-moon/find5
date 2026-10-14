import { fmtTime } from "@/lib/format";
import type { HeatRow } from "@/server/windows";

/** Week at a glance: each half hour from noon to 2am, colored by how many people are free. */
export function Heatmap({ rows, partySize, zone }: { rows: HeatRow[]; partySize: number; zone: string }) {
  const color = (count: number) =>
    count >= partySize
      ? "rgba(45, 212, 167, 0.85)"
      : count === partySize - 1
        ? "rgba(245, 196, 81, 0.5)"
        : count > 0
          ? `rgba(147, 163, 176, ${0.1 + 0.1 * count})`
          : "rgba(255, 255, 255, 0.03)";
  const ticks = rows[0]?.cells.filter((_, i) => i % 6 === 0) ?? [];
  return (
    <div className="space-y-1">
      {rows.map((row) => (
        <div key={row.date} className="flex items-center gap-2">
          <div className="w-8 shrink-0 text-xs text-muted">{row.label}</div>
          <div className="flex flex-1 gap-px">
            {row.cells.map((c) => (
              <div
                key={c.startMs}
                title={`${fmtTime(c.startMs, zone)}: ${c.count} free${c.dinner ? `, ${c.dinner} at dinner` : ""}`}
                className={`h-4 flex-1 rounded-[2px] ${c.inWindow ? "ring-1 ring-bone/70" : ""}`}
                style={{ background: color(c.count), opacity: c.past ? 0.3 : 1 }}
              />
            ))}
          </div>
        </div>
      ))}
      <div className="flex gap-2 pl-10 text-[10px] text-muted">
        {ticks.map((c) => (
          <div key={c.startMs} className="flex-1">
            {fmtTime(c.startMs, zone)}
          </div>
        ))}
      </div>
    </div>
  );
}
