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
  /** The reply's first words arrived, measured from `from` when the send is another request. */
  words: (response: Response, from?: number) => void
}

let watching: Watching | undefined

/** The recorder plugs in here, or nothing at all when the switch is off. */
export function watchRequests(next: Watching | undefined) {
  watching = next
  // Recording stopped, so nothing is still waiting to be timed.
  if (!next) sends.clear()
}

/** A request to a bot's host: watched while the log is on, the plain fetch while it is not. */
export function ask(input: RequestInfo | URL, init?: RequestInit) {
  return watching ? watching.ask(input, init) : fetch(input, init)
}

export function sawFrame(response: Response) {
  watching?.frame(response)
}

export function sawWords(response: Response, from?: number) {
  watching?.words(response, from)
}

/**
 * When a run's send left this device, by the run id it came back with: its answer arrives on a second
 * request, so its first words are timed from the send. Bounded, because a run that never streams
 * would otherwise be kept for the life of the session.
 */
const HELD = 32
const sends = new Map<string, number>()

export function sent(runId: string, at: number) {
  sends.delete(runId)
  sends.set(runId, at)
  if (sends.size > HELD) sends.delete(sends.keys().next().value as string)
}

/** The send's instant, taken once: a stream that reopens does not start the wait again. */
export function sentFrom(runId: string) {
  const at = sends.get(runId)
  sends.delete(runId)
  return at
}
