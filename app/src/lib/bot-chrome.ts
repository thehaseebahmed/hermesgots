type MainMarked = { chat: { main?: boolean } }

/** How many threads a bot has, with Main left out. */
export function threadCount(threads: readonly MainMarked[] | undefined): number {
  return threads?.filter((thread) => !thread.chat.main).length ?? 0
}

/** The line under Main's title: how many threads the bot has. */
export function threadsLine(count: number): string {
  return count > 0 ? `${count} ${count === 1 ? "thread" : "threads"}` : "No threads"
}

/**
 * What the sidebar's bot row previews. A bot with something to say shows it: what Main last said
 * where this device has Main's thread, else what the newest thread last said, and only its name
 * where that thread holds no words yet — never another thread's words under the chat the row leads
 * to. A bot with neither a message nor a thread has nothing to preview, so the line says whether its
 * host is checking in, which is the one fact about a quiet bot a reader can act on (ADR 0090).
 */
export function previewLine({
  main,
  line,
  thread,
  latest,
  online,
}: {
  /** Whether this device has the bot's Main thread. */
  main: boolean
  /** Main's latest message, cut to a line. */
  line?: string
  /** The newest thread's latest message, cut to a line. */
  thread?: string
  /** That thread's title, for one holding no words yet. */
  latest?: string
  /** Whether the bot's host is checking in; `undefined` when this device can't tell. */
  online?: boolean
}): string | undefined {
  const said = (main ? line : undefined) ?? thread ?? latest
  if (said) return said
  if (online === undefined) return undefined
  return online ? "Online" : "Offline"
}
