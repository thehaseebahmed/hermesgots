export type LocalCommand = "new" | "thread" | "settings"
/** The command that starts a chat on purpose: `/thread` where threads are a thing, `/new` where not. */
export type StartCommand = Extract<LocalCommand, "new" | "thread">
/** Commands that carry the message after them, while a reply runs. */
export type SendMode = "steer" | "queue"

export type SlashItem =
  | { kind: "command"; name: LocalCommand | SendMode; description: string }
  | { kind: "skill"; name: string; description?: string | null; category?: string | null }

export const startCommand = (threads: boolean): StartCommand => (threads ? "thread" : "new")

/**
 * Whether a command takes the rest of the message as its own: `/thread` does, since that text opens
 * the thread it starts.
 */
export const carriesMessage = (name: string) => name === "thread"

export function localCommands(threads: boolean): SlashItem[] {
  return [
    {
      kind: "command",
      name: startCommand(threads),
      description: threads ? "Start a thread" : "Start a new chat",
    },
    { kind: "command", name: "settings", description: "Open settings" },
  ]
}

export const LOCAL_COMMANDS: SlashItem[] = localCommands(false)

/** Offered only while a reply runs, when there is something to steer or wait for. */
export const SEND_COMMANDS: SlashItem[] = [
  { kind: "command", name: "steer", description: "Send to the running reply now" },
  { kind: "command", name: "queue", description: "Send after the reply" },
]

export const isSendMode = (name: string): name is SendMode => name === "steer" || name === "queue"

/** `/steer text` or `/queue text`: how to send the text, and the text. */
export function sendMode(text: string): { mode: SendMode; text: string } | null {
  const match = /^\/(steer|queue)(?:\s+([\s\S]*))?$/.exec(text.trimStart())
  return match ? { mode: match[1] as SendMode, text: (match[2] ?? "").trim() } : null
}

export function localCommand(
  text: string,
  threads = false,
): { command: LocalCommand; text: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const [, name, rest = ""] = match
  const command = localCommands(threads).find((item) => item.name === name)
  if (!command) return null
  if (rest.trim() && !carriesMessage(name)) return null
  return { command: name as LocalCommand, text: rest.trim() }
}

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char)

/** The `/`-token a caret sits in: `/gr` in `fix /gr|ill the tests`. */
export interface SlashToken {
  /** Where the token's `/` is. */
  start: number
  /** One past the token's last character: the whitespace after it, or the text's end. */
  end: number
  /** What has been typed after the `/`, up to the caret. */
  query: string
  /** Whether the token is the whole message: nothing but whitespace around it. */
  alone: boolean
}

/**
 * The token the caret is in, or null when it isn't sitting in one. A token starts at the `/` that
 * begins a word — the message's first character, or the one after a space or a newline — so the
 * slash in `and/or`, `https://…` or `/usr/local/bin` never opens the menu.
 */
export function slashToken(text: string, caret: number): SlashToken | null {
  let start = caret
  while (start > 0 && !isSpace(text[start - 1])) start--
  if (text[start] !== "/") return null
  let end = caret
  while (end < text.length && !isSpace(text[end])) end++
  const query = text.slice(start + 1, caret)
  // A second slash makes this a path or a URL the user is writing, not a command: no skill has one.
  if (query.includes("/")) return null
  const alone = `${text.slice(0, start)}${text.slice(end)}`.trim() === ""
  return { start, end, query, alone }
}

/** The commands the token matches, then the skills it matches, best first. */
export function rankSlashItems(items: SlashItem[], token: SlashToken): SlashItem[] {
  const query = token.query.toLowerCase()
  const commands = items.filter(
    (item) =>
      item.kind === "command" &&
      (!query || item.name.toLowerCase().startsWith(query)) &&
      (token.alone || (carriesMessage(item.name) && token.start === 0)),
  )
  const skills = items.filter((item): item is SkillItem => item.kind === "skill")
  if (!query) return [...commands, ...skills]
  const ranked = skills
    .map((item, order) => ({ item, order, ...matchOf(item, query) }))
    .filter((row) => row.tier > 0)
    .sort((a, b) => a.tier - b.tier || a.score - b.score || a.order - b.order)
  return [...commands, ...ranked.map((row) => row.item)]
}

type SkillItem = Extract<SlashItem, { kind: "skill" }>

function matchOf(skill: SkillItem, query: string): { tier: number; score: number } {
  const name = skill.name.toLowerCase()
  if (name === query) return { tier: 1, score: 0 }
  if (name.startsWith(query)) return { tier: 2, score: 0 }
  if (name.includes(query)) return { tier: 3, score: 0 }
  const spread = nameSpread(name, query)
  if (spread !== null) return { tier: 4, score: spread }
  if ((skill.category ?? "").toLowerCase().includes(query)) return { tier: 5, score: 0 }
  if ((skill.description ?? "").toLowerCase().includes(query)) return { tier: 6, score: 0 }
  return { tier: 0, score: 0 }
}

/**
 * How far apart a query's characters land in a name — 0 when they sit together, more for every
 * character skipped between them — or null when they are not all there in order. That is how `gril`
 * finds `grill`.
 */
export function nameSpread(name: string, query: string): number | null {
  let at = 0
  let first = -1
  let last = -1
  for (const char of query) {
    const found = name.indexOf(char, at)
    if (found < 0) return null
    if (first < 0) first = found
    last = found
    at = found + 1
  }
  return last - first + 1 - query.length
}

/**
 * A picked skill lands where the cursor is: `/name` replaces what was typed of the token up to
 * the cursor, and everything after the cursor — including a word the token was typed into — stays
 * where it was.
 */
export function pickItem(text: string, token: SlashToken, name: string) {
  return insert(text, token.start, token.start + 1 + token.query.length, name)
}

/**
 * A picked send-mode replaces the whole token: it is only ever offered when nothing but
 * whitespace surrounds the token, so nothing of the user's sits inside it to lose, and it reads
 * as one command only from the front of the message.
 */
export function pickSendMode(text: string, token: SlashToken, name: string) {
  return insert(text, token.start, token.end, name)
}

/** The end of the message has no character there, so it needs the space to keep typing with. */
const needsSpace = (text: string, at: number) => !/\s/.test(text[at] ?? "")

function insert(text: string, from: number, to: number, name: string) {
  const hadSpace = !needsSpace(text, to)
  const picked = `/${name}${hadSpace ? "" : " "}`
  const next = text.slice(0, from) + picked + text.slice(to)
  return { text: next, caret: from + picked.length + (hadSpace ? 1 : 0) }
}

export function optionId(listId: string, index: number) {
  return `${listId}-${index}`
}
