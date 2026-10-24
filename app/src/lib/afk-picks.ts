/**
 * The two counts a bot's work is bounded by, in the one place that says what they are: a project's
 * pick count — how many tasks its switch may hold at once — and the pick budget over every project
 * a bot serves (ADR 0042). The AFK pop-up draws the first, the bot editor's Coding tab sets the
 * second, and both are the host's own numbers, so the range and the count a host answers where it
 * holds none are stated once rather than re-typed in each screen.
 *
 * Import-free, so it draws nothing: a component that needs a count imports the number, not the
 * pop-up that shows it.
 */

/**
 * The feature a plugin advertises when a project may hold several tasks at once and a project's
 * Prompt can draw on the account's library of them: its pick count, the list of what it holds, the
 * bot's usage against its pick budget, and the library behind the Prompt row. A plugin from before
 * it holds one task, answers no count and has no library, so nothing of this is drawn there and the
 * pop-up is the one it always was.
 */
export const AFK_PICKS_FEATURE = "afk_picks"

/**
 * The host's own range for a project's pick count, one task at a time at the low end (ADR 0025):
 * the bounds the pills offer across it.
 */
export const PICK_COUNT = { least: 1, most: 5 } as const

/** Every count that range offers, in the order the stepper's pills read them. */
export const PICK_COUNTS = Array.from(
  { length: PICK_COUNT.most - PICK_COUNT.least + 1 },
  (_, index) => PICK_COUNT.least + index,
)

/**
 * The host's own range for a bot's pick budget, and the budget it works within where none was set:
 * a bot has more room than any one project does, since it spans them.
 */
export const PICK_BUDGET = { least: 1, most: 10, unset: 5 } as const
