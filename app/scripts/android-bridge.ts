/**
 * The Android app as a component test sees it: the bridge Capacitor reads the platform from, and the
 * plugin headers that make a plugin's methods the native ones. A plugin without a header is an APK
 * built before it, which `withoutPlugin` fakes before the app is imported.
 */

/** The calls to the notification settings plugin a page made, in the order it made them. */
export const bridgeCalls: string[] = []

const headers = [
  {
    name: "App",
    methods: [
      { name: "addListener", rtype: "promise" },
      { name: "removeListener", rtype: "promise" },
    ],
  },
  { name: "NotificationSettings", methods: [{ name: "open", rtype: "promise" }] },
]

Object.defineProperty(globalThis, "androidBridge", {
  value: {},
  writable: true,
  configurable: true,
})
Object.defineProperty(globalThis, "Capacitor", {
  value: {
    PluginHeaders: headers,
    nativePromise: (plugin: string, method: string) => {
      if (plugin === "NotificationSettings") bridgeCalls.push(`${plugin}.${method}`)
      return Promise.resolve()
    },
  },
  writable: true,
  configurable: true,
})

/** Drops a plugin's header, as an APK that predates it has none: `isPluginAvailable` then says no. */
export function withoutPlugin(name: string) {
  const at = headers.findIndex((header) => header.name === name)
  if (at >= 0) headers.splice(at, 1)
}
