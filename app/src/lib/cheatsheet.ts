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

/** The switches the sheet is drawn under: the ones that gate or redraw a group or a row. */
export interface CheatsheetSwitches {
  navShortcuts: boolean
  sendOnEnter: boolean
  /** Bot threads on this device: without them there is no thread beside Main for two of the keys. */
  botThreads: boolean
}

/**
 * Every key a hardware keyboard answers in Gots, by hand beside the handlers that take them
 * (ADR 0042). Keys are spelled as the handlers read them — the stop rejects the meta key and the
 * bot switcher reads Alt alone — so no Cmd branch is drawn, and a group whose keys a switch gates
 * is absent while it is off rather than advertising a dead key: the Alt+1…9 group while navigation
 * shortcuts are off, and the two keys of the bot's thread while bot threads are off. A key whose
 * meaning a switch picks is drawn as that switch leaves it: the composer's Enter sends, or starts
 * a new line while the chord sends (ADR 0078). Every switch arrives in one object, so a caller
 * cannot transpose them.
 */
export function cheatsheetGroups({
  navShortcuts,
  sendOnEnter,
  botThreads,
}: CheatsheetSwitches): CheatsheetGroup[] {
  // Shift never sends, so while Enter starts a new line its row would only repeat Enter's, and the
  // chord takes its place.
  const enter: CheatsheetRow[] = sendOnEnter
    ? [
        { keys: ["Enter"], description: "Send the message" },
        { keys: ["Shift+Enter"], description: "Start a new line" },
        { keys: ["Ctrl+Enter"], description: "Send the message" },
      ]
    : [
        { keys: ["Enter"], description: "Start a new line" },
        { keys: ["Ctrl+Enter"], description: "Send the message" },
      ]
  const composer: CheatsheetGroup = {
    name: "Composer",
    rows: [
      ...enter,
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
  // The thread beside Main (ADR 0113): the close cross's twin, and the chord that puts back what a
  // close took away. Both belong to a lane a bot only has with its threads on.
  const threads: CheatsheetGroup = {
    name: "Bot threads",
    rows: [
      { keys: ["Escape"], description: "Close the thread beside Main" },
      { keys: ["Ctrl+\\"], description: "Reopen the thread just closed" },
    ],
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

  return [
    composer,
    slashMenu,
    chat,
    ...(botThreads ? [threads] : []),
    ...(navShortcuts ? [navigation] : []),
    openSurface,
  ]
}
