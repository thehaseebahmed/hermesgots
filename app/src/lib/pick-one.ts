/**
 * A pick whose list is settled and holds exactly one option applies it, and no sheet is drawn.
 *
 * The decision is taken at the opener, from the list the screen holds at the tap: nothing here
 * reads, waits or watches, so a list that settles after the tap has no path to an apply. The answer
 * is one of three — apply that option, stay quiet because it is already in force, or open the sheet
 * — and each surface decides what the three mean on it.
 */

/** What a surface knows of its list: still reading, the read failed, or the options it holds. */
export type PickRead<T> = { at: "reading" } | { at: "failed" } | { at: "ready"; options: T[] }

/** What a tap on the opener does. */
export type PickStep<T> = { act: "apply"; option: T } | { act: "quiet" } | { act: "open" }

/**
 * One tap decided: a settled list of exactly one option is applied, unless `same` says that option
 * is the value already in force — then the tap changes nothing and draws nothing. Every other state
 * opens the sheet: still reading, a read that failed, a list holding nothing, a list of two. `same`
 * is optional and defaults to nothing being in force, so a surface with no value to compare applies
 * the one option.
 */
export function pickStep<T>(read: PickRead<T>, same?: (option: T) => boolean): PickStep<T> {
  if (read.at !== "ready" || read.options.length !== 1) return { act: "open" }
  const option = read.options[0]
  return same?.(option) ? { act: "quiet" } : { act: "apply", option }
}
