"use client";

import { useBrowserZone } from "@/components/client";
import { US_TIMEZONES } from "@/lib/zones";

export function DiscordLoginButton({ enabled }: { enabled: boolean }) {
  const zone = useBrowserZone();
  if (!enabled) {
    return (
      <button
        disabled
        className="btn btn-secondary w-full"
        title="Set DISCORD_APPLICATION_ID and DISCORD_CLIENT_SECRET (in .env.local, or in Vercel's environment variables). See Discord setup in the README."
      >
        Log in with Discord (not configured yet)
      </button>
    );
  }
  return (
    <a href={`/api/auth/discord${zone ? `?tz=${encodeURIComponent(zone)}` : ""}`} className="btn w-full bg-[#5865f2] text-white hover:bg-[#4752c4]">
      Log in with Discord
    </a>
  );
}

/** Time zone picker that defaults to this device's zone. */
export function ZonePicker({ name }: { name: string }) {
  const zone = useBrowserZone();
  const options: Array<{ value: string; label: string }> = [...US_TIMEZONES];
  if (zone && !options.some((o) => o.value === zone)) options.push({ value: zone, label: zone });
  return (
    <select name={name} key={zone ?? "none"} defaultValue={zone ?? "America/Chicago"} className="input">
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
