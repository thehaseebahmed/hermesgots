import { Capacitor, registerPlugin } from "@capacitor/core"
import { toast } from "sonner"

import { isNative } from "@/lib/platform"
import { TELL_TONES } from "@/lib/tell-tones"

/** The plugin's registration name, as `MainActivity` registers it: the phone's own toast. */
const TOAST_PLUGIN = "Toast"

interface ToastPlugin {
  /** Shows one line at the bottom of the screen; `long` holds it there about twice as long. */
  show(options: { text: string; long?: boolean }): Promise<void>
  /** Takes the toast away where it is still up. */
  hide(): Promise<void>
}

const Toast = registerPlugin<ToastPlugin>(TOAST_PLUGIN)

/**
 * The four things the app says in passing, named for what they draw in the page: the type is
 * `TELL_TONES`' own, so the tone list the guard over toasts reads and the set this seam draws are
 * one list rather than two that agree today.
 */
export type TellTone = (typeof TELL_TONES)[number]

/** Each tone as the page's toaster draws it: a note is its message, which carries no icon. */
const page: Record<TellTone, (text: string, duration?: number) => void> = {
  error: (text) => toast.error(text),
  info: (text) => toast.info(text),
  success: (text) => toast.success(text),
  note: (text, duration) => toast.message(text, duration ? { duration } : undefined),
}

/**
 * What a toast that asks to be held lasts: Android's long toast, and the span the page's toaster is
 * given for the same words.
 */
export const TELL_LONG_MS = 3500

/**
 * One toast: the phone's own inside the Android app, the page's toaster everywhere else. An APK
 * built before the plugin has no toast to show, and a phone whose plugin refuses — or is gone
 * before it answers — leaves the words to the page, since a toast that says nothing is worse than
 * one drawn by the wrong hand.
 */
function say(tone: TellTone, text: string, long: boolean) {
  if (!text.trim()) return
  const duration = long ? TELL_LONG_MS : undefined
  const inThePage = (error: unknown) => {
    console.debug("[gots] the phone's toast didn't show:", error)
    page[tone](text, duration)
  }
  try {
    if (isNative() && Capacitor.isPluginAvailable(TOAST_PLUGIN)) {
      void Promise.race([
        Toast.show({ text, long }),
        // A plugin call that never settles is what a WebView torn down mid-call looks like: the
        // bridge keeps the promise, and the phone never answers.
        new Promise((_, refuse) =>
          setTimeout(() => refuse(new Error("the phone didn't answer")), TELL_LONG_MS),
        ),
      ]).catch(inThePage)
      return
    }
  } catch (error) {
    inThePage(error)
    return
  }
  page[tone](text, duration)
}

/**
 * What the app tells the user in passing, wherever it runs: an error asks for the phone's long
 * toast and the other three for the short one, while on the web each is the toaster's own tone —
 * the note's being no tone at all, which is what a message like "Copied" asks for. A note may ask
 * to be held, for the one message whose words are timed against the toast itself.
 */
export const tell = {
  error: (text: string) => say("error", text, true),
  info: (text: string) => say("info", text, false),
  success: (text: string) => say("success", text, false),
  note: (text: string, { long = false }: { long?: boolean } = {}) => say("note", text, long),
  /**
   * Takes away what the app is saying in passing, where the platform can: the phone's toast, or the
   * page's. A build whose plugin predates `hide` is asked and rejects, which is the same as there
   * being nothing left to take away.
   */
  dismiss: () => {
    const nothing = (error: unknown) => console.debug("[gots] nothing to take away:", error)
    try {
      if (isNative() && Capacitor.isPluginAvailable(TOAST_PLUGIN)) {
        void Toast.hide().catch(nothing)
        return
      }
    } catch (error) {
      nothing(error)
      return
    }
    toast.dismiss()
  },
}
