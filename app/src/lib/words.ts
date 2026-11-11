/**
 * Words more than one screen writes, in one place. No imports on purpose: the unit tier runs the
 * modules that read these with no `@/…` alias to resolve, so a string both tiers say lives here.
 */

/**
 * What a row says where there is nothing to say yet: a chat nothing has been said in, and a room with
 * no line of its own. The bot's list and the sidebar's preview draw the same words.
 */
export const NO_MESSAGES = "No messages yet"

export const NO_ROOM_MESSAGES = "Nothing said in this room yet"

/** The mark a message that did not go wears, beside its bubble and on the row the device keeps. */
export const NOT_SENT = "Not sent"

export const FAILED = "Failed"

/** A call nobody ran: never a failure (ADR 0098). */
export const REFUSED = "Refused"

/**
 * How much of the message that opened a chat its record keeps: matched to the host's own cut
 * (`MAX_TEXT` in `plugin/new_chats.py`), so a value reads the same whichever side wrote it.
 */
export const OPENER_CHARS = 2000

/**
 * The first line a message can give a row: its first block's words, with the markdown it was written
 * in taken out. A row is a line of plain text, so a `**`, a backtick or a link's address in it is the
 * markup showing through rather than what the bot said.
 *
 * A block is what a blank line separates, so a paragraph's own soft wraps stay one line — what the
 * reader wrote as one sentence is not cut at the newline their editor put there. A fence gives the
 * code under it rather than the language it named, and a table gives its header row rather than its
 * delimiter.
 */
export function plainLine(text: string): string | undefined {
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((one) => one.trim())
      .filter(Boolean)
    if (!lines.length) continue
    if (/^(```|~~~)/.test(lines[0])) {
      const body = lines.slice(1).filter((one) => !/^(```|~~~)/.test(one))
      const words = oneLine(body.map(inline).join(" "))
      if (words) return words
      continue
    }
    // A table's own words are its header; the delimiter under it says nothing.
    const rows = lines[0].startsWith("|") ? [lines[0]] : lines
    const words = oneLine(
      rows
        .filter((one) => !/^([-*_]\s*){3,}$/.test(one) && !/^\|?\s*:?-{2,}/.test(one))
        .map(inline)
        .join(" "),
    )
    if (words) return words
  }
  return undefined
}

/** One line of markdown, as its words: a block's own mark, then the inline shapes. */
function inline(line: string): string {
  return (
    line
      .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
      // An image's alt before a link's text, so the alt survives its own address.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, "$1")
      .replace(/\|/g, " ")
  )
}

export function oneLine(text: string, max = Number.POSITIVE_INFINITY): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return undefined
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
