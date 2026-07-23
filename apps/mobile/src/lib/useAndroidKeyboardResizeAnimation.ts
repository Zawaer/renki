import { useEffect } from "react";
import { Keyboard, LayoutAnimation, Platform, UIManager } from "react-native";

// Old-architecture-only flag (a no-op under Fabric/the New Architecture,
// which this app runs — harmless either way); needed for LayoutAnimation to
// do anything on Android at all when it does apply.
if (Platform.OS === "android") UIManager.setLayoutAnimationEnabledExperimental?.(true);

/**
 * Android has no `KeyboardAvoidingView` "padding" behavior (only iOS does),
 * so a screen with a composer otherwise just snaps to its new position the
 * instant the OS finishes resizing the window for the keyboard — a hard jump
 * instead of following the keyboard up/down. Wrapping that resize-driven
 * layout change in a `LayoutAnimation` smooths it into a real transition.
 *
 * This is a best-effort approximation, not frame-perfect — Android doesn't
 * hand plain React Native a live per-frame keyboard height the way iOS does,
 * and `LayoutAnimation` has a spotty history under the New Architecture.
 * Kept behind this one hook (rather than inlined in a screen's mount effect)
 * so swapping it for a real fix (`react-native-keyboard-controller`) later
 * is a one-file change, not a hunt through whatever screen used it.
 */
export function useAndroidKeyboardResizeAnimation(): void {
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const animate = () =>
      LayoutAnimation.configureNext(LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
    const showSub = Keyboard.addListener("keyboardDidShow", animate);
    const hideSub = Keyboard.addListener("keyboardDidHide", animate);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
}
