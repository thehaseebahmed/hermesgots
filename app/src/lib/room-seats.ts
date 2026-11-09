/**
 * Whether a bot's Hermes profile is one the Host's roster holds (ADR 0128). The Host seats a room's
 * members per connection and names the profiles its connection may seat as `seatable_profiles`, so a
 * bot outside that roster would be refused at the create and is greyed in the picker first.
 *
 * No roster is no rule: a Host older than the field names none, and a connection that has not
 * answered yet says nothing, so every bot stays a seat. A roster that names nothing seats nobody,
 * and one that leaves this profile out is no seat either; a bot with no profile of its own has none
 * a roster could hold, and the create would name it with nothing.
 * Import-free, so `scripts/test-room-seats.mjs` drives it as a pure rule.
 */
export function seatsProfile(
  seatable: readonly string[] | null | undefined,
  profile: string | null | undefined,
): boolean {
  if (!seatable) return true
  return profile ? seatable.includes(profile) : false
}
