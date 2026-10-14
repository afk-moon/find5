"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveProfileAction } from "@/app/actions";
import { useBrowserZone } from "@/components/client";
import type { HybridMode } from "@/engine/types";
import type { ActionResult } from "@/lib/action-result";
import { US_TIMEZONES } from "@/lib/zones";

type Weekday5 = 1 | 2 | 3 | 4 | 5;
const DAYS: Array<[Weekday5, string]> = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
];
const NIGHT_OPTIONS = [
  ["", "Same as usual"],
  ["23:00", "11pm"],
  ["23:30", "11:30pm"],
  ["00:00", "12am"],
  ["00:30", "12:30am"],
  ["01:00", "1am"],
  ["01:30", "1:30am"],
  ["02:00", "2am"],
  ["03:00", "3am"],
];

export interface ProfileValues {
  timezone: string;
  workStyle: "fixed" | "hybrid";
  nightBeforeWfhUntil: string | null;
  hybridDays: Partial<Record<Weekday5, HybridMode>>;
}

export function ProfileForm({ profile }: { profile: ProfileValues }) {
  const router = useRouter();
  const browserZone = useBrowserZone();
  const [timezone, setTimezone] = useState(profile.timezone);
  const [workStyle, setWorkStyle] = useState(profile.workStyle);
  const [night, setNight] = useState(profile.nightBeforeWfhUntil ?? "");
  const [days, setDays] = useState<Partial<Record<Weekday5, HybridMode>>>(profile.hybridDays);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const zones: Array<{ value: string; label: string }> = [...US_TIMEZONES];
  for (const z of [profile.timezone, browserZone]) {
    if (z && !zones.some((o) => o.value === z)) zones.push({ value: z, label: z });
  }

  const save = () =>
    startTransition(async () => {
      const r = await saveProfileAction({
        timezone,
        workStyle,
        nightBeforeWfhUntil: night || null,
        hybridDays: workStyle === "hybrid" ? days : {},
      });
      setResult(r);
      if (r.ok) router.refresh();
    });

  return (
    <div className="card h-fit space-y-4">
      <div className="label">Profile</div>

      <label className="block space-y-1">
        <span className="text-sm font-semibold">Time zone</span>
        <select className="input w-full" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {zones.map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))}
        </select>
        {browserZone && browserZone !== timezone && (
          <button className="text-xs text-val underline" onClick={() => setTimezone(browserZone)}>
            Use this device&apos;s zone ({browserZone})
          </button>
        )}
      </label>

      <div className="space-y-1">
        <span className="text-sm font-semibold">Work schedule</span>
        <div className="flex gap-1.5">
          {(["fixed", "hybrid"] as const).map((s) => (
            <button
              key={s}
              onClick={() => {
                setWorkStyle(s);
                if (s === "hybrid" && !Object.keys(days).length) setDays({ 1: "flex", 2: "flex", 3: "flex", 4: "flex", 5: "flex" });
              }}
              className={`btn flex-1 text-xs ${workStyle === s ? "bg-panel-2 text-bone ring-1 ring-bone/60" : "btn-ghost"}`}
            >
              {s === "fixed" ? "Same every week" : "🏠 Hybrid"}
            </button>
          ))}
        </div>
      </div>

      {workStyle === "hybrid" && (
        <>
          <div className="space-y-1.5">
            <span className="text-sm font-semibold">Weekdays</span>
            {DAYS.map(([d, label]) => (
              <div key={d} className="flex items-center gap-2 text-sm">
                <span className="w-9 text-muted">{label}</span>
                {(["office", "flex", "wfh"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setDays((cur) => ({ ...cur, [d]: mode }))}
                    className={`btn flex-1 px-1.5 py-1 text-xs ${(days[d] ?? "office") === mode ? "bg-panel-2 text-bone ring-1 ring-bone/60" : "btn-ghost"}`}
                  >
                    {mode === "office" ? "Office" : mode === "flex" ? "Flexible" : "Always WFH"}
                  </button>
                ))}
              </div>
            ))}
            <p className="text-xs text-muted">Flexible days are the ones you vote on in WFH sync.</p>
          </div>
          <label className="block space-y-1">
            <span className="text-sm font-semibold">The night before a WFH day, I can stay up until</span>
            <select className="input w-full" value={night} onChange={(e) => setNight(e.target.value)}>
              {NIGHT_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      <div className="flex items-center gap-3">
        <button className="btn btn-primary" disabled={pending} onClick={save}>
          {pending ? "Saving…" : "Save profile"}
        </button>
        {result && !result.ok && <span className="text-xs text-val">{result.error}</span>}
        {result?.ok && <span className="text-xs text-free">{result.message}</span>}
      </div>
    </div>
  );
}
