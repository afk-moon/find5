"use client";

import { useState, useTransition } from "react";
import { addPlayerAction } from "@/app/actions";
import type { ActionResult } from "@/lib/action-result";

/** ➕ Someone else played: add a member who played a locked-in session without being in its party. */
export function AddPlayer({ sessionId, people }: { sessionId: string; people: Array<{ id: string; name: string }> }) {
  const [target, setTarget] = useState(people[0]?.id ?? "");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const who = people.some((p) => p.id === target) ? target : (people[0]?.id ?? "");

  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t border-line pt-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => setResult(await addPlayerAction(sessionId, who)));
      }}
    >
      <span className="text-xs text-muted">➕ Someone else played:</span>
      <select className="input py-1 text-xs" value={who} onChange={(e) => setTarget(e.target.value)}>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button className="btn btn-secondary px-2.5 py-1 text-xs" disabled={pending || !who}>
        {pending ? "Adding…" : "Add"}
      </button>
      {result && !result.ok && <span className="text-xs text-val">{result.error}</span>}
      {result?.ok && result.message && <span className="text-xs text-free">{result.message}</span>}
    </form>
  );
}
