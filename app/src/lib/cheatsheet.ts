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
 * (ADR 0042). Keys are spelled as the handlers read them — the stop rejects the meta key and the
 * bot switcher reads Alt alone — so no Cmd branch is drawn, and the Alt+1…9 group is absent while
 * its switch is off rather than advertising a dead key.
 */
export function cheatsheetGroups(navShortcuts: boolean): CheatsheetGroup[] {
  const composer: CheatsheetGroup = {
    name: "Composer",
    rows: [
      { keys: ["Enter"], description: "Send the message" },
      { keys: ["Shift+Enter"], description: "Start a new line" },
      { keys: ["Escape", "Escape"], description: "Clear the message, keeping attachments" },
    ],
  }
  const slashMenu: CheatsheetGroup = {
    name: "Slash menu",
    rows: [
      { keys: ["ArrowUp", "ArrowDown"], description: "Move through the menu" },
      { keys: ["Enter", "Tab"], description: "Pick the highlighted row" },
      { keys: ["Escape"], description: "Close the menu" },
    ],
  }
  const chat: CheatsheetGroup = {
    name: "Chat",
    rows: [{ keys: ["Ctrl+C"], description: "Stop the reply and its subagents" }],
  }
  const navigation: CheatsheetGroup = {
    name: "Navigation",
    rows: [{ keys: ["Alt+1…9"], description: "Switch to another bot" }],
  }
  const openSurface: CheatsheetGroup = {
    name: "While something's open",
    rows: [
      { keys: ["ArrowLeft", "ArrowRight"], description: "Step through the attachments" },
      { keys: ["Escape"], description: "Cancel the recording" },
    ],
  }

  return [composer, slashMenu, chat, ...(navShortcuts ? [navigation] : []), openSurface]
}
