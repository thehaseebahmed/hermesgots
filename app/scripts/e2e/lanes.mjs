// The rule the e2e CLI runs a parallel sweep by: one deterministic slice of the run's flow names per
// lane, round-robin over the registry order, so N lanes cover every flow exactly once. A lane then
// runs its slice against its own mock ports. Pure on purpose — `scripts/test-e2e-lanes.mjs` drives
// it, since importing the CLI itself would run it.

export const MAX_LANES = 8

/** The names lane `lane` of `lanes` runs. Throws on a lane count or index that can't exist. */
export function laneOf(names, lanes, lane) {
  if (!Number.isInteger(lanes) || lanes < 1 || lanes > MAX_LANES)
    throw new Error(`lanes is 1-${MAX_LANES}, not ${lanes}`)
  if (!Number.isInteger(lane) || lane < 0 || lane >= lanes)
    throw new Error(`lane is 0-${lanes - 1}, not ${lane}`)
  return names.filter((_, index) => index % lanes === lane)
}
