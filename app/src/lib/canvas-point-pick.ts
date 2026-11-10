/**
 * The element a phone's reader picked on the page, on its way back to the chat that asked for it.
 *
 * The preview and the edit screen are two addresses and never two screens at once: the edit screen
 * sends the reader to the page, the page unmounts the chat, and the chat mounts again when the page
 * answers. So the answer cannot be a prop, a context or a returned promise — it has to outlive the
 * screen that heard it, which is what this module holds it for.
 *
 * It is a one-trip hand-over, and one trip only: `takePoint` deletes what it answers, so a chat that
 * comes back a second time — a screen reopened, a link followed again — cannot resurrect a point the
 * reader already sent or took off. A point belongs to the canvas it was picked on, so the canvas's id
 * is the key, and one canvas is being pointed at by one reader at a time.
 *
 * Import-free of React on purpose: it holds no state a render reads, and nothing about it is a hook.
 */
import type { CanvasPoint } from "@/lib/point-marker"

const kept = new Map<string, CanvasPoint>()

/** Keeps the element the page answered for `id`, until the chat that asked for it takes it. */
export function keepPoint(id: string, point: CanvasPoint) {
  kept.set(id, point)
}

/** The element the page answered for `id`, if one is waiting — handed over once, and then gone. */
export function takePoint(id: string): CanvasPoint | undefined {
  const point = kept.get(id)
  kept.delete(id)
  return point
}
