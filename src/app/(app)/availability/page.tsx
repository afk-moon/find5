import { DateTime } from "luxon";
import { EMPTY_PATTERN, currentGamingDay, isWfhDate, resolvePattern, vacationOn } from "@/engine";
import { fmtDate, zoneAbbr } from "@/lib/format";
import { partyLabel } from "@/lib/games";
import { requestTime, requireViewer, toEngineInput } from "@/server/context";
import { AvailabilityEditor, type DateEntry } from "./AvailabilityEditor";
import { MyGamesCard } from "./MyGamesCard";
import { ProfileForm } from "./ProfileForm";
import { VacationCard, type VacationItem } from "./VacationCard";

export default async function AvailabilityPage() {
  const { me, ctx } = await requireViewer();
  const input = toEngineInput(me);

  const week: Record<number, string> = {};
  for (let d = 1; d <= 7; d++) week[d] = me.patterns[`w${d}`] ?? EMPTY_PATTERN;
  // Each WFH weekday: its own saved pattern, else the older shared WFH pattern, else the typical day.
  const wfhWeek: Record<number, string> = {};
  for (let d = 1; d <= 5; d++) wfhWeek[d] = me.patterns[`wfh${d}`] ?? me.patterns.wfh ?? week[d];

  // Start at the gaming day that's on now: at 1am, last night is still "today" (it runs until 4am).
  const todayDate = currentGamingDay(requestTime(), me.timezone);
  const today = DateTime.fromISO(todayDate, { zone: me.timezone });
  const dates: DateEntry[] = Array.from({ length: 14 }, (_, i) => {
    const day = today.plus({ days: i });
    const date = day.toISODate()!;
    return {
      date,
      label: day.toFormat("ccc d"),
      cells: resolvePattern(input, date),
      isOverride: !!me.patterns[`d:${date}`],
      isWfh: me.workStyle === "hybrid" && isWfhDate(input, date),
      isVacation: !!vacationOn(input, date),
    };
  });

  // Current and upcoming time away, labelled here so the client component doesn't need Luxon.
  const vacations: VacationItem[] = me.vacations
    .filter((v) => v.end >= todayDate)
    .map((v) => ({
      id: v.id,
      label: v.start === v.end ? fmtDate(v.start) : `${fmtDate(v.start)} – ${fmtDate(v.end)}`,
      days: DateTime.fromISO(v.end).diff(DateTime.fromISO(v.start), "days").days + 1,
      current: v.start <= todayDate,
    }));

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
        <div className="space-y-6">
          <MyGamesCard
            games={[...ctx.games]
              .sort((a, b) => a.addedAt - b.addedAt)
              .map((g) => ({ id: g.id, name: g.name, party: partyLabel(g.partySize), players: g.players.length }))}
            mine={me.games}
          />
          <VacationCard vacations={vacations} today={todayDate} />
          <ProfileForm
            profile={{
              timezone: me.timezone,
              workStyle: me.workStyle,
              nightBeforeWfhUntil: me.nightBeforeWfhUntil,
              hybridDays: me.hybridDays,
              dmWhenFull: me.dmWhenFull,
              hasDiscord: !!me.discordId,
            }}
          />
        </div>
      </div>
    </div>
  );
}
