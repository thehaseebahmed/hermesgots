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
