/**
 * One charm link at a time: a phone reaches its charm over one radio connection, so a second
 * caller waits for the one before it to close rather than opening its own and dropping the first.
 */
let holding: Promise<void> = Promise.resolve()

export function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const turn = holding.then(run)
  // The queue moves on whatever the turn did: one caller's failure is not the next one's.
  holding = turn.then(
    () => undefined,
    () => undefined,
  )
  return turn
}
