import { type ReactNode, useState } from "react";
import { type StyleProp, StyleSheet, useWindowDimensions, View, type ViewStyle } from "react-native";

/**
 * The one child every Modal in the app renders its contents in.
 *
 * A Modal's root has come up 0x0 now and then on Android (most often when it
 * opened while the keyboard was closing), and stays that way: everything in it
 * laid out at zero size, drawn as a few icons squashed into the screen's
 * top-left corner instead of the sheet or screen. This sizes its contents from
 * the window until the root reports a real size of its own, then follows that.
 */
export function ModalFrame({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const screen = useWindowDimensions();
  const [root, setRoot] = useState<{ width: number; height: number } | null>(null);
  const size = root && root.width > 0 && root.height > 0 ? root : { width: screen.width, height: screen.height };
  return (
    <>
      {/* Measures the Modal's own root. */}
      <View
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setRoot((cur) => (cur && cur.width === width && cur.height === height ? cur : { width, height }));
        }}
      />
      <View style={[styles.frame, { width: size.width, height: size.height }, style]}>{children}</View>
    </>
  );
}

const styles = StyleSheet.create({
  frame: { position: "absolute", top: 0, left: 0 },
});
