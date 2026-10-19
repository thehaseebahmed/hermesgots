import { useCallback, useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import type { Profile } from "@/lib/db"
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import { hasPluginFeature } from "@/lib/hermes"
import { noteFailure } from "@/lib/report"

/** A host the bot's settings talk to. */
type Server = Pick<Profile, "baseUrl" | "apiKey">

/** One route of a bot's plugin: the record it reads back, and the write that replaces it. */
export interface HostRoute<T> {
  /** The route's own name in the plugin's feature list: a plugin older than it has none. */
  feature: string
  /** For a failure note: "the delegation model". */
  what: string
  /** What the host holds, in the app's own terms — a pick, a list, nothing at all. */
  read: (server: Server, signal: AbortSignal) => Promise<T>
  write: (server: Server, value: T, signal: AbortSignal) => Promise<T>
}

/** The host's record, or the fact that its plugin predates the route. */
type Held<T> = { supported: true; held: T } | { supported: false }

/**
 * The host's own record, or nothing for a host whose plugin predates the route. A read that hangs
 * is treated as lost, since a dead connection can hang.
 */
async function readHost<T>(server: Server, route: HostRoute<T>): Promise<Held<T>> {
  if (!(await hasPluginFeature(server, route.feature))) return { supported: false }
  const held = await route.read(server, AbortSignal.timeout(READ_TIMEOUT_MS))
  return { supported: true, held }
}

/**
 * Whether the host ran out of time rather than answering. The one failure that may still have
 * landed: a write the host refused hasn't.
 */
const timedOut = (error: unknown) => error instanceof DOMException && error.name === "TimeoutError"

/**
 * One of a bot's plugin records, read from its host once the plugin says it has the route, and the
 * way its settings write a new one. `value` is what to show: the value a write is putting on the
 * host, until the host's own answer lands, `initial` until it answers at all, and `saving` whether
 * such a write is on its way there. `supported` stays false until the host has answered, so a bot
 * whose plugin predates the route shows nothing.
 */
export function useHostRecord<T>(
  profile: Server | null | undefined,
  route: HostRoute<T>,
  initial: T,
) {
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  const key = connectionKey({ baseUrl, apiKey })
  const [state, setState] = useState<{ key: string; held: Held<T> }>()
  const [pending, setPending] = useState<{ key: string; value: T }>()

  useEffect(() => {
    if (!baseUrl) return
    let cancelled = false
    void readHost({ baseUrl, apiKey }, route)
      .then((held) => {
        if (!cancelled) setState({ key, held })
      })
      .catch((error: unknown) => {
        // A read that fails leaves the field off; the rest of the bot's settings still work.
        noteFailure(`Reading ${route.what}`, error)
      })
    return () => {
      cancelled = true
    }
  }, [key, baseUrl, apiKey, route])

  const held = state?.key === key ? state.held : undefined
  const pendingHere = pending?.key === key ? pending : undefined

  const save = useCallback(
    async (value: T) => {
      setPending({ key, value })
      try {
        const stored = await route.write(
          { baseUrl, apiKey },
          value,
          AbortSignal.timeout(WRITE_TIMEOUT_MS),
        )
        setState({ key, held: { supported: true, held: stored } })
      } catch (error) {
        // A write that ran out of time may still have landed, so read what the host holds now: the
        // field must not sit on a value it may not have, and the control comes back either way.
        if (timedOut(error))
          await readHost({ baseUrl, apiKey }, route)
            .then((now) => setState({ key, held: now }))
            .catch((failed: unknown) => {
              noteFailure(`Reading ${route.what} after a write`, failed)
            })
        throw error
      } finally {
        setPending((now) => (now?.key === key ? undefined : now))
      }
    },
    [key, baseUrl, apiKey, route],
  )

  return {
    value: pendingHere ? pendingHere.value : held?.supported ? held.held : initial,
    /** Shown only once the host has answered: a bot whose plugin predates the route shows nothing. */
    supported: Boolean(held?.supported),
    /** A write is on its way to the host: the field greys out until its answer lands. */
    saving: pendingHere !== undefined,
    save,
  }
}
