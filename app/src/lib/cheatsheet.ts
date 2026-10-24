/** One binding: the keys it takes, one chip each, and what they do in the app's words. */
export interface CheatsheetRow {
  keys: string[]
  description: string
}

/** A group of bindings, named for where they answer. */
export interface CheatsheetGroup {
  name: string
  rows: CheatsheetRow[]
}

/**
 * Every key a hardware keyboard answers in Gots, by hand beside the handlers that take them
 * (ADR 0042). Keys are spelled as the handlers read them, so no Cmd branch is drawn: the stop
 * rejects the meta key and the bot switcher reads Alt alone.
 */
export function cheatsheetGroups(): CheatsheetGroup[] {
  return [
    {
      name: "Composer",
      rows: [
        { keys: ["Enter"], description: "Send the message" },
        { keys: ["Shift+Enter"], description: "Start a new line" },
        { keys: ["Escape", "Escape"], description: "Clear the message, keeping attachments" },
      ],
    },
    {
      name: "Slash menu",
      rows: [
        { keys: ["ArrowUp", "ArrowDown"], description: "Move through the menu" },
        { keys: ["Enter", "Tab"], description: "Pick the highlighted row" },
        { keys: ["Escape"], description: "Close the menu" },
      ],
    },
    {
      name: "Chat",
      rows: [{ keys: ["Ctrl+C"], description: "Stop a running reply" }],
    },
  ]
}
