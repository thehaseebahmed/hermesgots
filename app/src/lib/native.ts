import { App } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"
import { toast } from "sonner"

/** True inside the Android app, where the page is served from `https://localhost`. */
export const isNative = Capacitor.isNativePlatform()

/** The Netlify deploy the app signs in and syncs through, baked in by `pnpm build:android`. */
export const SITE_URL = (import.meta.env.VITE_SITE_URL ?? "").replace(/\/+$/, "")

const NATIVE_AUTH = "memento-native-auth"

/**
 * GoTrue returns to the page that started sign-in, `/auth/native.html`. If it lands on the site
 * root instead, send the tokens on to that page so they reach the app, not this browser.
 */
export function handBackNativeSignIn() {
  if (isNative || !location.hash.includes("access_token=")) return false
  let started: number
  try {
    started = Number(localStorage.getItem(NATIVE_AUTH))
    localStorage.removeItem(NATIVE_AUTH)
  } catch {
    return false
  }
  if (!started || Date.now() - started > 10 * 60_000) return false
  location.replace(`/auth/native.html${location.hash}`)
  return true
}

let backGuard: (() => boolean) | undefined

/**
 * A screen's say over the back button: return true when it handled the press itself. Returns the
 * cleanup, which leaves a guard the next screen already set alone.
 */
export function setBackGuard(guard: () => boolean) {
  backGuard = guard
  return () => {
    if (backGuard === guard) backGuard = undefined
  }
}

/** How long a second back press has to leave the app after the first. */
const EXIT_WINDOW = 2000
export const EXIT_TOASTER = "exit"

/**
 * Sits the exit toast at the bottom, above whatever the screen keeps there (marked
 * `data-toast-above`: a chat's composer, the Code screen's New project button).
 */
function placeExitToast() {
  let bottom = 0
  for (const el of document.querySelectorAll("[data-toast-above]")) {
    const { top, height } = el.getBoundingClientRect()
    if (height) bottom = Math.max(bottom, window.innerHeight - top)
  }
  document.documentElement.style.setProperty(
    "--exit-toast-bottom",
    bottom ? `${bottom + 8}px` : "max(1rem, env(safe-area-inset-bottom))",
  )
}

/**
 * Android's back button goes up from a screen that sets a guard (a project, a session) and leaves
 * the app from a top-level one, whatever was opened before it, but only on a second press within
 * `EXIT_WINDOW`, so a stray press doesn't. Leaving minimizes rather than exits, as Android's own
 * back does from 12 on, so a reply keeps streaming and the screen stays.
 */
export function handleBackButton() {
  if (!isNative) return
  let armedAt = 0
  void App.addListener("backButton", () => {
    if (backGuard?.()) {
      armedAt = 0
      return
    }
    if (Date.now() - armedAt < EXIT_WINDOW) {
      armedAt = 0
      toast.dismiss(EXIT_TOASTER)
      void App.minimizeApp()
      return
    }
    armedAt = Date.now()
    placeExitToast()
    toast("Press back again to exit", {
      id: EXIT_TOASTER,
      toasterId: EXIT_TOASTER,
      duration: EXIT_WINDOW,
    })
  })
}
