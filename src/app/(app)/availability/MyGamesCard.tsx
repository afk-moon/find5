"use client";

import { useOptimistic, useState, useTransition } from "react";
import { setMyGamesAction } from "@/app/actions";
import { AddGameForm } from "@/components/AddGameForm";
import type { ActionResult } from "@/lib/action-result";

export interface GameOption {
  id: string;
  name: string;
  /** "5-stack", "2+" (formatted on the server). */
  party: string;
  /** Members who play it, the viewer included if they do. */
  players: number;
}

/** Which games you play. Windows, lobbies and "free right now" pings for a game only include its players. */
export function MyGamesCard({ games, mine }: { games: GameOption[]; mine: string[] }) {
  const [picked, setPicked] = useOptimistic(mine, (_: string[], next: string[]) => next);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [, startTransition] = useTransition();

  const toggle = (id: string) =>
    startTransition(async () => {
      const next = picked.includes(id) ? picked.filter((g) => g !== id) : [...picked, id];
      setPicked(next);
      const r = await setMyGamesAction(next);
      // Ticking the box is feedback enough; only say something when it failed or nothing is picked.
      setResult(!r.ok || next.length === 0 ? r : null);
    });

  return (
    <div className="card h-fit space-y-3">
      <div className="label">🎮 My games</div>
      <p className="text-xs text-muted">
        Tick the games you play. You only show up in windows, lobbies and pings for these.
      </p>
      <ul className="space-y-1.5">
        {games.map((g) => {
          const on = picked.includes(g.id);
          // Count the change right away, before the server answers.
          const players = g.players + (on ? 1 : 0) - (mine.includes(g.id) ? 1 : 0);
          return (
            <li key={g.id}>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-val" checked={on} onChange={() => toggle(g.id)} />
                <span className="font-semibold">{g.name}</span>
                <span className="ml-auto text-xs text-muted">
                  {g.party} · {players} {players === 1 ? "plays" : "play"}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {result && !result.ok && <p className="text-xs text-val">{result.error}</p>}
      {result?.ok && result.message && <p className="text-xs text-maybe">{result.message}</p>}
      <div className="border-t border-line pt-3">
        <AddGameForm />
      </div>
    </div>
  );
}
