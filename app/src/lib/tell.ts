import { Capacitor, registerPlugin } from "@capacitor/core"
import { toast } from "sonner"

/** The plugin's registration name, as `MainActivity` registers it: the phone's own toast. */
const TOAST_PLUGIN = "Toast"

interface ToastPlugin {
  /** Shows one line at the bottom of the screen; `long` holds it there about twice as long. */
  show(options: { text: string; long?: boolean }): Promise<void>
}

const Toast = registerPlugin<ToastPlugin>(TOAST_PLUGIN)

/** True inside the Android app, where the page is served from `https://localhost`. */
const isNative = Capacitor.isNativePlatform()

/**
 * One toast: the phone's own inside the Android app, the page's toaster everywhere else. An APK
 * built before the plugin has no toast to show and no method to call — one would throw — so the
 * page's toaster says the words rather than the message going unsaid.
 */
function say(text: string, long: boolean, web: () => void) {
  if (isNative && Capacitor.isPluginAvailable(TOAST_PLUGIN)) {
    try {
      void Toast.show({ text, long }).catch((error: unknown) => {
        console.debug("[gots] the phone's toast didn't show:", error)
        web()
      })
      return
    } catch (error) {
      // A bridge that refuses the call outright: the page's toaster still says it.
      console.debug("[gots] the phone's toast didn't show:", error)
    }
  }
  web()
}

/**
 * What the app tells the user in passing, wherever it runs: an error stays up twice as long as a
 * note, and on the web the three are the toaster's own three tones.
 */
export const tell = {
  error: (text: string) => say(text, true, () => toast.error(text)),
  info: (text: string) => say(text, false, () => toast.info(text)),
  success: (text: string) => say(text, false, () => toast.success(text)),
}
