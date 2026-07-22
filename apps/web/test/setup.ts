import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

/**
 * Newer Node (this repo currently runs on v25) ships its own experimental
 * Web Storage global, which can shadow jsdom's real `localStorage` in this
 * test environment — present as `typeof localStorage === "object"` but
 * non-functional (no working `setItem`/`getItem` without a
 * `--localstorage-file` path), so any component reading/writing localStorage
 * (e.g. src/lib/permissionModePrefs.ts) throws mid-render and the whole tree
 * fails to mount. Replace it with a small in-memory Storage so tests behave
 * like a real browser regardless of which one wins on a given Node version.
 */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
});

afterEach(() => {
  globalThis.localStorage.clear();
});
