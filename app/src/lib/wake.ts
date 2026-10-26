import { App } from "@capacitor/app"
import { isNative } from "@/lib/native"

/**
 * How long the app must have been out of view before coming back counts as waking. Hermes sends a
 * keepalive every 10s, so a shorter absence rarely costs a connection, and the stream's own idle
 * check still covers one that did.
 */
const AWAY_MS = 5_000

const listeners = new Set<() => void>()
const returnListeners = new Set<() => void>()
let hiddenAt: number | undefined
let lastWake = 0
let lastReturn = 0

function wake() {
  // Android's resume and the page's visibilitychange both say so; one wake is enough.
  if (Date.now() - lastWake < 1000) return
  lastWake = Date.now()
  for (const listener of [...listeners]) listener()
}

function returned() {
  // The same double announcement as a wake; the trace times one return, not two.
  if (Date.now() - lastReturn < 1000) return
  lastReturn = Date.now()
  for (const listener of [...returnListeners]) listener()
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt ??= Date.now()
    return
  }
  const away = hiddenAt === undefined ? 0 : Date.now() - hiddenAt
  hiddenAt = undefined
  returned()
  if (away >= AWAY_MS) wake()
})
window.addEventListener("online", () => {
  returned()
  wake()
})
if (isNative)
  void App.addListener("resume", () => {
    returned()
    wake()
  })

/**
 * Calls `listener` when the app comes back after a while away (the screen was off, another app was
 * in front) or the network returns. A connection open from before can be dead without anything
 * having noticed, and a phone that slept may not count that time towards the timeout that would end
 * it. Returns the cleanup.
 */
export function onWake(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Calls `listener` on every return to the foreground: the page visible again, the network back, or
 * Android's `resume`, with no minimum time away (unlike `onWake`). The resume trace times what
 * each return runs from here. Returns the cleanup.
 */
export function onReturn(listener: () => void) {
  returnListeners.add(listener)
  return () => {
    returnListeners.delete(listener)
  }
}
