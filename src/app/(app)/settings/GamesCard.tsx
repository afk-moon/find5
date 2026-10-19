"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { removeGameAction, updateGameAction } from "@/app/actions";
import { AddGameForm } from "@/components/AddGameForm";
import type { ActionResult } from "@/lib/action-result";
import { MAX_PARTY, MIN_PARTY } from "@/lib/games";

export interface GameRow {
  id: string;
  name: string;
  partySize: number;
  matchMinutes: number;
  /** Members who play it. */
  players: number;
}

/** The group's games: rename them, change how many players they need or how long a match takes, add or remove. */
export function GamesCard({ games }: { games: GameRow[] }) {
  return (
    <div className="card space-y-4">
      <div className="space-y-1">
        <div className="label">Games</div>
        <p className="text-xs text-muted">
          Each game has its own party size, and members pick the games they play on My availability. Match length
          is for “last queue before dinner” heads-ups.
        </p>
      </div>
      <div className="space-y-4">
        {games.map((g) => (
          // Keyed by the saved values, so a save (or someone else's edit) resets the row.
          <GameEditor key={`${g.id}:${g.name}:${g.partySize}:${g.matchMinutes}`} game={g} canRemove={games.length > 1} />
        ))}
      </div>
      <div className="border-t border-line pt-3">
        <AddGameForm />
      </div>
    </div>
  );
}

function GameEditor({ game, canRemove }: { game: GameRow; canRemove: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(game.name);
  const [size, setSize] = useState(String(game.partySize));
  const [minutes, setMinutes] = useState(String(game.matchMinutes));
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = name.trim() !== game.name || Number(size) !== game.partySize || Number(minutes) !== game.matchMinutes;

  const run = (action: () => Promise<ActionResult>) =>
    startTransition(async () => {
      const r = await action();
      setResult(r);
      if (r.ok) router.refresh();
    });

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] gap-2">
        <label className="block space-y-1">
          <span className="text-xs font-semibold">Name</span>
          <input className="input w-full" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold">Players</span>
          <input
            type="number"
            min={MIN_PARTY}
            max={MAX_PARTY}
            className="input w-full"
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold">Match (min)</span>
          <input
            type="number"
            min={10}
            max={180}
            className="input w-full"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>
          {game.players} {game.players === 1 ? "member plays" : "members play"} it
        </span>
        {result && !result.ok && <span className="text-val">{result.error}</span>}
        <button
          className="btn btn-primary ml-auto px-2.5 py-1 text-xs"
          disabled={pending || !dirty || !name.trim()}
          onClick={() => run(() => updateGameAction(game.id, { name, partySize: Number(size), matchMinutes: Number(minutes) }))}
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {canRemove && (
          <button
            className="btn btn-ghost px-2.5 py-1 text-xs"
            disabled={pending}
            onClick={() => {
              if (window.confirm(`Remove ${game.name}? Everyone's pick of it goes too. Past sessions stay.`)) {
                run(() => removeGameAction(game.id));
              }
            }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
