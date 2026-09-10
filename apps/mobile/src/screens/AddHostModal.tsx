import { addHost, type HostsState } from "@renki/client-core";
import { Modal } from "react-native";
import { Setup } from "./Setup";

/** "Add another host" — the same connect-and-test flow as onboarding, as a full-screen modal that appends to the list instead of replacing the only connection there is. */
export function AddHostModal({
  visible,
  state,
  onClose,
  onAdded,
}: {
  visible: boolean;
  state: HostsState;
  onClose: () => void;
  onAdded: (next: HostsState) => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <Setup
        mode="add-host"
        onCancel={onClose}
        onSave={(config, label) => {
          onAdded(addHost(state, { label: label || "New host", baseUrl: config.baseUrl, token: config.token, deviceName: config.deviceName }));
          onClose();
        }}
      />
    </Modal>
  );
}
