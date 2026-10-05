import { useSyncExternalStore } from "react"

// Tablet width and up (Tailwind's `md`).
const wide = window.matchMedia("(min-width: 768px)")
const subscribe = (onChange: () => void) => {
  wide.addEventListener("change", onChange)
  return () => wide.removeEventListener("change", onChange)
}

/** Whether the screen is tablet-sized or wider. */
export const useWide = () => useSyncExternalStore(subscribe, () => wide.matches)
