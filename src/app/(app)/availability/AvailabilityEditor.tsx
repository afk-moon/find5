"use client";

import { useRouter } from "next/navigation";
import { Fragment, useRef, useState, useTransition } from "react";
import { saveOverrideAction, saveWeekAction, saveWfhWeekAction, toggleWfhDateAction } from "@/app/actions";
import { CELLS_PER_DAY, cellLabel, setCell } from "@/engine/cells";
import type { HybridMode } from "@/engine/types";
import type { ActionResult } from "@/lib/action-result";

type State = "." | "F" | "M" | "Q" | "L";

const BRUSHES: Array<{ state: State; label: string; swatch: string }> = [
  { state: "F", label: "Free", swatch: "bg-free" },
  { state: "M", label: "If needed", swatch: "bg-maybe" },
  { state: "Q", label: "🍔 Quick dinner", swatch: "bg-quick" },
  { state: "L", label: "🍝 Long dinner", swatch: "bg-long" },
  { state: ".", label: "Busy", swatch: "bg-ink-2 ring-1 ring-line" },
];
const CELL_BG: Record<State, string> = { ".": "bg-ink-2", F: "bg-free", M: "bg-maybe", Q: "bg-quick", L: "bg-long" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MODE_LABEL: Record<HybridMode, string> = { office: "office", flex: "flexible", wfh: "always WFH" };

function withoutKey(obj: Record<string, string>, key: string): Record<string, string> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

export interface DateEntry {
  date: string;
  label: string;
  cells: string;
  isOverride: boolean;
  isWfh: boolean;
}

interface Column {
  key: string;
  label: string;
  /** Small second line under the label. */
  sub?: string;
  cells: string;
}

/** Click or drag to paint. Starting a stroke on a cell that already has the brush's state erases instead. */
function PaintGrid({ columns, brush, onPaint }: { columns: Column[]; brush: State; onPaint: (key: string, idx: number, s: State) => void }) {
  const stroke = useRef<State | null>(null);
  const hitTest = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cell]");
    return el ? { key: el.dataset.col!, idx: Number(el.dataset.idx) } : null;
  };
  return (
    <div
      className="touch-none select-none"
      onPointerDown={(e) => {
        const hit = hitTest(e.clientX, e.clientY);
        if (!hit) return;
        const current = columns.find((c) => c.key === hit.key)?.cells[hit.idx];
        stroke.current = current === brush ? "." : brush;
        e.currentTarget.setPointerCapture(e.pointerId);
        onPaint(hit.key, hit.idx, stroke.current);
      }}
      onPointerMove={(e) => {
        if (!stroke.current) return;
        const hit = hitTest(e.clientX, e.clientY);
        if (hit) onPaint(hit.key, hit.idx, stroke.current);
      }}
      onPointerUp={() => (stroke.current = null)}
      onPointerCancel={() => (stroke.current = null)}
    >
      <div className="grid" style={{ gridTemplateColumns: `48px repeat(${columns.length}, minmax(0, 1fr))` }}>
        <div />
        {columns.map((c) => (
          <div key={c.key} className="pb-1 text-center text-xs font-semibold text-bone">
            {c.label}
            {c.sub && <div className="text-[10px] font-normal text-muted">{c.sub}</div>}
          </div>
        ))}
        {Array.from({ length: CELLS_PER_DAY }, (_, idx) => (
          <Fragment key={idx}>
            <div className="pr-1.5 text-right text-[10px] leading-[14px] text-muted">{idx % 2 === 0 ? cellLabel(idx) : ""}</div>
            {columns.map((c) => (
              <div
                key={c.key}
                data-cell=""
                data-col={c.key}
                data-idx={idx}
                className={`h-[14px] cursor-crosshair border-l-2 border-ink ${idx % 2 === 0 ? "border-t border-t-line/70" : ""} ${CELL_BG[(c.cells[idx] as State) ?? "."]}`}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function AvailabilityEditor({
  week: initialWeek,
  wfhWeek: initialWfhWeek,
  hybridDays,
  hybrid,
  dates,
  zoneLabel,
}: {
  week: Record<number, string>;
  /** WFH-day pattern for each weekday, Mon (1) to Fri (5). */
  wfhWeek: Record<number, string>;
  hybridDays: Partial<Record<number, HybridMode>>;
  hybrid: boolean;
  dates: DateEntry[];
  zoneLabel: string;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"week" | "wfh" | "dates">("week");
  const [brush, setBrush] = useState<State>("F");
  const [week, setWeek] = useState(initialWeek);
  const [savedWeek, setSavedWeek] = useState(initialWeek);
  const [wfhWeek, setWfhWeek] = useState(initialWfhWeek);
  const [savedWfhWeek, setSavedWfhWeek] = useState(initialWfhWeek);
  const [selected, setSelected] = useState(dates[0]?.date);
  const [dateEdits, setDateEdits] = useState<Record<string, string>>({});
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

  const entry = dates.find((d) => d.date === selected);
  const dateCells = selected ? (dateEdits[selected] ?? entry?.cells ?? "") : "";
  const weekDirty = JSON.stringify(week) !== JSON.stringify(savedWeek);
  const wfhDirty = JSON.stringify(wfhWeek) !== JSON.stringify(savedWfhWeek);

  const paint = (key: string, idx: number, s: State) => {
    if (tab === "week") {
      setWeek((w) => (w[Number(key)][idx] === s ? w : { ...w, [key]: setCell(w[Number(key)], idx, s) }));
    } else if (tab === "wfh") {
      setWfhWeek((w) => (w[Number(key)][idx] === s ? w : { ...w, [key]: setCell(w[Number(key)], idx, s) }));
    } else if (selected) {
      setDateEdits((d) => {
        const current = d[selected] ?? entry?.cells ?? "";
        return current[idx] === s ? d : { ...d, [selected]: setCell(current, idx, s) };
      });
    }
    setResult(null);
  };

  const tabs = [
    { id: "week" as const, label: "Typical week" },
    ...(hybrid ? [{ id: "wfh" as const, label: "🏠 WFH days" }] : []),
    { id: "dates" as const, label: "Specific days" },
  ];

  return (
    <div className="card space-y-4">
      <div className="flex flex-wrap items-center gap-1 border-b border-line pb-3">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`btn ${tab === t.id ? "bg-panel-2 text-bone" : "btn-ghost"}`}
          >
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted">Times in {zoneLabel}</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {BRUSHES.map((b) => (
          <button
            key={b.state}
            onClick={() => setBrush(b.state)}
            className={`btn px-2.5 py-1 text-xs ${brush === b.state ? "bg-panel-2 text-bone ring-1 ring-bone/60" : "btn-ghost"}`}
          >
            <span className={`h-3 w-3 rounded-sm ${b.swatch}`} /> {b.label}
          </button>
        ))}
      </div>

      {tab === "week" && (
        <>
          <PaintGrid
            brush={brush}
            onPaint={paint}
            columns={WEEKDAYS.map((label, i) => ({ key: String(i + 1), label, cells: week[i + 1] }))}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-ghost text-xs" onClick={() => setWeek((w) => ({ ...w, 2: w[1], 3: w[1], 4: w[1], 5: w[1] }))}>
              Copy Mon → Tue–Fri
            </button>
            <button className="btn btn-ghost text-xs" onClick={() => setWeek((w) => ({ ...w, 7: w[6] }))}>
              Copy Sat → Sun
            </button>
            <SaveBar
              dirty={weekDirty}
              pending={pending}
              result={result}
              onSave={() => run(() => saveWeekAction(Object.fromEntries(Object.entries(week))), () => setSavedWeek(week))}
            />
          </div>
        </>
      )}

      {tab === "wfh" && (
        <>
          <p className="text-sm text-muted">
            What each weekday looks like when you work from home (no commute, so you can usually start earlier).
            On a WFH day this replaces your typical day. Pick which days are WFH in your profile, or vote on the WFH
            sync page.
          </p>
          <PaintGrid
            brush={brush}
            onPaint={paint}
            columns={WEEKDAYS.slice(0, 5).map((label, i) => ({
              key: String(i + 1),
              label,
              sub: MODE_LABEL[hybridDays[i + 1] ?? "office"],
              cells: wfhWeek[i + 1],
            }))}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-ghost text-xs" onClick={() => setWfhWeek((w) => ({ ...w, 2: w[1], 3: w[1], 4: w[1], 5: w[1] }))}>
              Copy Mon → Tue–Fri
            </button>
            <button
              className="btn btn-ghost text-xs"
              onClick={() => setWfhWeek({ 1: week[1], 2: week[2], 3: week[3], 4: week[4], 5: week[5] })}
            >
              Start from my typical week
            </button>
            <SaveBar
              dirty={wfhDirty}
              pending={pending}
              result={result}
              onSave={() => run(() => saveWfhWeekAction(Object.fromEntries(Object.entries(wfhWeek))), () => setSavedWfhWeek(wfhWeek))}
            />
          </div>
        </>
      )}

      {tab === "dates" && (
        <>
          <p className="text-sm text-muted">Change a single day (busy one night, free all Saturday) without touching your typical week.</p>
          <div className="flex flex-wrap gap-1.5">
            {dates.map((d) => (
              <button
                key={d.date}
                onClick={() => setSelected(d.date)}
                className={`btn px-2 py-1 text-xs ${selected === d.date ? "bg-panel-2 text-bone ring-1 ring-bone/60" : "btn-ghost"}`}
              >
                {d.label}
                {d.isOverride && <span className="text-val">•</span>}
                {d.isWfh && <span>🏠</span>}
              </button>
            ))}
          </div>
          {entry && (
            <>
              <div className="max-w-xs">
                <PaintGrid brush={brush} onPaint={paint} columns={[{ key: entry.date, label: entry.label, cells: dateCells }]} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {entry.isOverride && (
                  <button
                    className="btn btn-ghost text-xs"
                    disabled={pending}
                    onClick={() =>
                      run(() => saveOverrideAction(entry.date, null), () => setDateEdits((d) => withoutKey(d, entry.date)))
                    }
                  >
                    Reset to normal
                  </button>
                )}
                {hybrid && (
                  <button
                    className={`btn text-xs ${entry.isWfh ? "btn-on" : "btn-secondary"}`}
                    disabled={pending}
                    onClick={() => run(() => toggleWfhDateAction(entry.date, !entry.isWfh))}
                  >
                    🏠 {entry.isWfh ? "WFH this day ✓" : "WFH this day?"}
                  </button>
                )}
                <SaveBar
                  dirty={dateEdits[entry.date] !== undefined && dateEdits[entry.date] !== entry.cells}
                  pending={pending}
                  result={result}
                  label="Save this day"
                  onSave={() =>
                    run(() => saveOverrideAction(entry.date, dateCells), () => setDateEdits((d) => withoutKey(d, entry.date)))
                  }
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function SaveBar({
  dirty,
  pending,
  result,
  onSave,
  label = "Save",
}: {
  dirty: boolean;
  pending: boolean;
  result: ActionResult | null;
  onSave: () => void;
  label?: string;
}) {
  return (
    <div className="ml-auto flex items-center gap-3">
      {result && !result.ok && <span className="text-xs text-val">{result.error}</span>}
      {result?.ok && !dirty && <span className="text-xs text-free">{result.message ?? "Saved"}</span>}
      {dirty && <span className="text-xs text-maybe">Unsaved changes</span>}
      <button className="btn btn-primary" disabled={!dirty || pending} onClick={onSave}>
        {pending ? "Saving…" : label}
      </button>
    </div>
  );
}
