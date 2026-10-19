// Server access, as a bot's Host offers it — the piece of the MCP screen that is a rule rather than
// a request, kept here so the cases that read oddly (a Host that says nothing about a row, an answer
// with no URL because the stored access still works, an expiry Hermes didn't send) are driven by
// `scripts/test-mcp-access.mjs` instead of by a browser flow. `hermes.ts` is the client that carries
// these values over the wire; `components/mcps-tab.tsx` is what shows them.

/** Whether the Host can start Server access for a row: the wire's own `access` flag, in Gots' words. */
export type McpAccessOffer = "startable" | "none"

/**
 * A Server access flow the Host has started, as the plugin's `mcp/<name>/access` answers it: the URL
 * to open in a browser, and how many seconds the Host waits for its callback. `url` is null when the
 * access already stored for the server still works — there is nothing to open.
 */
export interface McpAccess {
  name: string
  url: string | null
  expires: number
}

/**
 * Whether one server a Host listed offers the action: its own `access` flag, and nothing else. The
 * screen never decides a server needs access from its state word, since only the Host knows whether
 * Hermes can start a flow for it.
 */
export function readMcpAccessOffer(row: { access?: unknown } | null | undefined): McpAccessOffer {
  return row?.access === true ? "startable" : "none"
}

/** Reads the plugin's access answer (`{"object": {"access": {...}}}`). */
export function parseMcpAccess(value: unknown): McpAccess {
  const access = (value as { object?: { access?: unknown } } | null)?.object?.access as
    Record<string, unknown> | undefined
  const name = typeof access?.name === "string" ? access.name : ""
  return {
    name,
    url: typeof access?.url === "string" && access.url ? access.url : null,
    expires: typeof access?.expires === "number" ? access.expires : 0,
  }
}

/**
 * Whether the sheet should offer the action at all: the Host advertises the feature, and this row is
 * one it offers it for. Both halves matter — a host that can start a flow for no server of this bot
 * must not draw a button whose every tap would be refused.
 */
export function offersAccess(advertised: boolean, offer: McpAccessOffer): boolean {
  return advertised && offer === "startable"
}
