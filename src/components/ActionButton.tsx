"use client";

import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";

/** Button that runs a (bound) server action and shows pending state plus any error inline. */
export function ActionButton({
  action,
  children,
  className = "btn btn-secondary",
  pendingLabel,
  confirm,
  title,
}: {
  action: () => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  pendingLabel?: string;
  confirm?: string;
  title?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        title={title}
        disabled={pending}
        className={className}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          startTransition(async () => setResult(await action()));
        }}
      >
        {pending ? (pendingLabel ?? "…") : children}
      </button>
      {result && !result.ok && <span className="text-xs text-val">{result.error}</span>}
      {result && result.ok && result.message && <span className="text-xs text-free">{result.message}</span>}
    </span>
  );
}
