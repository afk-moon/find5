"use client";

import { useState, useTransition } from "react";
import { sendFeedbackAction } from "@/app/actions";
import type { ActionResult } from "@/lib/action-result";

/** Free-text feedback about someone in the lobby. Anonymous; /summary in Discord sums it up with AI. */
export function FeedbackForm({
  sessionId,
  people,
  maxLength,
}: {
  sessionId: string;
  people: Array<{ id: string; name: string }>;
  maxLength: number;
}) {
  const [target, setTarget] = useState(people[0]?.id ?? "");
  const [text, setText] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const about = people.some((p) => p.id === target) ? target : (people[0]?.id ?? "");

  return (
    <form
      className="space-y-2 border-t border-line pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const r = await sendFeedbackAction(sessionId, about, text);
          setResult(r);
          if (r.ok) setText("");
        });
      }}
    >
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">💬 Feedback about</span>
        <select className="input" value={about} onChange={(e) => setTarget(e.target.value)}>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="input min-h-20 w-full"
        maxLength={maxLength}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Great comms, clutched the last round, a bit tilted after losses…"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={pending || !text.trim()}>
          {pending ? "Sending…" : "Send"}
        </button>
        <span className="text-xs text-muted">Anonymous. /summary in Discord sums it up.</span>
        {result && !result.ok && <span className="text-xs text-val">{result.error}</span>}
        {result?.ok && result.message && <span className="text-xs text-free">{result.message}</span>}
      </div>
    </form>
  );
}
