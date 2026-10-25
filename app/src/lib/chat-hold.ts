import type { ReactNode } from "react"

export type HoldSlot = "main" | "thread" | "route"

export interface HeldFrame {
  /** The chat the frame is of; absent while the pane held a chat that never started. */
  id?: string
  frame: ReactNode
}

const held = new Map<HoldSlot, HeldFrame>()

const landed = new Set<(slot: HoldSlot) => void>()

export const heldFrame = (slot: HoldSlot) => held.get(slot)

export function onChatSwap(listener: (slot: HoldSlot) => void) {
  landed.add(listener)
  return () => {
    landed.delete(listener)
  }
}

export function hold(slot: HoldSlot, id: string | undefined, frame: ReactNode) {
  const before = held.get(slot)
  held.set(slot, { id, frame })
  if (!before || before.id === id || before.id === undefined) return
  for (const listener of landed) listener(slot)
}

export function forgetHeldChats() {
  held.clear()
}
