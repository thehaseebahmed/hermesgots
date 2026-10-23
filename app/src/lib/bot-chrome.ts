type MainMarked = { chat: { main?: boolean } }

/** How many threads a bot has, with Main left out. */
export function threadCount(threads: readonly MainMarked[] | undefined): number {
  return threads?.filter((thread) => !thread.chat.main).length ?? 0
}

/**
 * Main's title: the bot's own name, so the record's stored "Main" never shows. A rename in Bot
 * settings lands here at once, since the profile is what the header reads; a bot with no name
 * yet keeps whatever the record holds.
 */
export function mainTitle(
  profileName: string | undefined,
  storedTitle: string | undefined,
): string {
  return profileName || storedTitle || ""
}

/** The line under Main's title: how many threads the bot has. */
export function threadsLine(count: number): string {
  return count > 0 ? `${count} ${count === 1 ? "thread" : "threads"}` : "No threads"
}

/**
 * What the sidebar's bot row previews. A bot that has been opened has a Main, and the row shows
 * what Main last said — never a thread's title, which is somewhere else than the row leads. A bot
 * never opened has no Main to read, so its newest thread's title stands in.
 */
export function previewLine({
  main,
  line,
  latest,
}: {
  /** Whether this device has the bot's Main thread. */
  main: boolean
  /** Main's latest message, cut to a line. */
  line?: string
  /** Its newest thread's title, for a bot never opened. */
  latest?: string
}): string {
  return (main ? line : latest) ?? "No threads yet"
}
