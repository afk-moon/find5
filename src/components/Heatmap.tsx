import { fmtTime } from "@/lib/format";
import type { HeatRow } from "@/server/windows";

/**
 * Week at a glance: one column per day, each half hour from noon (top) to 2am (bottom), colored by how
 * many people are free. Vertical, so it fits a phone screen and the narrow sidebar on desktop.
 */
export function Heatmap({ rows, partySize, zone }: { rows: HeatRow[]; partySize: number; zone: string }) {
  const color = (count: number) =>
    count >= partySize
      ? "rgba(45, 212, 167, 0.85)"
      : count === partySize - 1
        ? "rgba(245, 196, 81, 0.5)"
        : count > 0
          ? `rgba(147, 163, 176, ${0.1 + 0.1 * count})`
          : "rgba(255, 255, 255, 0.03)";
  const times = rows[0]?.cells ?? [];
  return (
    <div className="grid gap-x-1" style={{ gridTemplateColumns: `2.75rem repeat(${rows.length}, minmax(0, 1fr))` }}>
      <div />
      {rows.map((row) => (
        <div key={row.date} className="pb-1 text-center text-[11px] font-semibold text-muted">
          {row.label}
        </div>
      ))}
      <div className="flex flex-col gap-px">
        {times.map((c, i) => (
          <div key={c.startMs} className="relative h-2.5">
            {i % 4 === 0 && (
              <span className="absolute -top-0.5 right-1 text-[10px] leading-none whitespace-nowrap text-muted">
                {fmtTime(c.startMs, zone)}
              </span>
            )}
          </div>
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.date} className="flex flex-col gap-px">
          {row.cells.map((c) => (
            <div
              key={c.startMs}
              title={`${row.label} ${fmtTime(c.startMs, zone)}: ${c.count} free${c.dinner ? `, ${c.dinner} at dinner` : ""}`}
              className={`h-2.5 rounded-[2px] ${c.inWindow ? "ring-1 ring-bone/70" : ""}`}
              style={{ background: color(c.count), opacity: c.past ? 0.3 : 1 }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
