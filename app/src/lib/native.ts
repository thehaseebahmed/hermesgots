import { App } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"

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

/** A screen's say over the back button: return true when it handled the press itself. */
export function setBackGuard(guard: (() => boolean) | undefined) {
  backGuard = guard
}

/** Android's back button walks the router history, then leaves the app. */
export function handleBackButton() {
  if (!isNative) return
  void App.addListener("backButton", ({ canGoBack }) => {
    if (backGuard?.()) return
    if (canGoBack) history.back()
    else void App.exitApp()
  })
}
