import type { Fallback } from "@/lib/hermes"

/** How many fallback models a bot takes: a main model, then these in order. */
export const MAX_FALLBACKS = 2

/**
 * `list` with `next` written at `index` — the slot at that place replaced, or dropped when `next`
 * is undefined. An `index` at the end appends while there's room; anything outside the list, or
 * past the cap, leaves it as it was.
 */
export function withFallback(
  list: Fallback[],
  index: number,
  next: Fallback | undefined,
): Fallback[] {
  if (index < 0 || index > list.length || list.length > MAX_FALLBACKS) return list
  if (next === undefined) return index === list.length ? list : list.filter((_, at) => at !== index)
  if (index === list.length) return list.length < MAX_FALLBACKS ? [...list, next] : list
  return list.map((entry, at) => (at === index ? next : entry))
}

