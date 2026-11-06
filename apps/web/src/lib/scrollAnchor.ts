/**
 * Keeps what you're reading in place while content above it changes (history
 * landing, a running agent's card growing as it works). The transcript turns
 * the browser's own scroll anchoring off, since Safari has none and the two
 * together would double it, so this does the same by hand.
 *
 * The anchor is the first element marked [data-anchor] that starts in view:
 * a message, a turn or a text block. Cards and tool groups carry no anchor,
 * so it lands on text rather than on the thing that's changing.
 *
 * Positions are layout offsets (offsetTop), never getBoundingClientRect: a
 * trackpad pinch zooms the visual viewport, and in Firefox-based browsers that
 * changes client rects, so every re-render during a zoom read as the anchor
 * having moved and nudged the scroll (the chat jittered). Offsets also ignore
 * transforms, like the slide-in on a new message. `content` must be the
 * offsetParent of what's inside it (position: relative), and `root` of `content`.
 */
export type ScrollAnchor = { el: HTMLElement; offset: number } | null;

/** `el`'s top within `content`, in layout pixels; NaN if `content` isn't on its offsetParent chain. */
export function offsetWithin(el: HTMLElement, content: HTMLElement): number {
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== content) {
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return node === content ? y : Number.NaN;
}

/** The first [data-anchor] element in `content` that starts inside `root`'s view, and where. */
export function pickAnchor(root: HTMLElement, content: HTMLElement): ScrollAnchor {
  const viewTop = root.scrollTop - content.offsetTop;
  const els = content.querySelectorAll<HTMLElement>("[data-anchor]");
  // Document order is top-to-bottom order here, so find the first one starting in view.
  let lo = 0;
  let hi = els.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsetWithin(els[mid]!, content) >= viewTop) hi = mid;
    else lo = mid + 1;
  }
  const el = els[lo];
  if (!el) return null;
  const offset = offsetWithin(el, content);
  return Number.isNaN(offset) ? null : { el, offset };
}

/** Scroll `root` by however far the anchor moved within `content`. Returns how far it scrolled. */
export function restoreAnchor(root: HTMLElement, content: HTMLElement, anchor: ScrollAnchor): number {
  if (!anchor || !anchor.el.isConnected) return 0;
  const moved = offsetWithin(anchor.el, content) - anchor.offset;
  if (Number.isNaN(moved) || Math.abs(moved) < 1) return 0;
  root.scrollTop += moved;
  return moved;
}
