import * as LocalAuthentication from "expo-local-authentication";

/**
 * Fingerprint (or the phone's PIN) before approving a homelab request. The one-time token in the
 * notification keeps chats from approving; this keeps someone holding your unlocked phone from it.
 * A phone with no screen lock at all has nothing to check against, so it passes.
 */
export async function confirmIdentity(reason: string): Promise<boolean> {
  try {
    if ((await LocalAuthentication.getEnrolledLevelAsync()) === LocalAuthentication.SecurityLevel.NONE) return true;
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: "Cancel", disableDeviceFallback: false });
    return r.success;
  } catch {
    return false;
  }
}
