import * as SecureStore from "expo-secure-store";

/**
 * The approval service's address, remembered from the last approval
 * notification, so the app can ask it to resend one that was swiped away. Not
 * a secret: it's the same address every notification carries. The only way to
 * learn it is from one, so it's unknown until the first approval arrives.
 */
const KEY = "renki.gatewayApprovalsUrl";

export async function loadGatewayUrl(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

export function rememberGatewayUrl(url: string): void {
  void SecureStore.setItemAsync(KEY, url).catch(() => {});
}
