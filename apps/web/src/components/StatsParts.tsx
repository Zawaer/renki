import { tickIndices } from "@renki/client-core";
import { useState } from "react";
import { Button } from "./ui.js";

/** The Stats page's building blocks, shared by its sections (StatsView, Insights). */

export function Section({
  title,
  children,
  table,
}: {
  title: string;
  children: React.ReactNode;
  table?: React.ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-(--renki-fg-muted)">
          {title}
        </h2>
        {table && (
          <Button
            variant="ghost"
            className="px-2! py-0.5! text-[11px]"
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? "Hide table" : "View as table"}
          </Button>
        )}
      </div>
      {showTable && table ? table : children}
    </section>
  );
}

export function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-(--renki-surface) p-4">
      <div className="mb-2 text-[11px] font-medium text-(--renki-fg-muted)">
        {title}
      </div>
      {children}
    </div>
  );
}

export function Legend({
  items,
}: {
  items: { label: string; color: string }[];
}) {
  return (
    <div className="mb-2 flex gap-3 text-[11px] text-(--renki-fg-muted)">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-(--renki-surface) p-4 shadow-(--renki-shadow-xs)">
      <div className="text-[11px] font-medium text-(--renki-fg-muted)">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-(--renki-fg)">
        {value}
      </div>
    </div>
  );
}

export type BarItem = {
  key: string;
  label: string;
  a: number;
  b?: number;
  tooltip: string;
};

/**
 * Hand-rolled bar chart (no chart library in this app). Bars ≤24px thick,
 * 4px rounded top / square baseline, a 2px surface gap between stacked
 * segments, growing from a shared baseline. A generous hover target (the
 * whole column, not just the bar) shows an exact-value tooltip — the
 * relief channel for viewers who can't rely on hue alone, alongside the
 * "view as table" toggle each section offers.
 */
export function Bars({
  items,
  colorA,
  colorB,
}: {
  items: BarItem[];
  colorA: string;
  colorB?: string;
}) {
  const CHART_H = 96;
  const max = Math.max(1, ...items.map((i) => i.a + (i.b ?? 0)));
  const ticks = tickIndices(items.length, 6);

  return (
    <div>
      <div className="flex items-end gap-1" style={{ height: CHART_H }}>
        {items.map((it) => {
          const total = it.a + (it.b ?? 0);
          const hA = (it.a / max) * CHART_H;
          const hB = ((it.b ?? 0) / max) * CHART_H;
          return (
            <div
              key={it.key}
              className="group relative flex h-full max-w-6 flex-1 flex-col justify-end"
            >
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-pre rounded-xl bg-(--renki-surface) px-2 py-1 text-[10px] text-(--renki-fg) shadow-lg group-hover:block">
                {it.tooltip}
              </div>
              <div
                className="flex w-full flex-col justify-end gap-0.5"
                style={{ height: CHART_H }}
              >
                {colorB !== undefined && (it.b ?? 0) > 0 && (
                  <div
                    className="w-full rounded-t-sm"
                    style={{ height: Math.max(hB, 2), background: colorB }}
                  />
                )}
                {total > 0 ? (
                  <div
                    className={`w-full ${colorB === undefined || !(it.b ?? 0) ? "rounded-t-sm" : ""}`}
                    style={{ height: Math.max(hA, 2), background: colorA }}
                  />
                ) : (
                  <div className="h-px w-full bg-(--renki-border)" />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex border-t border-(--renki-border) pt-1">
        {items.map((it, i) => (
          <div
            key={it.key}
            className="flex-1 text-center text-[9px] text-(--renki-fg-muted)"
          >
            {ticks.has(i) ? it.label : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
