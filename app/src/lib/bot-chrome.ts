/**
 * What the sidebar's bot row previews. A bot with something to say shows it: the last thing said in
 * its newest chat, and only that chat's name where it holds no words yet — never another chat's
 * words under the bot they are not the newest of. A bot with nothing said has nothing to preview, so
 * the line says whether its host is checking in, which is the one fact about a quiet bot a reader can
 * act on (ADR 0090). A bot's Main is one of its chats like any other, so it is previewed by its place
 * in that order and never as a special case.
 */
export function previewLine({
  line,
  title,
  online,
}: {
  line?: string
  /** That chat's title, for one holding no words yet. */
  title?: string
  /** Whether the bot's host is checking in; `undefined` when this device can't tell. */
  online?: boolean
}): string | undefined {
  const said = line?.trim() ? line : title
  if (said) return said
  if (online === undefined) return undefined
  return online ? "Online" : "Offline"
}

/**
 * What the sidebar's bot row says under its name: the bot's state, and nothing else (ADR 0151).
 *
 * Something unread is said first, because it is the fact the reader can act on, and it counts the
 * bot's conversations rather than their messages — one row of its list, one. With nothing unread the
 * line says whether its host is checking in, and says nothing at all where this device cannot tell:
 * a bot with no host, turned off, or never heard from is not `Offline`, it is unknown, and the same
 * silence holds on Settings' own row (`presence`).
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
