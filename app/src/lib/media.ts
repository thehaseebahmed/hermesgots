import { useSyncExternalStore } from "react"

function media(query: string) {
  const list = window.matchMedia(query)
  const subscribe = (onChange: () => void) => {
    list.addEventListener("change", onChange)
    return () => list.removeEventListener("change", onChange)
  }
  return () => useSyncExternalStore(subscribe, () => list.matches)
}

/** Whether the screen is tablet-sized (Tailwind's `md`) or wider. */
export const useWide = media("(min-width: 768px)")

/** Whether the screen is wider than a tablet (Tailwind's `lg`), room for a third pane. */
export const useLarge = media("(min-width: 1024px)")

/** Whether the screen is a laptop's or wider (Tailwind's `xl`), room for a session beside a list. */
export const useXLarge = media("(min-width: 1280px)")

/** Whether the main pointer can hover (a mouse or trackpad), so a hover can show more. */
export const useHover = media("(hover: hover) and (pointer: fine)")
