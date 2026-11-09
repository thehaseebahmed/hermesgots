/**
 * Whether a bot's Hermes profile is one the Host's roster holds, and which pick makes the room
 * (ADR 0128, ADR 0129). The Host seats a room's members per connection and names the profiles its
 * connection may seat as `seatable_profiles`, so a room is made on the earliest pick whose connection
 * seats every pick; where none does, the create adds the missing profiles to the making profile's own
 * roster, so nothing is refused for a config the app could have written.
 *
 * No roster is no rule: a Host older than the field names none, and a connection that has not
 * answered yet says nothing, so every bot stays a seat. A roster that names nothing seats nobody, and
 * one that leaves this profile out is no seat either; a bot with no profile of its own has none a
 * roster could hold, and the create would name it with nothing.
 * Import-free, so `scripts/test-room-seats.mjs` drives it as a pure rule.
 */
export function seatsProfile(
  seatable: readonly string[] | null | undefined,
  profile: string | null | undefined,
): boolean {
  if (!seatable) return true
  return profile ? seatable.includes(profile) : false
}

/** One picked bot as the maker rule sees it: its profile, and the roster its own connection gave. */
export type Pick = {
  profile: string | null | undefined
  seatable: readonly string[] | null | undefined
}

/**
 * Which pick makes the room, as an index into the picks: the earliest one whose connection seats every
 * pick, because pick order already names the room and orders its members (ADR 0125). Where none seats
 * them — or where a connection still owes its answer — the first pick makes it, and the create seats
 * what that connection cannot (ADR 0129).
 */
export function makerOf(picks: readonly Pick[]): number {
  if (!picks.length) return -1
  const holds = (one: Pick) => picks.every((other) => seatsProfile(one.seatable, other.profile))
  // A roster that named every pick is the one to trust. A connection still owing its answer would
  // also "seat" them all — nothing is held out before it lands — so it is only believed where no
  // named roster does, and the first pick is the answer where neither does.
  const named = picks.findIndex((one) => one.seatable != null && holds(one))
  if (named !== -1) return named
  const owed = picks.findIndex((one) => one.seatable == null && holds(one))
  return owed !== -1 ? owed : 0
}

/**
 * Whether any picked connection seats this profile. A profile none of them seats is one the create
 * will have to add to the making profile's roster, which is what the picker's row says before it is
 * pressed (ADR 0129). Where no roster is named, or one is still owed, nothing is marked.
 */
export function seatedByAny(picks: readonly Pick[], profile: string | null | undefined): boolean {
  return picks.some((one) => seatsProfile(one.seatable, profile))
}

/**
 * What a room says about its own making: the profiles a create had to add to the making profile's
 * roster, or nothing where it added none (ADR 0129). It names the bots, never the Host's config.
 */
export function seatedLine(seated: readonly string[] | undefined): string | undefined {
  if (!seated?.length) return undefined
  const names =
    seated.length === 1
      ? seated[0]
      : `${seated.slice(0, -1).join(", ")} and ${seated[seated.length - 1]}`
  return `The Host was configured to seat ${names}.`
}
