import { App } from "@capacitor/app"
import { isNative } from "@/lib/native"

/**
 * How long the app must have been out of view before coming back counts as waking. Hermes sends a
 * keepalive every 10s, so a shorter absence rarely costs a connection, and the stream's own idle
 * check still covers one that did.
 */
const AWAY_MS = 5_000

/** One event, one announcement: Android's `resume` and the page's `visibilitychange` both say it. */
const AGAIN_MS = 1_000

function notifier() {
  const listeners = new Set<() => void>()
  let last = 0
  return {
    on(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    announce() {
      const now = Date.now()
      if (now - last < AGAIN_MS) return
      last = now
      for (const listener of [...listeners]) listener()
    },
    /** A page that went away can come back inside the debounce; that is a return of its own. */
    reopen() {
      last = 0
    },
  }
}

const wakeTurn = notifier()
const returnToApp = notifier()

let hiddenAt: number | undefined

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt ??= Date.now()
    returnToApp.reopen()
    return
  }
  const away = hiddenAt === undefined ? 0 : Date.now() - hiddenAt
  hiddenAt = undefined
  returnToApp.announce()
  if (away >= AWAY_MS) wakeTurn.announce()
})
window.addEventListener("online", () => {
  returnToApp.announce()
  wakeTurn.announce()
})
if (isNative)
  void App.addListener("resume", () => {
    returnToApp.announce()
    wakeTurn.announce()
  })

/**
 * Calls `listener` when the app comes back after a while away (the screen was off, another app was
 * in front) or the network returns. A connection open from before can be dead without anything
 * having noticed, and a phone that slept may not count that time towards the timeout that would end
 * it. Returns the cleanup.
 */
export function onWake(listener: () => void) {
  return wakeTurn.on(listener)
}

/**
 * Calls `listener` on every return to the foreground: the page visible again, the network back, or
 * Android's `resume`, with no minimum time away (unlike `onWake`). Returns the cleanup.
 */
export function onReturn(listener: () => void) {
  return returnToApp.on(listener)
}
