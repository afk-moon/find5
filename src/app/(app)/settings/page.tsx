import { saveSettingsAction } from "@/app/actions";
import { Avatar } from "@/components/Avatar";
import { appUrl, botConfigured } from "@/discord/rest";
import { WEEKDAY_LONG, zoneAbbr } from "@/lib/format";
import { US_TIMEZONES } from "@/lib/zones";
import { discordLoginConfigured } from "@/server/auth";
import { requireViewer } from "@/server/context";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const { ctx } = await requireViewer();
  const { saved } = await searchParams;
  const g = ctx.group;
  const url = appUrl();

  const select = (name: string, value: number, options: Array<[number, string]>) => (
    <select name={name} defaultValue={value} className="input w-full">
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
  const weekdays: Array<[number, string]> = [1, 2, 3, 4, 5, 6, 7].map((d) => [d, WEEKDAY_LONG[d]]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <form action={saveSettingsAction} className="card space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="h1">Group settings</h1>
          {saved && <span className="chip text-free">Saved ✓</span>}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Group name">
            <input name="name" defaultValue={g.name} className="input w-full" />
          </Field>
          <Field label="Home time zone" hint="Used for week boundaries and the WFH vote schedule">
            <select name="homeTimezone" defaultValue={g.homeTimezone} className="input w-full">
              {US_TIMEZONES.map((z) => (
                <option key={z.value} value={z.value}>
                  {z.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="label">Matching</div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Party size" hint="5 for a full stack; members beyond this become subs">
            <input name="partySize" type="number" min={2} max={10} defaultValue={g.partySize} className="input w-full" />
          </Field>
          <Field label="Minimum play time" hint="Pauses don't count">
            {select("minSessionMinutes", g.minSessionMinutes, [
              [60, "1 hour"],
              [90, "1.5 hours"],
              [120, "2 hours"],
              [150, "2.5 hours"],
              [180, "3 hours"],
            ])}
          </Field>
          <Field label="Quick dinner = the party waits up to" hint="Longer dinners split the session">
            {select("maxPauseMinutes", g.maxPauseMinutes, [
              [0, "Never wait"],
              [30, "30 min"],
              [60, "1 hour"],
              [90, "1.5 hours"],
            ])}
          </Field>
          <Field label="Comp match length (min)" hint="For “last comp queue” heads-ups">
            <input name="matchLengthMinutes" type="number" min={15} max={90} defaultValue={g.matchLengthMinutes} className="input w-full" />
          </Field>
        </div>

        <div className="label">WFH sync</div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Shared WFH days / week">
            {select("wfhSharedDays", g.wfhSharedDays, [
              [1, "1 day"],
              [2, "2 days"],
              [3, "3 days"],
            ])}
          </Field>
          <Field label="Vote opens (for next week)">{select("wfhVoteOpenWeekday", g.wfhVoteOpenWeekday, weekdays)}</Field>
          <Field label="Vote closes">{select("wfhVoteCloseWeekday", g.wfhVoteCloseWeekday, weekdays)}</Field>
        </div>

        <div className="label">Discord</div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Server ID" hint="Auto-filled the first time someone uses the bot">
            <input name="discordGuildId" defaultValue={g.discordGuildId ?? ""} className="input w-full" placeholder="e.g. 1234567890" />
          </Field>
          <Field label="Announcement channel ID">
            <input name="discordChannelId" defaultValue={g.discordChannelId ?? ""} className="input w-full" />
          </Field>
          <Field label="Voice channel ID" hint="Optional: scheduled events point here">
            <input name="discordVoiceChannelId" defaultValue={g.discordVoiceChannelId ?? ""} className="input w-full" />
          </Field>
        </div>

        <button className="btn btn-primary">Save settings</button>
      </form>

      <aside className="space-y-4">
        <div className="card space-y-2">
          <div className="label">Members ({ctx.members.length})</div>
          {ctx.members.map((m) => (
            <div key={m.id} className="flex items-center gap-2 text-sm">
              <Avatar name={m.name} color={m.color} image={m.image} size={22} />
              <span className="font-semibold">{m.name}</span>
              <span className="chip">{zoneAbbr(m.timezone)}</span>
              {m.workStyle === "hybrid" && <span className="chip">🏠 hybrid</span>}
              <span className="ml-auto text-xs text-muted">{m.discordId ? "Discord ✓" : "no Discord"}</span>
            </div>
          ))}
        </div>
        <div className="card space-y-2 text-sm">
          <div className="label">Integrations</div>
          <Status ok={discordLoginConfigured()} label="Log in with Discord" fix="DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET" />
          <Status ok={botConfigured()} label="Discord bot" fix="DISCORD_BOT_TOKEN + DISCORD_PUBLIC_KEY" />
          <Status ok={!!g.discordChannelId} label="Announcement channel" fix="set a channel ID, or run /lfg in Discord" />
          <div className="pt-2 text-xs text-muted">
            Interactions endpoint URL for the Discord developer portal:
            <code className="mt-1 block break-all rounded bg-ink-2 px-2 py-1 text-bone">{url}/api/discord/interactions</code>
            Setup steps are in the README.
          </div>
        </div>
      </aside>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

function Status({ ok, label, fix }: { ok: boolean; label: string; fix: string }) {
  return (
    <div className="flex items-start gap-2">
      <span>{ok ? "✅" : "⚪️"}</span>
      <span>
        {label}
        {!ok && <span className="block text-xs text-muted">Needs {fix}</span>}
      </span>
    </div>
  );
}
