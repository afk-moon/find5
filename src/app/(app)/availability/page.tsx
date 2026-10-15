import { DateTime } from "luxon";
import { EMPTY_PATTERN, isWfhDate, resolvePattern } from "@/engine";
import { zoneAbbr } from "@/lib/format";
import { requireViewer, toEngineInput } from "@/server/context";
import { AvailabilityEditor, type DateEntry } from "./AvailabilityEditor";
import { ProfileForm } from "./ProfileForm";

export default async function AvailabilityPage() {
  const { me } = await requireViewer();
  const input = toEngineInput(me);

  const week: Record<number, string> = {};
  for (let d = 1; d <= 7; d++) week[d] = me.patterns[`w${d}`] ?? EMPTY_PATTERN;
  // Each WFH weekday: its own saved pattern, else the older shared WFH pattern, else the typical day.
  const wfhWeek: Record<number, string> = {};
  for (let d = 1; d <= 5; d++) wfhWeek[d] = me.patterns[`wfh${d}`] ?? me.patterns.wfh ?? week[d];

  const today = DateTime.now().setZone(me.timezone).startOf("day");
  const dates: DateEntry[] = Array.from({ length: 14 }, (_, i) => {
    const day = today.plus({ days: i });
    const date = day.toISODate()!;
    return {
      date,
      label: day.toFormat("ccc d"),
      cells: resolvePattern(input, date),
      isOverride: !!me.patterns[`d:${date}`],
      isWfh: me.workStyle === "hybrid" && isWfhDate(input, date),
    };
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="h1">My availability</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Paint when you can play, in your own time ({zoneAbbr(me.timezone)}). Everyone else sees it in their zone,
          and daylight saving is handled for you. Mark dinners so the app knows whether the party should wait
          (🍔 quick) or split the session (🍝 long).
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <AvailabilityEditor
          week={week}
          wfhWeek={wfhWeek}
          hybridDays={me.hybridDays}
          hybrid={me.workStyle === "hybrid"}
          dates={dates}
          zoneLabel={`${zoneAbbr(me.timezone)} (${me.timezone})`}
        />
        <ProfileForm
          profile={{
            timezone: me.timezone,
            workStyle: me.workStyle,
            nightBeforeWfhUntil: me.nightBeforeWfhUntil,
            hybridDays: me.hybridDays,
          }}
        />
      </div>
    </div>
  );
}
