import { z } from "zod";

/**
 * The Mac bridge: a small agent on the user's Mac (apps/mac-node) dials OUT to
 * the daemon at `/mac/ws` and lends it the phone plugged into that Mac, over
 * adb. Sessions reach it only through the daemon's `mac` MCP tools; there is no
 * REST route that runs anything on the Mac.
 *
 * The Mac is the trust boundary. It parses every call with the schemas below
 * (the same ones the daemon builds them from), runs `adb` with an argv array
 * and never a Mac shell, and only offers the verbs its own config enables.
 * A session can therefore ask for anything, but only these shapes ever run.
 */

/** A device serial as `adb devices` prints it: USB serials, or `ip:port` for wireless debugging. */
export const AdbSerial = z.string().regex(/^[\w.:-]{1,64}$/);

export const MacVerbArgs = {
  /** `adb devices -l`. */
  devices: z.object({}).strict(),
  /** The phone's screen, scaled down so it is cheap to look at. */
  screenshot: z.object({ serial: AdbSerial.optional() }).strict(),
  /** Recent log lines (`logcat -d`), optionally filtered to tags and/or a substring. */
  logcat: z
    .object({
      serial: AdbSerial.optional(),
      lines: z.number().int().min(1).max(5000).optional(),
      /** logcat filterspecs, e.g. `ReactNativeJS:V`; everything else is then silenced. */
      tags: z.array(z.string().regex(/^[\w.$-]+(?::[VDIWEFS])?$|^\*:[VDIWEFS]$/)).max(20).optional(),
      /** Keep only lines containing this (case-insensitive). Applied on the Mac. */
      grep: z.string().max(200).optional(),
      /** Clear the buffer after reading, so the next read shows only what is new. */
      clear: z.boolean().optional(),
    })
    .strict(),
  /** Touch and keyboard input, without a free shell. */
  input: z
    .object({
      serial: AdbSerial.optional(),
      action: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("tap"), x: z.number().int().min(0).max(10000), y: z.number().int().min(0).max(10000) }),
        z.object({
          kind: z.literal("swipe"),
          x1: z.number().int().min(0).max(10000),
          y1: z.number().int().min(0).max(10000),
          x2: z.number().int().min(0).max(10000),
          y2: z.number().int().min(0).max(10000),
          durationMs: z.number().int().min(0).max(10000).optional(),
        }),
        z.object({ kind: z.literal("text"), text: z.string().min(1).max(1000) }),
        /** A keycode name (`KEYCODE_BACK`, `BACK`, `HOME`, `ENTER`…) or number. */
        z.object({ kind: z.literal("key"), key: z.string().regex(/^(KEYCODE_)?[A-Z0-9_]{1,40}$/) }),
      ]),
    })
    .strict(),
  /** A command run by the PHONE's shell (`adb shell`), never the Mac's. */
  shell: z.object({ serial: AdbSerial.optional(), command: z.string().min(1).max(4000) }).strict(),
  /** Install an APK the daemon offers (by id); the Mac downloads it from its own configured daemon. */
  install: z
    .object({
      serial: AdbSerial.optional(),
      fileId: z.string().regex(/^[\w-]{16,64}$/),
      name: z.string().max(200),
      /** Allow installing an older versionCode over a newer one (`-d`). */
      downgrade: z.boolean().optional(),
    })
    .strict(),
} as const;

export type MacVerb = keyof typeof MacVerbArgs;
export const MAC_VERBS = Object.keys(MacVerbArgs) as MacVerb[];
export type MacArgs<V extends MacVerb> = z.infer<(typeof MacVerbArgs)[V]>;

/** One call, as the daemon sends it. The Mac checks `args` against MacVerbArgs[verb] again. */
export const MacCall = z.object({
  type: z.literal("call"),
  id: z.string().max(64),
  verb: z.enum(MAC_VERBS as [MacVerb, ...MacVerb[]]),
  args: z.record(z.string(), z.unknown()),
});
export type MacCall = z.infer<typeof MacCall>;

export const DaemonToMac = z.discriminatedUnion("type", [
  MacCall,
  /** Application-level keepalive: the Mac answers `pong`, and reconnects if it hears nothing for a while (sleep, network change). */
  z.object({ type: z.literal("ping") }),
]);
export type DaemonToMac = z.infer<typeof DaemonToMac>;

export const MacImage = z.object({ mediaType: z.enum(["image/png", "image/jpeg"]), data: z.string() });
export type MacImage = z.infer<typeof MacImage>;

export const MacToDaemon = z.discriminatedUnion("type", [
  /** First message after connecting. `verbs` is what this Mac's own config allows. */
  z.object({
    type: z.literal("hello"),
    name: z.string().max(100),
    version: z.string().max(40),
    verbs: z.array(z.string()),
  }),
  z.object({
    type: z.literal("result"),
    id: z.string().max(64),
    ok: z.boolean(),
    /** Output for Claude (already capped by the Mac), or the error message when !ok. */
    text: z.string(),
    image: MacImage.optional(),
  }),
  z.object({ type: z.literal("pong") }),
]);
export type MacToDaemon = z.infer<typeof MacToDaemon>;

/** `GET /mac`: whether a Mac is lending its phone right now. */
export const MacStatus = z.object({
  connected: z.boolean(),
  name: z.string().nullable(),
  since: z.number().nullable(),
  verbs: z.array(z.string()),
});
export type MacStatus = z.infer<typeof MacStatus>;
