/**
 * The Android app as a component test sees it: the bridge Capacitor reads the platform from, and the
 * plugin headers that make a plugin's methods the native ones. A plugin without a header is an APK
 * built before it, which `withoutPlugin` fakes before the app is imported.
 */

/** The calls a page made to the native plugins, in the order it made them. */
export const bridgeCalls: string[] = []

/** What the phone answers about the Bubble, as a test sets it: the grants and the service's state. */
export const bubbleAnswer = {
  enabled: false,
  overlay: false,
  accessibility: false,
  /** Whether the phone has granted the microphone: a runtime prompt, so it starts granted here. */
  microphone: true,
}

/** What the page told the Bubble to dictate with, one entry per `configure`, in order. */
export const bubbleConfigured: { profileId: string; root: string }[] = []

/** The takes the phone is holding for the log: read until the page says it has written them. */
export const bubbleKept: unknown[] = []

const headers = [
  {
    name: "App",
    methods: [
      { name: "addListener", rtype: "promise" },
      { name: "removeListener", rtype: "promise" },
    ],
  },
  { name: "NotificationSettings", methods: [{ name: "open", rtype: "promise" }] },
  {
    name: "Bubble",
    methods: [
      { name: "configure", rtype: "promise" },
      { name: "requestMicrophone", rtype: "promise" },
      { name: "enable", rtype: "promise" },
      { name: "disable", rtype: "promise" },
      { name: "state", rtype: "promise" },
      { name: "takeaways", rtype: "promise" },
      { name: "took", rtype: "promise" },
      { name: "openOverlay", rtype: "promise" },
      { name: "openAccessibility", rtype: "promise" },
    ],
  },
]

Object.defineProperty(globalThis, "androidBridge", {
  value: {},
  writable: true,
  configurable: true,
})
Object.defineProperty(globalThis, "Capacitor", {
  value: {
    PluginHeaders: headers,
    nativePromise: (plugin: string, method: string, options?: unknown) => {
      if (plugin === "NotificationSettings") bridgeCalls.push(`${plugin}.${method}`)
      if (plugin !== "Bubble") return Promise.resolve()
      bridgeCalls.push(`${plugin}.${method}`)
      // The phone is the one that decides: enabling starts the service and clears its flag, and
      // enabling without the draw-over grant starts nothing.
      if (method === "configure") {
        bubbleConfigured.push(options as { profileId: string; root: string })
        return Promise.resolve()
      }
      if (method === "state") return Promise.resolve({ ...bubbleAnswer })
      if (method === "takeaways") return Promise.resolve({ kept: [...bubbleKept] })
      if (method === "took") {
        // The phone drops what the page wrote, and nothing else: the rest is handed over again.
        const ids = (options as { ids?: string[] } | undefined)?.ids ?? []
        for (const id of ids) {
          const at = bubbleKept.findIndex((take) => (take as { id?: string }).id === id)
          if (at >= 0) bubbleKept.splice(at, 1)
        }
        return Promise.resolve()
      }
      if (method === "requestMicrophone") {
        return Promise.resolve({ granted: bubbleAnswer.microphone })
      }
      if (method === "enable") {
        // Half a grant is no Bubble: the phone refuses the same three ways the plugin does.
        if (!bubbleAnswer.overlay) return Promise.resolve({ started: false, reason: "overlay" })
        if (!bubbleAnswer.accessibility) {
          return Promise.resolve({ started: false, reason: "accessibility" })
        }
        if (!bubbleAnswer.microphone) return Promise.resolve({ started: false, reason: "microphone" })
        bubbleAnswer.enabled = true
        return Promise.resolve({ started: true })
      }
      if (method === "disable") {
        bubbleAnswer.enabled = false
        return Promise.resolve()
      }
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
