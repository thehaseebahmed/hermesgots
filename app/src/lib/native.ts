import { App } from "@capacitor/app"
import { Browser } from "@capacitor/browser"
import { Capacitor, registerPlugin } from "@capacitor/core"
import { toast } from "sonner"

import { placeToasts } from "@/lib/toast"

/** True inside the Android app, where the page is served from `https://localhost`. */
export const isNative = Capacitor.isNativePlatform()

/** Sends the native Android app to the background while leaving its current screen intact. */
export async function minimizeAndroidApp() {
  if (!isNative || Capacitor.getPlatform() !== "android") return
  await App.minimizeApp()
}

interface OpenImagePlugin {
  open(options: { dataBase64: string; name: string; type?: string }): Promise<void>
}

const OpenImage = registerPlugin<OpenImagePlugin>("OpenImage")

/** The bytes behind a blob URL, as the base64 string the Android bridge carries, and their type. */
async function blobBytes(url: string) {
  const blob = await fetch(url).then((response) => response.blob())
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "")
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  return { dataBase64, type: blob.type }
}

/**
 * Opens media in the platform's own viewer or player: the Android app is handed the bytes and a VIEW
 * intent for the file's type, and a browser opens the file in a new tab, where it plays the way that
 * browser plays anything. Nothing is embedded in the thread.
 */
export async function openMediaViewer(
  url: string,
  { type, name }: { type: string; name?: string },
) {
  if (isNative && url.startsWith("blob:")) {
    try {
      const bytes = await blobBytes(url)
      const opened = bytes.type || type
      if (bytes.dataBase64) {
        await OpenImage.open({
          dataBase64: bytes.dataBase64,
          name: name ?? `media.${opened.split("/")[1] || "bin"}`,
          type: opened,
        })
        return
      }
    } catch {
      // The tab below still opens it.
    }
  }
  if (isNative) {
    // A file that isn't ours to hand over; the platform opens the URL itself.
    void Browser.open({ url })
    return
  }
  window.open(url, "_blank")
}

/** A URL opened outside the app: the platform's browser in the Android app, a new tab on the web. */
export function openExternal(url: string) {
  if (isNative) {
    void Browser.open({ url })
    return
  }
  window.open(url, "_blank", "noopener")
}

/** The Netlify deploy the app signs in and syncs through, baked in by `pnpm build:android`. */
export const SITE_URL = (import.meta.env.VITE_SITE_URL ?? "").replace(/\/+$/, "")

const NATIVE_AUTH = "memento-native-auth"

/**
 * Identity returns to the page that started sign-in, `/auth/native.html`. If it lands on the site
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
