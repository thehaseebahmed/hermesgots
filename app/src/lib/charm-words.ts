/** What the charm's settings say about it: plain words, kept apart so they are tested alone. */
export interface CharmSeen {
  name: string
  syncedAt?: number
}

export const CHARM = "Charm"

/** The row's line under the title: whether one is paired, and when it last took the bots. */
export function charmSubtitle(charm: CharmSeen | null, now = Date.now()) {
  if (!charm) return "Not paired"
  if (!charm.syncedAt) return `${charm.name} · Never synced`
  return `${charm.name} · Synced ${since(charm.syncedAt, now)}`
}

/** Under the paired charm's own name: just when it last took the bots. */
export function charmSynced(charm: CharmSeen, now = Date.now()) {
  return charm.syncedAt ? `Synced ${since(charm.syncedAt, now)}` : "Never synced"
}

function since(at: number, now: number) {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(at).toLocaleDateString()
}

/**
 * Under the pet mode switch. The row beneath names the pet, so this line says what the switch does
 * rather than repeating the name it sits above.
 */
export function petSubtitle(
  choice: { enabled: boolean; botId?: string } | undefined,
  petName?: string,
) {
  if (!choice?.enabled) return "Your bots only, as they are now"
  return petName ? "Lives on the charm" : "Choose the bot that lives there"
}
