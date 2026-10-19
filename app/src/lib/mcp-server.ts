/**
 * What an MCP server's row says about how it is doing, and what its Config tab is built from: the
 * rules the screen draws from, kept import-free (but for types) so `scripts/test-mcp-server.mjs` can
 * drive them without a browser.
 */
import type { McpServer, McpServerDetail, McpServerEdit } from "@/lib/hermes"

/**
 * A row's subtitle: how the server is doing in a line, and whether that line is the way to fix it.
 *
 * Server access comes first, because a server waiting on it isn't broken — it is unfinished, and
 * the line is the tap that finishes it (`authenticate`, only where the Host can start the flow). The
 * Host's own failure text comes next, whatever word the server carries, since that is the thing to
 * read — and where the Host says that server's access can be started, that line is the tap too: a
 * grant that failed leaves the failure on screen and the way back into the flow on the same line.
 * Then the state itself, and only then health: a count of tools where Hermes reports one, and the
 * plain word where it doesn't — a server it has no runtime state for reports `0`, which is not a
 * count, so nothing is printed rather than "0 tools" (ADR 0014).
 */
export function healthLine(
  server: McpServer,
  { canAuthenticate = false }: { canAuthenticate?: boolean } = {},
): { text: string; authenticate: boolean; failed: boolean } {
  if (server.state === "needs_access") {
    return {
      text: canAuthenticate
        ? "Click here to authenticate"
        : "Needs Authentication",
      authenticate: canAuthenticate,
      failed: false,
    }
  }
  if (server.reason) return { text: server.reason, authenticate: canAuthenticate, failed: true }
  if (server.state === "failed")
    return { text: "Failed", authenticate: canAuthenticate, failed: true }
  if (server.state === "off") return { text: "Off", authenticate: false, failed: false }
  if (server.state === "connecting")
    return { text: "Connecting…", authenticate: false, failed: false }
  if (server.tools === undefined) return { text: "Healthy", authenticate: false, failed: false }
  return {
    text: `Healthy: ${server.tools} ${server.tools === 1 ? "tool" : "tools"}`,
    authenticate: false,
    failed: false,
  }
}

/**
 * The Config tab's fields, as one draft: the transport the form is editing and what it asks for.
 *
 * Arguments are one line here, the way the form shows them, and are split back into argv by
 * `splitArgs` on the way out — a shell would give the server one argument per argv entry, and a path
 * with a space has to survive the round trip.
 */
export interface ConfigDraft {
  transport: "http" | "stdio"
  url: string
  command: string
  args: string
  auth: "none" | "header" | "oauth"
  /** A token typed into a header's field. Empty means the stored one stands. */
  token: string
}

/** One environment value the form is editing: the name the Host knows, and what was typed over. */
export interface ValueDraft {
  name: string
  value: string
}

/** The draft a server's Config tab opens with. */
export function configDraft(detail: McpServerDetail): ConfigDraft {
  return {
    transport: detail.transport,
    url: detail.url,
    command: detail.command,
    args: joinArgs(detail.args),
    auth: detail.auth,
    token: "",
  }
}

/**
 * Arguments as one line: an argument with a space or a quote in it is wrapped, and every quote or
 * backslash inside one is escaped, so `splitArgs(joinArgs(argv))` gives the argv back.
 */
export function joinArgs(args: string[]): string {
  return args
    .map((argument) =>
      argument && !/[\s"'\\]/.test(argument) ? argument : `"${argument.replace(/[\\"]/g, "\\$&")}"`,
    )
    .join(" ")
}

/**
 * One line of arguments as argv, read the way a shell reads it: whitespace separates them, single
 * and double quotes hold a run of characters together, and a backslash takes the next character
 * literally. An unclosed quote keeps what was typed rather than throwing — the form is not the place
 * to lose someone's work — and nothing at all is no arguments.
 */
export function splitArgs(text: string): string[] {
  const args: string[] = []
  let current = ""
  let quoted: '"' | "'" | null = null
  let started = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === quoted) {
        quoted = null
      } else if (character === "\\" && quoted === '"' && index + 1 < text.length) {
        index += 1
        current += text[index]
      } else {
        current += character
      }
      continue
    }
    if (character === '"' || character === "'") {
      quoted = character
      started = true
      continue
    }
    if (character === "\\" && index + 1 < text.length) {
      index += 1
      current += text[index]
      started = true
      continue
    }
    if (/\s/.test(character)) {
      if (started) args.push(current)
      current = ""
      started = false
      continue
    }
    current += character
    started = true
  }
  if (started) args.push(current)
  return args
}

/**
 * The values a form sends: every row with something typed in it, by the name it lands under. A row
 * left empty asks for nothing, which is how the Host reads it — the value the bot already holds
 * stands as it is, because its content never reached the screen to be shown again.
 */
export function typedValues(rows: ValueDraft[]): Record<string, string> {
  const typed: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (!name || !row.value.trim()) continue
    typed[name] = row.value
  }
  return typed
}

/** What the Config tab saves for the server it was opened on. */
export function configEdit(draft: ConfigDraft, rows: ValueDraft[]): McpServerEdit {
  const values = typedValues(rows)
  const carried = Object.keys(values).length ? { values } : {}
  if (draft.transport === "http") {
    const token = draft.token.trim()
    return {
      transport: "http",
      url: draft.url.trim(),
      auth: draft.auth,
      ...(draft.auth === "header" && token ? { token } : {}),
      ...carried,
    }
  }
  return {
    transport: "stdio",
    command: draft.command.trim(),
    args: splitArgs(draft.args),
    ...carried,
  }
}

/**
 * Whether the form has anything to save: a transport's own field changed, its authentication
 * changed, a token typed, or a value typed over. Arguments are compared as argv, so spacing the line
 * differently is not a change to write.
 */
export function configChanged(
  detail: McpServerDetail,
  draft: ConfigDraft,
  rows: ValueDraft[],
): boolean {
  if (Object.keys(typedValues(rows)).length) return true
  if (draft.transport !== detail.transport) return true
  if (draft.transport === "http") {
    if (draft.url.trim() !== detail.url.trim()) return true
    if (draft.auth !== detail.auth) return true
    return Boolean(draft.token.trim())
  }
  if (draft.command.trim() !== detail.command.trim()) return true
  return splitArgs(draft.args).join("\u0000") !== detail.args.join("\u0000")
}

/**
 * What the custom form adds: a name and one transport, with the values typed for a stdio server.
 * Hermes's own write refuses the rest — a name the bot has, a name a plugin provides, a block its
 * validator won't take — so nothing is decided here beyond what the form can't send.
 */
export function customServer(name: string, draft: ConfigDraft, rows: ValueDraft[]) {
  const values = typedValues(rows)
  const carried = Object.keys(values).length ? { values } : {}
  if (draft.transport === "http") {
    const token = draft.token.trim()
    return {
      name: name.trim(),
      transport: "http" as const,
      url: draft.url.trim(),
      auth: draft.auth,
      ...(draft.auth === "header" && token ? { token } : {}),
    }
  }
  return {
    name: name.trim(),
    transport: "stdio" as const,
    command: draft.command.trim(),
    args: splitArgs(draft.args),
    ...carried,
  }
}

/** Whether a custom server has the two things every one needs: a name and its transport's field. */
export function customReady(name: string, draft: ConfigDraft): boolean {
  if (!name.trim()) return false
  return draft.transport === "http" ? Boolean(draft.url.trim()) : Boolean(draft.command.trim())
}
