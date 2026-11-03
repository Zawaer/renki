/**
 * A panel's draggable edge: the sidebar's right edge, the workspace panel's left.
 *
 * Invisible until you approach it — a permanent divider line on a UI whose
 * hierarchy comes from tone would be a piece of furniture you can't use for
 * anything else. The hit area straddles the border and is wider than the line
 * it draws, because a 1px target is a target you miss.
 */
export function ResizeHandle({
  edge,
  label,
  hint,
  width,
  min,
  max,
  onPointerDown,
  onKeyDown,
  onDoubleClick,
  className = "",
}: {
  /** Which edge of its (positioned) parent the handle sits on. */
  edge: "left" | "right";
  label: string;
  hint: string;
  width: number;
  min: number;
  max: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onDoubleClick: () => void;
  className?: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      title={hint}
      className={`group absolute top-0 z-30 h-full w-2 cursor-col-resize touch-none focus-visible:outline-none ${edge === "right" ? "-right-1" : "-left-1"} ${className}`}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-(--renki-accent) opacity-0 transition-opacity duration-150 group-hover:opacity-70 group-focus-visible:opacity-100 group-active:opacity-100" />
    </div>
  );
}

/**
 * Run a resize drag with the listeners on the WINDOW, not the handle: a drag
 * can re-render the handle away (the sidebar collapsing to its rail swaps
 * branches), and pointer capture on it would die with it. `move` gets every
 * pointer position; `end` runs once on release.
 */
export function trackResizeDrag(e: React.PointerEvent, move: (ev: PointerEvent) => void, end: () => void): void {
  if (e.button !== 0) return;
  e.preventDefault();
  // A cancelled pointer (the browser took over a touch, say) never sends
  // pointerup; without this the drag stayed attached to every later move.
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    document.body.classList.remove("renki-resizing");
    end();
  };
  // Held on <body> so the resize cursor survives crossing other elements and
  // a drag can't select text on the way past.
  document.body.classList.add("renki-resizing");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
