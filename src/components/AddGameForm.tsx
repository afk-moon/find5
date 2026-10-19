"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addGameAction } from "@/app/actions";
import type { ActionResult } from "@/lib/action-result";
import { MAX_PARTY, MIN_PARTY } from "@/lib/games";

/** Add a game to the group: a name and how many players it needs. Whoever adds it plays it. */
export function AddGameForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [size, setSize] = useState("5");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const r = await addGameAction(name, Number(size));
      setResult(r);
      if (r.ok) {
        setName("");
        setSize("5");
        router.refresh();
      }
    });
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-0 flex-1 space-y-1">
          <span className="text-sm font-semibold">Add a game</span>
          <input
            className="input w-full"
            placeholder="e.g. Overwatch 2"
            maxLength={40}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setResult(null);
            }}
          />
        </label>
        <label className="block w-20 space-y-1">
          <span className="text-sm font-semibold">Players</span>
          <input
            type="number"
            min={MIN_PARTY}
            max={MAX_PARTY}
            className="input w-full"
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
        </label>
        <button className="btn btn-primary" disabled={pending || !name.trim()}>
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
      {result && !result.ok && <p className="text-xs text-val">{result.error}</p>}
      {result?.ok && <p className="text-xs text-free">{result.message}. You&apos;re signed up for it.</p>}
    </form>
  );
}
