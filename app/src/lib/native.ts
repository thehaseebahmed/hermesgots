import { App } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"
import { toast } from "sonner"

import { placeToasts } from "@/lib/toast"

/** True inside the Android app, where the page is served from `https://localhost`. */
export const isNative = Capacitor.isNativePlatform()

/**
 * Opens an image at full size in the platform's own viewer: a browser tab here, the Android app's
 * system photo viewer once its bridge is wired in.
 */
export function openImageViewer(url: string) {
  window.open(url, "_blank")
}

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

/** Closes the frontmost open pop-up or dialog as Escape would. Returns whether there was one. */
function closeTopPopup() {
  const open = document.querySelectorAll<HTMLElement>(
    '[role="dialog"][data-open], [role="alertdialog"][data-open]',
  )
  const top = open[open.length - 1]
  if (!top) return false
  top.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  return true
}

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
 * Android's back button closes an open pop-up first, as Material's modal sheets and dialogs do. Then
 * it goes up from a screen that sets a guard (a project, a session) and leaves the app from a
 * top-level one, whatever was opened before it, but only on a second press within `EXIT_WINDOW`, so
 * a stray press doesn't. Leaving minimizes rather than exits, as Android's own
 * back does from 12 on, so a reply keeps streaming and the screen stays.
 */
export function handleBackButton() {
  if (!isNative) return
  let armedAt = 0
  void App.addListener("backButton", () => {
    if (closeTopPopup() || backGuard?.()) {
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
    placeToasts()
    toast("Press back again to exit", {
      id: EXIT_TOASTER,
      duration: EXIT_WINDOW,
    })
  })
}
