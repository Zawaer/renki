import { describe, expect, it } from "vitest";
import {
  activeHost,
  addHost,
  emptyHostsState,
  migrateSingleConnection,
  removeHost,
  setActiveHost,
  updateHost,
} from "../src/hosts.js";

const profile = (label: string, baseUrl = "https://x.internal") => ({
  label,
  baseUrl,
  token: "t",
  deviceName: "Web",
});

describe("addHost", () => {
  it("adds a host and makes it the active one — you just paired it, you meant to switch to it", () => {
    let state = emptyHostsState();
    state = addHost(state, profile("Homelab"));
    expect(state.hosts).toHaveLength(1);
    expect(activeHost(state)?.label).toBe("Homelab");

    state = addHost(state, profile("Mac"));
    expect(state.hosts).toHaveLength(2);
    expect(activeHost(state)?.label).toBe("Mac");
  });

  it("gives every host a distinct id", () => {
    let state = emptyHostsState();
    state = addHost(state, profile("A"));
    state = addHost(state, profile("B"));
    const ids = state.hosts.map((h) => h.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("removeHost", () => {
  it("falls back to another host when the active one is removed", () => {
    let state = emptyHostsState();
    state = addHost(state, profile("Homelab"));
    state = addHost(state, profile("Mac")); // Mac is now active
    const homelabId = state.hosts[0].id;
    const macId = state.hosts[1].id;

    state = removeHost(state, macId);

    expect(state.hosts.map((h) => h.id)).toEqual([homelabId]);
    expect(state.activeId).toBe(homelabId);
  });

  it("leaves the active host untouched when removing a different one", () => {
    let state = emptyHostsState();
    state = addHost(state, profile("Homelab"));
    state = addHost(state, profile("Mac"));
    const homelabId = state.hosts[0].id;

    state = removeHost(state, homelabId);

    expect(activeHost(state)?.label).toBe("Mac");
  });

  it("goes to null (empty) once the last host is removed — the app falls back to onboarding", () => {
    let state = emptyHostsState();
    state = addHost(state, profile("Only"));
    const id = state.hosts[0].id;

    state = removeHost(state, id);

    expect(state.hosts).toEqual([]);
    expect(state.activeId).toBeNull();
    expect(activeHost(state)).toBeNull();
  });
});

describe("setActiveHost", () => {
  it("switches to an existing host", () => {
    let state = emptyHostsState();
    state = addHost(state, profile("Homelab"));
    state = addHost(state, profile("Mac"));
    const homelabId = state.hosts[0].id;

    state = setActiveHost(state, homelabId);

    expect(activeHost(state)?.label).toBe("Homelab");
  });

  /** A stale id (host removed elsewhere, or a bad deep link) must never blank the active host. */
  it("is a no-op for an id that isn't in the list", () => {
    let state = emptyHostsState();
    state = addHost(state, profile("Homelab"));
    const before = state;

    state = setActiveHost(state, "not-a-real-id");

    expect(state).toEqual(before);
  });
});

describe("updateHost", () => {
  it("renames a host without touching which one is active or the others", () => {
    let state = emptyHostsState();
    state = addHost(state, profile("Homelab"));
    state = addHost(state, profile("Mac"));
    const homelabId = state.hosts[0].id;

    state = updateHost(state, homelabId, { label: "Server" });

    expect(state.hosts[0].label).toBe("Server");
    expect(state.hosts[1].label).toBe("Mac");
    expect(activeHost(state)?.label).toBe("Mac");
  });
});

describe("migrateSingleConnection", () => {
  it("turns an existing single connection into a one-host list, so upgrading never un-pairs a device", () => {
    const state = migrateSingleConnection({ baseUrl: "https://old.internal", token: "tkn", deviceName: "Phone" });
    expect(state.hosts).toHaveLength(1);
    expect(state.hosts[0]).toMatchObject({ baseUrl: "https://old.internal", token: "tkn", deviceName: "Phone" });
    expect(activeHost(state)).toBe(state.hosts[0]);
  });

  it("is empty when there was nothing to migrate", () => {
    expect(migrateSingleConnection(null)).toEqual(emptyHostsState());
  });
});
