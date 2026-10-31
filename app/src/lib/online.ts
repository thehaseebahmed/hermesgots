import { useSyncExternalStore } from "react"

/**
 * Whether this device has a network at all, as the browser says it: the one fact that tells a host
 * that cannot be reached from a device that cannot reach anything (`away.ts`, ADR 0071). A browser
 * that says nothing is taken to have one, so a host is named as the one that isn't answering.
 */
export const onlineNow = (): boolean =>
  typeof navigator === "undefined" || navigator.onLine !== false

const subscribe = (listener: () => void) => {
  window.addEventListener("online", listener)
  window.addEventListener("offline", listener)
  return () => {
    window.removeEventListener("online", listener)
    window.removeEventListener("offline", listener)
  }
}

/** The same answer, re-read when the device's own network comes or goes. */
export const useOnline = () => useSyncExternalStore(subscribe, onlineNow, () => true)
