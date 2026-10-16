"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addVacationAction, removeVacationAction } from "@/app/actions";
import type { ActionResult } from "@/lib/action-result";

export interface VacationItem {
  id: string;
  /** "Oct 20 – Oct 27" (formatted on the server). */
  label: string;
  days: number;
  /** It's on today. */
  current: boolean;
}

/** Time away: pick the first and last day, and you show as busy on every day in between. */
export function VacationCard({ vacations, today }: { vacations: VacationItem[]; today: string }) {
  const router = useRouter();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<ActionResult>, after?: () => void) =>
    startTransition(async () => {
      const r = await action();
      setResult(r);
      if (r.ok) {
        after?.();
        router.refresh();
      }
    });

  return (
    <div className="card h-fit space-y-3">
      <div className="label">🏖️ Vacation</div>
      <p className="text-xs text-muted">
        Going away? Pick your first and last day. You&apos;ll show as busy on every day in between, whatever your usual
        week says.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-sm font-semibold">From</span>
          <input
            type="date"
            className="input w-full"
            min={today}
            value={start}
            onChange={(e) => {
              const v = e.target.value;
              setStart(v);
              if (!end || end < v) setEnd(v);
              setResult(null);
            }}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-semibold">To</span>
          <input
            type="date"
            className="input w-full"
            min={start || today}
            value={end}
            onChange={(e) => {
              setEnd(e.target.value);
              setResult(null);
            }}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn btn-primary"
          disabled={pending || !start || !end}
          onClick={() =>
            run(
              () => addVacationAction(start, end),
              () => {
                setStart("");
                setEnd("");
              },
            )
          }
        >
          {pending ? "Saving…" : "Add vacation"}
        </button>
        {result && !result.ok && <span className="text-xs text-val">{result.error}</span>}
        {result?.ok && <span className="text-xs text-free">{result.message}</span>}
      </div>
      {vacations.length > 0 && (
        <ul className="space-y-1.5 border-t border-line pt-3">
          {vacations.map((v) => (
            <li key={v.id} className="flex items-center gap-2 text-sm">
              <span>🏖️ {v.label}</span>
              <span className="text-xs text-muted">
                {v.days} {v.days === 1 ? "day" : "days"}
                {v.current ? " · now" : ""}
              </span>
              <button
                className="btn btn-ghost ml-auto px-2 py-1 text-xs"
                disabled={pending}
                onClick={() => run(() => removeVacationAction(v.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
