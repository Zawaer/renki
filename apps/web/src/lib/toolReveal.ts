import { useEffect, useRef } from "react";

/**
 * "Show in transcript" from the agent map: open a tool row (and the agent rows
 * it's nested in), scroll it into view, and flash it so the eye finds it.
 *
 * A nested agent's row only exists once its parent's row is open (Reveal
 * unmounts closed content), so the request is both broadcast — to rows
 * already on screen — and parked here for rows that mount because of it.
 */

const EVENT = "renki:reveal-tool";
/** How long a row stays highlighted. */
const FLASH_MS = 1500;

let pending: { ids: Set<string>; expiresAt: number } | null = null;

/**
 * `path` runs from the outermost agent down to the target. Every row on it
 * opens; the deepest one that made it into the DOM gets scrolled to.
 */
export function revealToolUse(path: string[]): void {
  if (path.length === 0) return;
  const ids = new Set(path);
  pending = { ids, expiresAt: Date.now() + 1000 };
  window.dispatchEvent(new CustomEvent<string[]>(EVENT, { detail: path }));
  // Two frames for the opened rows to mount, then a Reveal's opening
  // animation is short enough that centring now lands close enough.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      pending = null;
      const el = [...path]
        .reverse()
        .map((id) => document.querySelector<HTMLElement>(`[data-tool-use-id="${id.replace(/["\\]/g, "\\$&")}"]`))
        .find((e) => e != null);
      if (!el) return;
      // The row line itself, not its (possibly very tall) opened body.
      const row = el.querySelector<HTMLElement>(":scope > button") ?? el;
      row.scrollIntoView?.({ behavior: "smooth", block: "center" });
      row.classList.remove("renki-flash");
      void row.offsetWidth; // restart the animation on a repeat reveal
      row.classList.add("renki-flash");
      setTimeout(() => row.classList.remove("renki-flash"), FLASH_MS);
    }),
  );
}

/** Whether a row mounting right now was asked to open by a reveal in flight. */
export function revealPending(toolUseId: string): boolean {
  return !!pending && pending.expiresAt > Date.now() && pending.ids.has(toolUseId);
}

/** Calls `onReveal` when a reveal names this row. */
export function useToolReveal(toolUseId: string, onReveal: () => void): void {
  const callback = useRef(onReveal);
  callback.current = onReveal;
  useEffect(() => {
    const listener = (e: Event) => {
      if ((e as CustomEvent<string[]>).detail.includes(toolUseId)) callback.current();
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [toolUseId]);
}
