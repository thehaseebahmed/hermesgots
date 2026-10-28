import { useSyncExternalStore } from "react"

const queries = new Map<string, MediaQueryList>()

/**
 * One query's list, made once and kept: a snapshot is read on every commit, so a list built per read
 * is an allocation per read, and each row that animates asks from its own component.
 */
function watch(query: string) {
  const held = queries.get(query)
  if (held) return held
  const made = window.matchMedia(query)
  queries.set(query, made)
  return made
}

/** A screen's answer to a media query, redrawn when the reader changes it. */
function media(query: string) {
  const subscribe = (onChange: () => void) => {
    const list = watch(query)
    list.addEventListener("change", onChange)
    return () => list.removeEventListener("change", onChange)
  }
  return () => useSyncExternalStore(subscribe, () => watch(query).matches)
}

/** Whether the screen is tablet-sized (Tailwind's `md`) or wider. */
export const useWide = media("(min-width: 768px)")

/** Whether the screen is wider than a tablet (Tailwind's `lg`), room for a third pane. */
export const useLarge = media("(min-width: 1024px)")

/** Whether the screen is a laptop's or wider (Tailwind's `xl`), room for a session beside a list. */
export const useXLarge = media("(min-width: 1280px)")

/** Whether the main pointer can hover (a mouse or trackpad), so a hover can show more. */
export const useHover = media("(hover: hover) and (pointer: fine)")

/** The query behind the animations the app carries out itself, rather than in CSS. */
const MOTION = "(prefers-reduced-motion: reduce)"

/**
 * Whether the reader asked for no motion, for work outside a component — a scroll's behaviour, a
 * roll's pace. What animates in stylesheet terms asks the query in CSS instead.
 */
export const prefersReducedMotion = () => watch(MOTION).matches
