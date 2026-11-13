/**
 * Every icon a canvas's mark may draw (issue #1065): lucide's own set, by the name the app stores —
 * the icon's words, hyphenated, as `canvas-marks.ts` reads them back.
 *
 * One module, loaded once, and only when something draws or lists a mark: lucide is the app's icon
 * vocabulary already, so a picker of its own set needs no second one. The set is asked for as a
 * whole because a picker has to list every name before a search can narrow them; a chunk per icon
 * would leave a service worker precaching two thousand of them.
 */
import type { LucideIcon } from "lucide-react"
import { useEffect, useSyncExternalStore } from "react"

import { markWords } from "@/lib/canvas-marks"
import { createSignal } from "@/lib/store"

/** One mark a canvas can wear: the icon, and its name in words for the grid and the search. */
export interface MarkIcon {
  Icon: LucideIcon
  words: string
}

/** The icons by the name the record stores, which is what a canvas's mark names. */
export type MarkIcons = ReadonlyMap<string, MarkIcon>

/**
 * `AlarmClockMinus` as `alarm-clock-minus`: lucide names an icon as a component, and a record keeps
 * the same name as the words it reads as. Nothing here is a lucide alias, so one name is one icon.
 */
function nameOf(component: string): string {
  return component
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-zA-Z])([0-9])/g, "$1-$2")
    .replace(/([0-9])([a-zA-Z])/g, "$1-$2")
    .toLowerCase()
}

let set: MarkIcons | undefined
let loading: Promise<MarkIcons> | undefined
const landed = createSignal()

async function load(): Promise<MarkIcons> {
  const { icons } = await import("lucide-react")
  const marks = new Map<string, MarkIcon>()
  for (const [component, Icon] of Object.entries(icons as unknown as Record<string, LucideIcon>)) {
    const name = nameOf(component)
    // Two components spelling one name would make a stored mark ambiguous, and the first is the
    // only one a name can mean: the set is keyed once.
    if (!marks.has(name)) marks.set(name, { Icon, words: markWords(name) })
  }
  set = marks
  landed.notify()
  return marks
}

/** Every icon lucide carries, fetched once however many rows and pickers ask for it. */
export function markIcons(): Promise<MarkIcons> {
  loading ??= load()
  return loading
}

/**
 * The set as a row draws it: undefined until it lands, which is when every row that wants a mark
 * redraws. A row with a mark draws the frame in the meantime, and a row without one never asks.
 */
export function useMarkIcons(): MarkIcons | undefined {
  const held = useSyncExternalStore(landed.subscribe, () => set)
  useEffect(() => {
    if (!held) void markIcons()
  }, [held])
  return held
}
