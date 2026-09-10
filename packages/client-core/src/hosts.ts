/**
 * Multiple daemons, one client. A "host" is one daemon this device knows
 * about — a homelab box, a laptop, whatever's running Renki — identified by
 * its own baseUrl/token, with a short label the user picks ("Homelab", "Mac").
 *
 * `deviceId` is deliberately NOT part of a host: it identifies this browser or
 * phone, not a pairing, and is shared across every host it talks to. Each
 * daemon only tracks the take-control lock within its own event log, so reusing
 * the same id across daemons is safe — there's no cross-daemon collision to
 * worry about — and it means "this device" stays one consistent identity as you
 * switch where it's pointed, rather than minting a new one per host.
 *
 * Pure logic only. Each client owns actually persisting a HostsState — web in
 * localStorage, mobile in SecureStore as a JSON blob (SecureStore has no native
 * list type) — and calls these functions to change it.
 */
export type HostProfile = {
  id: string;
  /** Short, user-chosen name — "Homelab", "Mac". Never inferred from the URL, which can be a raw IP or a long tailnet hostname. */
  label: string;
  baseUrl: string;
  token: string;
  deviceName: string;
};

export type HostsState = {
  hosts: HostProfile[];
  /** null only when `hosts` is empty — the app falls back to onboarding in that case. */
  activeId: string | null;
};

export function emptyHostsState(): HostsState {
  return { hosts: [], activeId: null };
}

/** A short id for a new host row — not a security token, just a stable local key. */
export function newHostId(): string {
  return `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function activeHost(state: HostsState): HostProfile | null {
  return state.hosts.find((h) => h.id === state.activeId) ?? null;
}

/** Adds a host and makes it active — a freshly paired host is the one you meant to switch to. */
export function addHost(state: HostsState, profile: Omit<HostProfile, "id">): HostsState {
  const host: HostProfile = { ...profile, id: newHostId() };
  return { hosts: [...state.hosts, host], activeId: host.id };
}

export function updateHost(state: HostsState, id: string, patch: Partial<Omit<HostProfile, "id">>): HostsState {
  return { ...state, hosts: state.hosts.map((h) => (h.id === id ? { ...h, ...patch } : h)) };
}

/**
 * Removes a host. If it was the active one, falls back to whichever host is
 * now first — never leaves the app pointed at a host that no longer exists.
 */
export function removeHost(state: HostsState, id: string): HostsState {
  const hosts = state.hosts.filter((h) => h.id !== id);
  const activeId = state.activeId === id ? (hosts[0]?.id ?? null) : state.activeId;
  return { hosts, activeId };
}

/** No-op if `id` isn't a host in this state — switching to a stale id should never blank the active host. */
export function setActiveHost(state: HostsState, id: string): HostsState {
  if (!state.hosts.some((h) => h.id === id)) return state;
  return { ...state, activeId: id };
}

/**
 * Turns a pre-multi-host single connection into a one-host list, so an
 * existing pairing survives the upgrade instead of vanishing into an empty
 * host list on first load of the new code.
 */
export function migrateSingleConnection(
  config: { baseUrl: string; token: string; deviceName: string } | null,
  label = "This connection",
): HostsState {
  if (!config) return emptyHostsState();
  return addHost(emptyHostsState(), { label, baseUrl: config.baseUrl, token: config.token, deviceName: config.deviceName });
}
