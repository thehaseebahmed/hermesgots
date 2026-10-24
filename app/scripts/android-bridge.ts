/**
 * The Android app's page, as a component test sees it: the bridge Capacitor reads the platform
 * from, the plugin headers that make a call go over it, and the Firebase flag CI sets on an APK
 * built with a `google-services.json`.
 *
 * A test imports this before anything the app owns, because both are read at module load: `isNative`
 * is the Capacitor constant (`@/lib/native`) and `pushAvailable()` reads the Firebase flag
 * (`@/lib/push`). Import it first in the import list, and the modules loaded after it freeze the
 * platform the way an installed APK does.
 */

/** The calls to the notification settings plugin a page made, in the order it made them. */
export const bridgeCalls: string[] = []

const env = (globalThis as unknown as { __HERMES_ENV__: Record<string, unknown> }).__HERMES_ENV__
env.VITE_FIREBASE = "1"

// Capacitor answers `androidBridge` for the platform, and only a plugin header makes a method the
// native one: without it a call throws "not implemented" and never reaches the bridge. `App` is
// there because an installed APK has it and a screen listens for a resume when it loads.
Object.defineProperty(globalThis, "androidBridge", {
  value: {},
  writable: true,
  configurable: true,
})
Object.defineProperty(globalThis, "Capacitor", {
  value: {
    PluginHeaders: [
      {
        name: "App",
        methods: [
          { name: "addListener", rtype: "promise" },
          { name: "removeListener", rtype: "promise" },
        ],
      },
      { name: "NotificationSettings", methods: [{ name: "open", rtype: "promise" }] },
    ],
    nativePromise: (plugin: string, method: string) => {
      if (plugin === "NotificationSettings") bridgeCalls.push(`${plugin}.${method}`)
      return Promise.resolve()
    },
  },
  writable: true,
  configurable: true,
})
