import { addHost, type HostsState } from "@renki/client-core";
import { saveHosts } from "../lib/hosts.js";
import { Setup } from "./Setup.js";

/**
 * "+ Add another host" — the same connect-and-test flow as first-run
 * onboarding, but as a modal that appends to the host list and reloads,
 * instead of replacing the only connection there is.
 */
export function AddHostModal({ state, onClose }: { state: HostsState; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        <Setup
          mode="add-host"
          onCancel={onClose}
          onSave={(config, label) => {
            saveHosts(
              addHost(state, {
                label: label || "New host",
                baseUrl: config.baseUrl,
                token: config.token,
                deviceName: config.deviceName,
              }),
            );
            window.location.reload();
          }}
        />
      </div>
    </div>
  );
}
