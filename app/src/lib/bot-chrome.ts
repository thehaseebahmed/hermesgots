/**
 * What the sidebar's bot row says under its name: the bot's state, and nothing else (ADR 0151).
 *
 * Something unread is said first, because it is the fact a reader can act on, and it counts the
 * bot's conversations rather than their messages — one row of its list, one. With nothing unread the
 * line says whether its host is checking in, which is the one thing about a quiet bot a reader can
 * act on, and it says nothing at all where this device cannot tell: a bot with no host, turned off, or
 * never heard from is not `Offline`, it is unknown, and the same silence holds on Settings' own row
 * (`presence`).
 */
export function stateLine({
  unread,
  online,
}: {
  /** How many of the bot's conversations this device holds past its read mark. */
  unread: number
  /** Whether the bot's host is checking in; `undefined` when this device can't tell. */
  online?: boolean
}): string | undefined {
  if (unread > 0) return `${unread} unread`
  if (online === undefined) return undefined
  return online ? "Online" : "Offline"
}
