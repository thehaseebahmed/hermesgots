/**
 * The seam both chat screens' clients ask through, so the network log can watch them without either
 * client importing it: the recorder registers its watcher here when Developer's switch comes on, and
 * with nothing registered this is the fetch the app always made. Import-free, so the unit tests that
 * drive a client in `node --test` still load it.
 */

type Asking = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface Watching {
  ask: Asking
  /** The stream's first frame arrived. */
  frame: (response: Response) => void
  /** The reply's first words arrived. */
  words: (response: Response) => void
}

let watching: Watching | undefined

/** The recorder plugs in here, or nothing at all when the switch is off. */
export function watchRequests(next: Watching | undefined) {
  watching = next
}

/** A request to a bot's host: watched while the log is on, the plain fetch while it is not. */
export function ask(input: RequestInfo | URL, init?: RequestInit) {
  return watching ? watching.ask(input, init) : fetch(input, init)
}

export function sawFrame(response: Response) {
  watching?.frame(response)
}

export function sawWords(response: Response) {
  watching?.words(response)
}
