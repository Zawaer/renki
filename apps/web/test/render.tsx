import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

/**
 * Minimal DOM render helper, deliberately bypassing @testing-library/react's
 * own render()/cleanup().
 *
 * With the exact React + @testing-library/react versions in this workspace,
 * React's act() only flushes a commit once its returned promise is awaited —
 * even for a synchronous callback — but @testing-library/react's render()
 * doesn't await its own internal act() call (its API is synchronous by
 * design). Layering an awaited act() on top of that produces a nested-act
 * conflict that throws inside hooks (useContext reading a null dispatcher
 * mid-render). flushSync sidesteps all of it by forcing the commit
 * synchronously and reliably — confirmed directly against this exact
 * React/jsdom combination. @testing-library/dom's `screen` queries still
 * work fine here since they just query document.body, regardless of how
 * its content got rendered.
 */
const roots: Root[] = [];

export function render(ui: ReactElement): void {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  flushSync(() => root.render(ui));
}

export function cleanupRoots(): void {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.innerHTML = "";
}
