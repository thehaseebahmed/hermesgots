export type HoldSlot = "main" | "thread" | "route"

const held = new Map<HoldSlot, string | undefined>()

const landed = new Set<(slot: HoldSlot) => void>()

export function onChatSwap(listener: (slot: HoldSlot) => void) {
  landed.add(listener)
  return () => {
    landed.delete(listener)
  }
}

/**
 * Notes the chat a pane last drew ready. Only the id is kept: a pane that changes chat draws a
 * neutral frame until the new one has answered, never the one it left, and the listeners are told
 * when the new chat lands so the shell can fade it in.
 */
export function hold(slot: HoldSlot, id: string | undefined) {
  const had = held.has(slot)
  const before = held.get(slot)
  held.set(slot, id)
  if (!had || before === id || before === undefined) return
  for (const listener of landed) listener(slot)
}

export function forgetHeldChats() {
  held.clear()
}
