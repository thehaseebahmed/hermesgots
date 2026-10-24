import type { ReactNode } from "react"

/**
 * The hold a chat pane keeps: the last frame it drew ready, so the next chat can be drawn whole
 * once its own answers are in. Kept beside the route rather than in the pane, because the shell
 * remounts the chat on every switch and the hold has to outlive it.
 */
export type HoldSlot = "main" | "thread" | "route"

export interface HeldFrame {
  /** The chat the frame is of; absent while the pane held a chat that never started. */
  id?: string
  frame: ReactNode
}

const held = new Map<HoldSlot, HeldFrame>()

/** Who hears a switch land. The pane's slot comes with it, since each pane fades its own. */
const landed = new Set<(slot: HoldSlot) => void>()

/** The frame a pane last drew ready, or nothing while it has none to hold. */
export const heldFrame = (slot: HoldSlot) => held.get(slot)

/** Listens for a pane's ready frame naming another chat: the moment a switch lands. */
export function onChatSwap(listener: (slot: HoldSlot) => void) {
  landed.add(listener)
  return () => {
    landed.delete(listener)
  }
}

/**
 * Records the frame a pane drew ready. One naming another chat than the frame before it is a
 * switch landing, which the shell fades — but a chat never started has no id to have left, so the
 * id its first send gives it is no swap: that chat was new a moment ago, not replaced.
 */
export function hold(slot: HoldSlot, id: string | undefined, frame: ReactNode) {
  const before = held.get(slot)
  held.set(slot, { id, frame })
  if (!before || before.id === id || before.id === undefined) return
  for (const listener of landed) listener(slot)
}

/** What each pane held is the session's own memory of it: forgotten as a fresh load forgets it. */
export function forgetHeldChats() {
  held.clear()
}
