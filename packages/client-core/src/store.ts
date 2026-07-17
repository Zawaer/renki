/**
 * Minimal observable store implementing the exact contract React's
 * useSyncExternalStore wants: getSnapshot + subscribe. Framework-neutral, so
 * React Native can consume it the same way. No dependencies.
 */
export type Listener = () => void;

export class Store<T> {
  private state: T;
  private readonly listeners = new Set<Listener>();

  constructor(initial: T) {
    this.state = initial;
  }

  get = (): T => this.state;

  set(next: T): void {
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  }

  update(fn: (s: T) => T): void {
    this.set(fn(this.state));
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
