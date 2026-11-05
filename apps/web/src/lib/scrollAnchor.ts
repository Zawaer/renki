/**
 * Keeps what you're reading in place while content above it changes (history
 * landing, a running agent's card growing as it works). The transcript turns
 * the browser's own scroll anchoring off, since Safari has none and the two
 * together would double it, so this does the same by hand.
 *
 * The anchor is the first element marked [data-anchor] that starts in view:
 * a message, a turn or a text block. Cards and tool groups carry no anchor,
 * so it lands on text rather than on the thing that's changing.
 */
export type ScrollAnchor = { el: HTMLElement; top: number } | null;

/** The first [data-anchor] element in `content` that starts inside `root`'s view, and where. */
export function pickAnchor(root: HTMLElement, content: HTMLElement): ScrollAnchor {
  const rootTop = root.getBoundingClientRect().top;
  const els = content.querySelectorAll<HTMLElement>("[data-anchor]");
  // Document order is top-to-bottom order here, so find the first one starting in view.
  let lo = 0;
  let hi = els.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (els[mid]!.getBoundingClientRect().top - rootTop >= 0) hi = mid;
    else lo = mid + 1;
  }
  const el = els[lo];
  return el ? { el, top: el.getBoundingClientRect().top - rootTop } : null;
}

/** Scroll `root` so the anchor sits where it was. Returns how far it scrolled. */
export function restoreAnchor(root: HTMLElement, anchor: ScrollAnchor): number {
  if (!anchor || !anchor.el.isConnected) return 0;
  const moved = anchor.el.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.top;
  if (Math.abs(moved) < 1) return 0;
  root.scrollTop += moved;
  return moved;
}
